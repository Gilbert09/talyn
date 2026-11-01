import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PLAN_LIMITS, type PlanTier } from '@talyn/shared';
import type { UsageBudget } from '../services/billing/usage/charge.js';

const { getBudget } = vi.hoisted(() => ({ getBudget: vi.fn() }));
vi.mock('../services/billing/usage/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/billing/usage/index.js')>()),
  getBudget,
}));

import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  environments,
  loopRuns,
  loops,
  repositories,
  tasks,
  usageIntervals,
  usagePeriods,
  users,
  workflowRuns,
  workflows,
  workspaces,
} from '../db/schema.js';
import {
  ConcurrentBoxLimitError,
  SizeRequiresProError,
  UsageExhaustedError,
  type BoxGateError,
} from '../services/billing/entitlements.js';
import {
  BOX_SLOT_RETRY_MS,
  EXHAUSTED_RECHECK_MS,
  boxDeferral,
  boxDeferralEventCode,
  deferralRetryAt,
  initBoxDeferrals,
  noteBoxRefusal,
  ownerBoxHold,
  releaseBoxHold,
  resetBoxDeferralsForTests,
  runBoxGate,
  wakeParkedRuns,
  workspaceBoxHold,
} from '../services/billing/boxDeferral.js';
import { domainEvents } from '../services/events.js';
import { createCloudTask } from '../services/taskCreate.js';
import { clearExhausted } from '../services/billing/usage/periods.js';
import { grantCreditLot } from '../services/billing/usage/credits.js';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const OWNER = 'owner-defer';

function exhausted(periodEnd: Date, tier: PlanTier = 'free'): UsageExhaustedError {
  return new UsageExhaustedError({ tier, periodEnd });
}

function budget(tier: PlanTier, state: 'ok' | 'exhausted'): UsageBudget {
  return {
    tier,
    period: { start: new Date('2026-11-01T00:00:00.000Z'), end: new Date('2026-12-01T00:00:00.000Z') },
    includedWsec: PLAN_LIMITS[tier].includedBoxHours * 3600,
    usedWsec: 0,
    includedLeftWsec: state === 'ok' ? 3600 : 0,
    creditMicros: 0,
    autoTopupPossible: false,
    exhausted: state === 'exhausted',
  };
}

describe('deferralRetryAt (pure)', () => {
  it.each<[string, BoxGateError, number | null]>([
    ['exhausted, reset weeks away → a quarter-hour recheck', exhausted(new Date(NOW + 20 * 86_400_000)), NOW + EXHAUSTED_RECHECK_MS],
    ['exhausted, reset in 5 minutes → the reset', exhausted(new Date(NOW + 5 * 60_000)), NOW + 5 * 60_000],
    ['exhausted, reset already passed → a recheck, never the past', exhausted(new Date(NOW - 60_000)), NOW + EXHAUSTED_RECHECK_MS],
    ['box cap → one sweep interval', new ConcurrentBoxLimitError(2, 2), NOW + BOX_SLOT_RETRY_MS],
    ['size → never on its own', new SizeRequiresProError({ tier: 'free', size: 'large' }), null],
  ])('%s', (_label, err, expected) => {
    expect(deferralRetryAt(err, NOW)?.getTime() ?? null).toBe(expected);
  });

  it.each<[BoxGateError, string, string]>([
    [exhausted(new Date(NOW + 86_400_000)), 'usage_exhausted', 'deferred_usage_exhausted'],
    [new ConcurrentBoxLimitError(2, 2), 'box_limit_reached', 'deferred_box_limit'],
    [new SizeRequiresProError({ tier: 'free', size: 'xlarge' }), 'size_requires_pro', 'deferred_size_requires_pro'],
  ])('%s maps to reason %s and event %s, with the gate sentence', (err, reason, event) => {
    expect(boxDeferral(err, NOW)).toEqual({
      reason,
      message: err.message,
      retryAt: deferralRetryAt(err, NOW)?.toISOString() ?? null,
    });
    expect(boxDeferralEventCode(err)).toBe(event);
  });
});

describe('the owner hold (pure)', () => {
  beforeEach(() => resetBoxDeferralsForTests());

  it('holds until the recheck time, then lets go', () => {
    const err = new ConcurrentBoxLimitError(2, 2);
    noteBoxRefusal(OWNER, err, NOW);
    expect(ownerBoxHold(OWNER, { now: NOW + BOX_SLOT_RETRY_MS - 1 })).toBe(err);
    expect(ownerBoxHold(OWNER, { now: NOW + BOX_SLOT_RETRY_MS })).toBeNull();
    // Expiry forgets it: no later read finds it again.
    expect(ownerBoxHold(OWNER, { now: NOW })).toBeNull();
  });

  it('a size refusal is not held: it does not clear by waiting, and a person may change the size', () => {
    noteBoxRefusal(OWNER, new SizeRequiresProError({ tier: 'free', size: 'large' }), NOW);
    expect(ownerBoxHold(OWNER, { now: NOW })).toBeNull();
  });

  it.each<[string, BoxGateError, boolean]>([
    ['exhausted', exhausted(new Date(NOW + 86_400_000)), false],
    ['box cap', new ConcurrentBoxLimitError(2, 2), true],
  ])('an unmetered (PostHog Code) run is held by %s: %s', (_label, err, held) => {
    noteBoxRefusal(OWNER, err, NOW);
    expect(ownerBoxHold(OWNER, { now: NOW, unmetered: true }) !== null).toBe(held);
    expect(ownerBoxHold(OWNER, { now: NOW })).toBe(err);
  });

  it.each<[string, BoxGateError, boolean]>([
    ['a freed slot ends a box-cap hold', new ConcurrentBoxLimitError(2, 2), true],
    ['a freed slot says nothing about hours', exhausted(new Date(NOW + 86_400_000)), false],
  ])('%s', (_label, err, released) => {
    noteBoxRefusal(OWNER, err, NOW);
    releaseBoxHold(OWNER, { onlyBoxLimit: true });
    expect(ownerBoxHold(OWNER, { now: NOW }) === null).toBe(released);
    releaseBoxHold(OWNER);
    expect(ownerBoxHold(OWNER, { now: NOW })).toBeNull();
  });

  it('holds are per owner', () => {
    noteBoxRefusal(OWNER, new ConcurrentBoxLimitError(2, 2), NOW);
    expect(ownerBoxHold('someone-else', { now: NOW })).toBeNull();
  });
});

describe('with a database', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const savedPolar = process.env.POLAR_ACCESS_TOKEN;

  beforeAll(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: OWNER });
    await seedUser(db, { id: 'owner-other' });
    await db.insert(workspaces).values([
      { id: 'ws', ownerId: OWNER, name: 'mine', settings: {} },
      { id: 'ws-other', ownerId: 'owner-other', name: 'theirs', settings: {} },
    ]);
    await db.insert(repositories).values({
      id: 'repo',
      workspaceId: 'ws',
      name: 'acme/widget',
      url: 'https://github.com/acme/widget',
      settings: { sandboxSize: 'large' },
    });
    await db.insert(environments).values([
      { id: 'env-phc', ownerId: OWNER, name: 'PostHog Code', type: 'posthog_code', config: {} },
      { id: 'env-fleet', ownerId: OWNER, name: 'Talyn Fleet', type: 'selfhosted', config: {} },
    ]);
    initBoxDeferrals();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
    resetBoxDeferralsForTests();
    getBudget.mockReset();
    getBudget.mockResolvedValue(budget('free', 'ok'));
    await db.delete(tasks);
    await db.delete(usageIntervals);
    await db.update(users).set({ planOverride: null }).where(eq(users.id, OWNER));
  });

  afterEach(() => {
    if (savedPolar === undefined) delete process.env.POLAR_ACCESS_TOKEN;
    else process.env.POLAR_ACCESS_TOKEN = savedPolar;
  });

  describe('runBoxGate', () => {
    it('an unattended caller inside a hold gets the refusal without reading the ledger: no spin', async () => {
      getBudget.mockResolvedValue(budget('free', 'exhausted'));
      const fn = vi.fn(async () => 'ran');
      await expect(runBoxGate(OWNER, { size: 'small', unattended: true, workspaceId: 'ws' }, fn)).rejects.toBeInstanceOf(UsageExhaustedError);
      expect(getBudget).toHaveBeenCalledTimes(1);

      // A hundred watcher passes later, still one ledger read.
      for (let i = 0; i < 100; i++) {
        await expect(runBoxGate(OWNER, { size: 'small', unattended: true, workspaceId: 'ws' }, fn)).rejects.toMatchObject({
          code: 'usage_exhausted',
          notice: expect.objectContaining({ workspaceId: 'ws' }),
        });
      }
      expect(getBudget).toHaveBeenCalledTimes(1);
      expect(fn).not.toHaveBeenCalled();
    });

    it('a person always gets a fresh answer, and a pass frees the unattended work behind it', async () => {
      getBudget.mockResolvedValue(budget('free', 'exhausted'));
      await expect(runBoxGate(OWNER, { size: 'small', unattended: true }, async () => 'x')).rejects.toBeInstanceOf(UsageExhaustedError);
      getBudget.mockResolvedValue(budget('free', 'ok'));
      await expect(runBoxGate(OWNER, { size: 'small' }, async () => 'person')).resolves.toBe('person');
      expect(ownerBoxHold(OWNER)).toBeNull();
      await expect(runBoxGate(OWNER, { size: 'small', unattended: true }, async () => 'loop')).resolves.toBe('loop');
    });

    it('a hold names the workspace that asked, not the one that was refused first', async () => {
      noteBoxRefusal(OWNER, new ConcurrentBoxLimitError(2, 2, 'free', 'ws-first'));
      await expect(runBoxGate(OWNER, { size: 'small', unattended: true, workspaceId: 'ws' }, async () => 'x')).rejects.toMatchObject({
        notice: expect.objectContaining({ workspaceId: 'ws', limit: 2 }),
      });
    });

    it('an unmetered unattended run passes an exhausted hold', async () => {
      noteBoxRefusal(OWNER, exhausted(new Date(Date.now() + 86_400_000)));
      await expect(
        runBoxGate(OWNER, { size: 'standard', unattended: true, unmetered: true }, async () => 'posthog code')
      ).resolves.toBe('posthog code');
    });

    it('workspaceBoxHold finds the owner of a workspace', async () => {
      noteBoxRefusal(OWNER, new ConcurrentBoxLimitError(2, 2));
      expect(await workspaceBoxHold('ws')).toBeInstanceOf(ConcurrentBoxLimitError);
      expect(await workspaceBoxHold('ws-other')).toBeNull();
    });
  });

  describe('createCloudTask', () => {
    const base = {
      workspaceId: 'ws',
      type: 'code_writing' as const,
      title: 't',
      description: 'd',
      repositoryId: 'repo',
    };

    it.each([
      ['loop', 'loop'],
      ['merge queue', 'merge_queue'],
      ['auto-keep', 'auto_keep'],
      ['workflow', 'workflow'],
      ['review fix', 'code_review'],
    ] as const)('a %s run on Free is downsized to small, never refused on size', async (_label, source) => {
      // The repository asks for `large`; Free cannot start it.
      await expect(createCloudTask({ ...base, source, assignedEnvironmentId: 'env-fleet' })).resolves.toMatchObject({ status: 'queued' });
    });

    it('a person asking for the same repository is refused on size', async () => {
      await expect(createCloudTask({ ...base, source: 'user', assignedEnvironmentId: 'env-fleet' })).rejects.toBeInstanceOf(SizeRequiresProError);
    });

    it('a review fix a person pressed is attended: it never reads the hold', async () => {
      // Its box is small (a review fix), but a person waits on it, so a held
      // refusal must not answer for them.
      noteBoxRefusal(OWNER, exhausted(new Date(Date.now() + 86_400_000)));
      await expect(
        createCloudTask({ ...base, source: 'code_review', unattended: false, assignedEnvironmentId: 'env-fleet' })
      ).resolves.toMatchObject({ status: 'queued' });
      expect(getBudget).toHaveBeenCalledTimes(1);
      // The same run unattended is answered by the hold.
      noteBoxRefusal(OWNER, exhausted(new Date(Date.now() + 86_400_000)));
      await expect(createCloudTask({ ...base, source: 'code_review', assignedEnvironmentId: 'env-fleet' })).rejects.toBeInstanceOf(
        UsageExhaustedError
      );
    });

    it('an exhausted owner: the first unattended run reads the ledger, the next ones do not', async () => {
      getBudget.mockResolvedValue(budget('free', 'exhausted'));
      for (let i = 0; i < 5; i++) {
        await expect(createCloudTask({ ...base, source: 'loop', assignedEnvironmentId: 'env-fleet' })).rejects.toBeInstanceOf(UsageExhaustedError);
      }
      expect(getBudget).toHaveBeenCalledTimes(1);
      expect(await db.select({ id: tasks.id }).from(tasks)).toHaveLength(0);
    });

    it('a PostHog Code run starts with no hours left', async () => {
      getBudget.mockResolvedValue(budget('free', 'exhausted'));
      await expect(createCloudTask({ ...base, source: 'loop', assignedEnvironmentId: 'env-phc' })).resolves.toMatchObject({ status: 'queued' });
      expect(getBudget).not.toHaveBeenCalled();
    });

    it('billing off: nothing is checked, nothing is held', async () => {
      delete process.env.POLAR_ACCESS_TOKEN;
      getBudget.mockResolvedValue(budget('free', 'exhausted'));
      await expect(createCloudTask({ ...base, source: 'user' })).resolves.toMatchObject({ status: 'queued' });
      expect(getBudget).not.toHaveBeenCalled();
    });
  });

  describe('quota failover keeps one box per run', () => {
    it('a re-queued task whose old box is still open counts once', async () => {
      // The fleet run hit its vendor quota; failover re-queues the SAME task.
      // Until the poller closes the old interval, the task has an open box and
      // is active: the gate must count it once, not twice.
      const { countBoxesInUse } = await import('../services/billing/entitlements.js');
      await db.insert(tasks).values({ id: 'moving', workspaceId: 'ws', type: 'code_writing', status: 'queued', title: 't', description: 'd' });
      await db.insert(usageIntervals).values({
        id: 'iv-old',
        ownerId: OWNER,
        subjectKind: 'task',
        subjectId: 'moving',
        sandboxId: 'talyn-moving',
        size: 'small',
        weight: '0.50',
        startedAt: new Date(),
        billedThrough: new Date(),
      });
      expect(await countBoxesInUse(OWNER)).toBe(1);
      // The old box closes; the queued task is still one box about to boot.
      await db.update(usageIntervals).set({ endedAt: new Date() }).where(eq(usageIntervals.id, 'iv-old'));
      expect(await countBoxesInUse(OWNER)).toBe(1);
    });
  });

  describe('waking parked work', () => {
    const later = () => new Date(Date.now() + 10 * 60_000);

    beforeEach(async () => {
      await db.delete(loopRuns);
      await db.delete(workflowRuns);
      await db.delete(loops);
      await db.delete(workflows);
      await db.insert(loops).values([
        { id: 'loop', workspaceId: 'ws', name: 'l', prompt: 'p', cron: '0 9 * * *', timezone: 'UTC', provider: 'selfhosted', model: 'm', repoFullName: 'acme/widget' },
        { id: 'loop-other', workspaceId: 'ws-other', name: 'l', prompt: 'p', cron: '0 9 * * *', timezone: 'UTC', provider: 'selfhosted', model: 'm', repoFullName: 'acme/widget' },
      ]);
      await db.insert(workflows).values({ id: 'wf', workspaceId: 'ws', name: 'w', events: [], actions: [] });
      let slot = 0;
      const run = (id: string, loopId: string, workspaceId: string, failureCode: string) => ({
        id,
        loopId,
        workspaceId,
        scheduledFor: new Date(Date.parse('2026-11-01T09:00:00.000Z') + ++slot * 86_400_000),
        repoFullName: 'acme/widget',
        provider: 'selfhosted',
        model: 'm',
        status: 'waiting_slot',
        failureCode,
        retryAfter: later(),
      });
      await db.insert(loopRuns).values([
        run('lr-exhausted', 'loop', 'ws', 'usage_exhausted'),
        run('lr-boxcap', 'loop', 'ws', 'box_limit_reached'),
        run('lr-other-owner', 'loop-other', 'ws-other', 'usage_exhausted'),
      ]);
      const wfRun = (id: string, code: string) => ({
        id,
        workflowId: 'wf',
        workspaceId: 'ws',
        repoFullName: 'acme/widget',
        prNumber: 1,
        event: 'pr_opened',
        deliveryId: id,
        status: 'pending_retry',
        actions: [{ type: 'run_prompt', ok: false, code }],
        retryAfter: later(),
      });
      await db.insert(workflowRuns).values([wfRun('wr-exhausted', 'usage_exhausted'), wfRun('wr-rate', 'rate_gated')]);
    });

    async function dueNow(): Promise<string[]> {
      const now = Date.now() + 1_000;
      const l = await db.select({ id: loopRuns.id, at: loopRuns.retryAfter }).from(loopRuns);
      const w = await db.select({ id: workflowRuns.id, at: workflowRuns.retryAfter }).from(workflowRuns);
      return [...l, ...w].filter((r) => r.at && r.at.getTime() <= now).map((r) => r.id).sort();
    }

    it('pulls only this owner\'s runs parked on used-up hours forward', async () => {
      expect(await wakeParkedRuns(OWNER)).toBe(2);
      expect(await dueNow()).toEqual(['lr-exhausted', 'wr-exhausted']);
    });

    it('a budget_restored event ends the hold and wakes the parked runs', async () => {
      noteBoxRefusal(OWNER, exhausted(new Date(Date.now() + 86_400_000)));
      domainEvents.emit('billing:budget_restored', { ownerId: OWNER });
      expect(ownerBoxHold(OWNER)).toBeNull();
      await vi.waitFor(async () => expect(await dueNow()).toEqual(['lr-exhausted', 'wr-exhausted']));
    });

    it('clearing an exhausted period announces the budget', async () => {
      const seen = vi.fn();
      domainEvents.on('billing:budget_restored', seen);
      try {
        await db.delete(usagePeriods);
        await db.insert(usagePeriods).values({
          ownerId: OWNER,
          periodStart: new Date('2026-11-01T00:00:00.000Z'),
          periodEnd: new Date('2026-12-01T00:00:00.000Z'),
          tier: 'free',
          includedWsec: 36_000,
          usedWsec: 36_000,
          exhaustedAt: new Date(),
        });
        expect(await clearExhausted(OWNER)).toBe(true);
        expect(seen).toHaveBeenCalledWith({ ownerId: OWNER });
        // Nothing to clear: nothing announced.
        seen.mockClear();
        expect(await clearExhausted(OWNER)).toBe(false);
        expect(seen).not.toHaveBeenCalled();
      } finally {
        domainEvents.off('billing:budget_restored', seen);
      }
    });

    it('a credit grant announces the budget even when no exhaustion was stamped', async () => {
      const seen = vi.fn();
      domainEvents.on('billing:budget_restored', seen);
      try {
        await db.delete(usagePeriods);
        await grantCreditLot({ ownerId: OWNER, micros: 25_000_000, source: 'grant' });
        expect(seen).toHaveBeenCalledWith({ ownerId: OWNER });
      } finally {
        domainEvents.off('billing:budget_restored', seen);
      }
    });

    it('a finished task frees a box-cap hold, not an exhausted one', async () => {
      noteBoxRefusal(OWNER, new ConcurrentBoxLimitError(2, 2));
      domainEvents.emit('task:status', { workspaceId: 'ws', taskId: 't', status: 'completed' });
      await vi.waitFor(() => expect(ownerBoxHold(OWNER)).toBeNull());

      noteBoxRefusal(OWNER, exhausted(new Date(Date.now() + 86_400_000)));
      domainEvents.emit('task:status', { workspaceId: 'ws', taskId: 't', status: 'completed' });
      await new Promise((r) => setTimeout(r, 50));
      expect(ownerBoxHold(OWNER)).toBeInstanceOf(UsageExhaustedError);
    });

    it('a task that only moved (queued → in_progress) frees nothing', async () => {
      noteBoxRefusal(OWNER, new ConcurrentBoxLimitError(2, 2));
      domainEvents.emit('task:status', { workspaceId: 'ws', taskId: 't', status: 'in_progress' });
      await new Promise((r) => setTimeout(r, 50));
      expect(ownerBoxHold(OWNER)).toBeInstanceOf(ConcurrentBoxLimitError);
    });
  });
});
