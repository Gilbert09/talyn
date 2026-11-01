import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import {
  AUTO_KEEP_DEFAULT_ERROR_CODE,
  AUTO_REVIEW_ERROR_CODE,
  CONCURRENT_BOX_LIMIT_ERROR_CODE,
  PLAN_LIMITS,
  PLAN_TIERS,
  SIZE_REQUIRES_PRO_ERROR_CODE,
  USAGE_EXHAUSTED_ERROR_CODE,
  type PlanTier,
  type SandboxSize,
} from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { tasks, usageIntervals, users, workspaces } from '../db/schema.js';
import type { UsageBudget } from '../services/billing/usage/charge.js';

const { getBudget } = vi.hoisted(() => ({ getBudget: vi.fn() }));
vi.mock('../services/billing/usage/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/billing/usage/index.js')>()),
  getBudget,
}));

import {
  AutoKeepDefaultPlanError,
  AutoReviewPlanError,
  BoxGateError,
  ConcurrentBoxLimitError,
  SizeRequiresProError,
  UsageExhaustedError,
  assertCanActivateTask,
  assertCanEnableAutoKeepDefault,
  assertCanEnableAutoReview,
  budgetAllowsNewBox,
  checkBoxGate,
  countBoxesInUse,
  countOpenBoxesForGateQuery,
  countPendingTaskBoxesQuery,
  decideBoxSize,
  isBoxGateError,
  withBoxGate,
} from '../services/billing/entitlements.js';
import * as entitlements from '../services/billing/entitlements.js';
import { apiErrorHandler } from '../routes/index.js';

const SIZES: SandboxSize[] = ['small', 'standard', 'medium', 'large', 'xlarge'];
const OWNER = 'owner-gate';
const OTHER = 'owner-other';
const PERIOD_END = new Date('2026-12-01T00:00:00.000Z');

type BudgetState = 'included left' | 'credits only' | 'auto top-up possible' | 'exhausted';
const BUDGETS: Record<BudgetState, Pick<UsageBudget, 'includedLeftWsec' | 'creditMicros' | 'autoTopupPossible' | 'exhausted'>> = {
  'included left': { includedLeftWsec: 1800, creditMicros: 0, autoTopupPossible: false, exhausted: false },
  'credits only': { includedLeftWsec: 0, creditMicros: 50_000, autoTopupPossible: false, exhausted: false },
  'auto top-up possible': { includedLeftWsec: 0, creditMicros: 0, autoTopupPossible: true, exhausted: false },
  exhausted: { includedLeftWsec: 0, creditMicros: 0, autoTopupPossible: false, exhausted: true },
};

function budget(tier: PlanTier, state: BudgetState): UsageBudget {
  return {
    tier,
    period: { start: new Date('2026-11-01T00:00:00.000Z'), end: PERIOD_END },
    includedWsec: PLAN_LIMITS[tier].includedBoxHours * 3600,
    usedWsec: 0,
    ...BUDGETS[state],
  };
}

describe('decideBoxSize (pure)', () => {
  const cases = PLAN_TIERS.flatMap((tier) =>
    SIZES.flatMap((size) => [false, true].map((unattended) => ({ tier, size, unattended })))
  );
  it.each(cases)('$tier $size unattended=$unattended', ({ tier, size, unattended }) => {
    const allowed = PLAN_LIMITS[tier].sizes.includes(size);
    const result = decideBoxSize(tier, size, unattended);
    if (allowed) expect(result).toEqual({ size, downgraded: false });
    else if (unattended) expect(result).toEqual({ size: 'small', downgraded: true });
    else expect(result).toBe('refuse');
  });

  it('Free may start small and standard only; paid tiers every size', () => {
    expect(SIZES.filter((s) => decideBoxSize('free', s, false) !== 'refuse')).toEqual(['small', 'standard']);
    expect(SIZES.filter((s) => decideBoxSize('pro', s, false) !== 'refuse')).toEqual(SIZES);
    expect(SIZES.filter((s) => decideBoxSize('legacy_pro', s, false) !== 'refuse')).toEqual(SIZES);
  });
});

describe('budgetAllowsNewBox (pure)', () => {
  it.each<[BudgetState, boolean]>([
    ['included left', true],
    ['credits only', true],
    ['auto top-up possible', true],
    ['exhausted', false],
  ])('%s → %s', (state, allows) => {
    expect(budgetAllowsNewBox(BUDGETS[state])).toBe(allows);
  });
});

describe('the box gate', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const savedPolar = process.env.POLAR_ACCESS_TOKEN;
  let seq = 0;

  beforeAll(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: OWNER });
    await seedUser(db, { id: OTHER });
    await db.insert(workspaces).values([
      { id: 'ws', ownerId: OWNER, name: 'mine', settings: {} },
      { id: 'ws2', ownerId: OWNER, name: 'mine too', settings: {} },
      { id: 'ws-other', ownerId: OTHER, name: 'theirs', settings: {} },
    ]);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
    getBudget.mockReset();
    await db.delete(usageIntervals);
    await db.delete(tasks);
  });

  afterEach(() => {
    if (savedPolar === undefined) delete process.env.POLAR_ACCESS_TOKEN;
    else process.env.POLAR_ACCESS_TOKEN = savedPolar;
  });

  async function setTier(tier: PlanTier) {
    await db.update(users).set({ planOverride: tier }).where(eq(users.id, OWNER));
  }

  async function openBoxes(n: number, owner = OWNER, kind = 'workbench', subjectIds?: string[]) {
    if (n <= 0) return;
    await db.insert(usageIntervals).values(
      Array.from({ length: n }, (_, i) => ({
        id: `iv-${++seq}`,
        ownerId: owner,
        subjectKind: kind,
        subjectId: subjectIds?.[i] ?? `subj-${seq}`,
        sandboxId: `sb-${seq}`,
        size: 'standard',
        weight: '1.00',
        startedAt: new Date(),
        billedThrough: new Date(),
      }))
    );
  }

  async function insertTask(status: string, workspaceId = 'ws'): Promise<string> {
    const id = `task-${++seq}`;
    await db.insert(tasks).values({ id, workspaceId, type: 'code_writing', status, title: 't', description: 'd' });
    return id;
  }

  describe('decision matrix: tier × size × unattended × concurrency × budget × billing', () => {
    const cases = PLAN_TIERS.flatMap((tier) =>
      SIZES.flatMap((size) =>
        [false, true].flatMap((unattended) =>
          (['below cap', 'at cap'] as const).flatMap((concurrency) =>
            (Object.keys(BUDGETS) as BudgetState[]).flatMap((budgetState) =>
              [true, false].map((billing) => ({ tier, size, unattended, concurrency, budgetState, billing }))
            )
          )
        )
      )
    );

    it.each(cases)(
      '$tier $size unattended=$unattended $concurrency budget=$budgetState billing=$billing',
      async ({ tier, size, unattended, concurrency, budgetState, billing }) => {
        if (!billing) delete process.env.POLAR_ACCESS_TOKEN;
        await setTier(tier);
        const cap = PLAN_LIMITS[tier].concurrentBoxes;
        await openBoxes(concurrency === 'at cap' ? cap : cap - 1);
        getBudget.mockResolvedValue(budget(tier, budgetState));
        const fn = vi.fn(async () => 'ran');

        const run = withBoxGate(OWNER, { size, unattended, workspaceId: 'ws' }, fn);

        const allowed = PLAN_LIMITS[tier].sizes.includes(size);
        if (!billing) {
          await expect(run).resolves.toBe('ran');
          expect(fn).toHaveBeenCalledWith({ enforced: false, tier: null, size, downgraded: false });
          expect(getBudget).not.toHaveBeenCalled();
          return;
        }
        if (!allowed && !unattended) {
          await expect(run).rejects.toMatchObject({ code: SIZE_REQUIRES_PRO_ERROR_CODE });
        } else if (budgetState === 'exhausted') {
          await expect(run).rejects.toMatchObject({ code: USAGE_EXHAUSTED_ERROR_CODE });
        } else if (concurrency === 'at cap') {
          await expect(run).rejects.toMatchObject({ code: CONCURRENT_BOX_LIMIT_ERROR_CODE, limit: cap, active: cap });
        } else {
          await expect(run).resolves.toBe('ran');
          expect(fn).toHaveBeenCalledWith({
            enforced: true,
            tier,
            size: allowed ? size : 'small',
            downgraded: !allowed,
          });
          return;
        }
        expect(fn).not.toHaveBeenCalled();
      }
    );
  });

  describe('what counts against the concurrent-box cap', () => {
    beforeEach(async () => {
      await setTier('free');
      getBudget.mockResolvedValue(budget('free', 'included left'));
    });

    it('counts open intervals of every kind, across workspaces', async () => {
      await openBoxes(1, OWNER, 'workbench');
      await openBoxes(1, OWNER, 'review_unit');
      expect(await countBoxesInUse(OWNER)).toBe(2);
      await expect(checkBoxGate(OWNER, { size: 'small' })).rejects.toBeInstanceOf(ConcurrentBoxLimitError);
    });

    it.each(['pending', 'queued', 'in_progress'])('counts a %s task with no box yet', async (status) => {
      await insertTask(status);
      expect(await countBoxesInUse(OWNER)).toBe(1);
    });

    it.each(['completed', 'failed', 'cancelled', 'needs_human'])('ignores a %s task', async (status) => {
      await insertTask(status);
      expect(await countBoxesInUse(OWNER)).toBe(0);
    });

    it('counts a running task once: by its interval, not again as a task', async () => {
      const id = await insertTask('in_progress');
      await openBoxes(1, OWNER, 'task', [id]);
      expect(await countBoxesInUse(OWNER)).toBe(1);
    });

    it('a closed interval frees its slot', async () => {
      await openBoxes(2);
      await db.update(usageIntervals).set({ endedAt: new Date() });
      expect(await countBoxesInUse(OWNER)).toBe(0);
    });

    it('spans the owner workspaces and ignores other owners', async () => {
      await insertTask('queued', 'ws');
      await insertTask('queued', 'ws2');
      await insertTask('queued', 'ws-other');
      await openBoxes(3, OTHER);
      expect(await countBoxesInUse(OWNER)).toBe(2);
    });

    it('excludeTaskId keeps a re-activated task from blocking itself', async () => {
      const a = await insertTask('queued');
      await insertTask('queued');
      await expect(checkBoxGate(OWNER, { size: 'standard' })).rejects.toBeInstanceOf(ConcurrentBoxLimitError);
      await expect(checkBoxGate(OWNER, { size: 'standard', excludeTaskId: a })).resolves.toMatchObject({ enforced: true });
      await expect(assertCanActivateTask(OWNER, a)).resolves.toBeUndefined();
    });

    it('the count queries read explicit columns only', () => {
      for (const q of [countOpenBoxesForGateQuery(OWNER), countPendingTaskBoxesQuery(OWNER, 'x')]) {
        const text = q.toSQL().sql;
        expect(text).not.toMatch(/select \*/i);
        for (const heavy of ['transcript', 'last_summary', 'metadata']) expect(text).not.toContain(heavy);
      }
    });
  });

  describe('replacesBox (resize, move)', () => {
    it('checks the size only: no budget read, no concurrency count', async () => {
      await setTier('free');
      await openBoxes(5);
      await expect(withBoxGate(OWNER, { size: 'standard', replacesBox: true }, async () => 'ok')).resolves.toBe('ok');
      expect(getBudget).not.toHaveBeenCalled();
      await expect(checkBoxGate(OWNER, { size: 'large', replacesBox: true })).rejects.toBeInstanceOf(SizeRequiresProError);
    });
  });

  describe('refusal notices', () => {
    it('usage_exhausted on Free names the reset and pitches Pro', async () => {
      await setTier('free');
      getBudget.mockResolvedValue(budget('free', 'exhausted'));
      const err = await checkBoxGate(OWNER, { size: 'small', workspaceId: 'ws' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UsageExhaustedError);
      expect((err as UsageExhaustedError).notice).toEqual({
        code: USAGE_EXHAUSTED_ERROR_CODE,
        message: expect.stringMatching(/10 box-hours.*2026-12-01.*Upgrade to Pro for 200 box-hours/),
        tier: 'free',
        workspaceId: 'ws',
        periodEnd: PERIOD_END.toISOString(),
        creditsAllowed: false,
        retryAt: PERIOD_END.toISOString(),
      });
    });

    it.each<PlanTier>(['pro', 'legacy_pro'])('usage_exhausted on %s points at credits', async (tier) => {
      await setTier(tier);
      getBudget.mockResolvedValue(budget(tier, 'exhausted'));
      const err = (await checkBoxGate(OWNER, { size: 'small' }).catch((e: unknown) => e)) as UsageExhaustedError;
      expect(err.notice.creditsAllowed).toBe(true);
      expect(err.message).toMatch(/Add credits or turn on auto top-up/);
    });

    it('size_requires_pro lists the sizes the tier may start', async () => {
      await setTier('free');
      const err = (await checkBoxGate(OWNER, { size: 'xlarge' }).catch((e: unknown) => e)) as SizeRequiresProError;
      expect(err.notice).toMatchObject({ code: SIZE_REQUIRES_PRO_ERROR_CODE, size: 'xlarge', allowedSizes: ['small', 'standard'], tier: 'free' });
      expect(err.message).toBe('X-Large boxes need the Pro plan. The Free plan can start Small and Standard boxes.');
      expect(err.notice.retryAt).toBeUndefined();
    });

    it('concurrent_box_limit_reached carries the cap and the boxes in use', async () => {
      await setTier('free');
      getBudget.mockResolvedValue(budget('free', 'included left'));
      await openBoxes(3);
      const err = (await checkBoxGate(OWNER, { size: 'small' }).catch((e: unknown) => e)) as ConcurrentBoxLimitError;
      expect(err.notice).toMatchObject({ code: CONCURRENT_BOX_LIMIT_ERROR_CODE, limit: 2, active: 3, tier: 'free' });
      expect(err.message).toMatch(/runs 2 boxes at the same time \(3 in use\).*Upgrade to Pro to run 100/);
      expect(err.notice.retryAt).toBeUndefined();
    });

    it('a paid tier at its cap is not pitched Pro', () => {
      expect(new ConcurrentBoxLimitError(100, 100, 'pro').message).not.toMatch(/Upgrade/);
    });

    it.each([
      ['usage', new UsageExhaustedError({ tier: 'free', periodEnd: PERIOD_END })],
      ['size', new SizeRequiresProError({ tier: 'free', size: 'large' })],
      ['concurrency', new ConcurrentBoxLimitError(2, 2)],
    ])('%s refusal is a BoxGateError', (_label, err) => {
      expect(err).toBeInstanceOf(BoxGateError);
      expect(isBoxGateError(err)).toBe(true);
      expect(err.message).toBe(err.notice.message);
      expect(err.code).toBe(err.notice.code);
    });

    it('isBoxGateError is false for anything else', () => {
      expect(isBoxGateError(new Error('x'))).toBe(false);
      expect(isBoxGateError(new AutoKeepDefaultPlanError())).toBe(false);
      expect(isBoxGateError(null)).toBe(false);
    });
  });

  describe('existingBox (a turn or a wake on a session box)', () => {
    type Case = { existingBox: 'awake' | 'asleep'; budgetState: BudgetState; atCap: boolean; size: SandboxSize };
    const cases: Case[] = (['awake', 'asleep'] as const).flatMap((existingBox) =>
      (['included left', 'exhausted'] as BudgetState[]).flatMap((budgetState) =>
        [false, true].flatMap((atCap) => (['standard', 'large'] as SandboxSize[]).map((size) => ({ existingBox, budgetState, atCap, size })))
      )
    );
    it.each(cases)('Free $existingBox $size budget=$budgetState atCap=$atCap', async ({ existingBox, budgetState, atCap, size }) => {
      await setTier('free');
      getBudget.mockResolvedValue(budget('free', budgetState));
      await openBoxes(atCap ? 2 : 1);
      const run = checkBoxGate(OWNER, { size, existingBox });
      // The size is never checked again: the box exists. Budget always is;
      // the cap only when waking a sleeping box adds one.
      if (budgetState === 'exhausted') await expect(run).rejects.toBeInstanceOf(UsageExhaustedError);
      else if (atCap && existingBox === 'asleep') await expect(run).rejects.toBeInstanceOf(ConcurrentBoxLimitError);
      else await expect(run).resolves.toMatchObject({ enforced: true, size, downgraded: false });
    });
  });

  describe('unmetered (a PostHog Code task)', () => {
    it.each<[BudgetState, boolean, 'ok' | 'cap']>([
      ['exhausted', false, 'ok'],
      ['included left', false, 'ok'],
      ['exhausted', true, 'cap'],
    ])('budget=%s atCap=%s → %s, at any size', async (budgetState, atCap, expected) => {
      await setTier('free');
      getBudget.mockResolvedValue(budget('free', budgetState));
      await openBoxes(atCap ? 2 : 0);
      const run = checkBoxGate(OWNER, { size: 'xlarge', unmetered: true });
      if (expected === 'cap') await expect(run).rejects.toBeInstanceOf(ConcurrentBoxLimitError);
      else await expect(run).resolves.toMatchObject({ enforced: true, size: 'xlarge' });
      // No box-hours: the ledger is never read.
      expect(getBudget).not.toHaveBeenCalled();
    });
  });

  describe('assertCanActivateTask options', () => {
    it('checks the size it is given, attended', async () => {
      await setTier('free');
      getBudget.mockResolvedValue(budget('free', 'included left'));
      const id = await insertTask('failed');
      await expect(assertCanActivateTask(OWNER, id, { size: 'large' })).rejects.toBeInstanceOf(SizeRequiresProError);
      await expect(assertCanActivateTask(OWNER, id, { size: 'small' })).resolves.toBeUndefined();
    });

    it('an unmetered task re-activates with no hours left', async () => {
      await setTier('pro');
      getBudget.mockResolvedValue(budget('pro', 'exhausted'));
      const id = await insertTask('failed');
      await expect(assertCanActivateTask(OWNER, id)).rejects.toBeInstanceOf(UsageExhaustedError);
      await expect(assertCanActivateTask(OWNER, id, { size: 'standard', unmetered: true })).resolves.toBeUndefined();
    });
  });

  it('the removed count caps have no gate left to call', () => {
    for (const name of ['withTaskLimitGate', 'withReviewCycleGate', 'withMergeQueueLimitGate', 'withWorkflowLimitGate', 'withLoopLimitGate', 'TaskLimitError']) {
      expect(name in entitlements).toBe(false);
    }
  });

  describe('feature gates (auto-keep default, auto-review)', () => {
    const cases = PLAN_TIERS.flatMap((tier) => [true, false].map((billing) => ({ tier, billing })));
    it.each(cases)('$tier billing=$billing', async ({ tier, billing }) => {
      if (!billing) delete process.env.POLAR_ACCESS_TOKEN;
      await setTier(tier);
      const allowed = !billing || tier !== 'free';
      if (allowed) {
        await expect(assertCanEnableAutoKeepDefault(OWNER)).resolves.toBeUndefined();
        await expect(assertCanEnableAutoReview(OWNER)).resolves.toBeUndefined();
      } else {
        await expect(assertCanEnableAutoKeepDefault(OWNER)).rejects.toBeInstanceOf(AutoKeepDefaultPlanError);
        await expect(assertCanEnableAutoReview(OWNER)).rejects.toBeInstanceOf(AutoReviewPlanError);
      }
    });

    it('an old Unlimited comp keeps the auto features (it is Pro now)', async () => {
      await db.update(users).set({ planOverride: 'unlimited' }).where(eq(users.id, OWNER));
      await expect(assertCanEnableAutoKeepDefault(OWNER)).resolves.toBeUndefined();
    });
  });
});

describe('402 mapping (apiErrorHandler)', () => {
  function fakeRes() {
    const res = {
      headersSent: false,
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(body: unknown) {
        res.body = body;
        return res;
      },
    };
    return res;
  }

  function handle(err: Error) {
    const res = fakeRes();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiErrorHandler(err, {} as Request, res as unknown as Response, vi.fn() as NextFunction);
    const logged = errorSpy.mock.calls.length > 0;
    errorSpy.mockRestore();
    return { res, logged };
  }

  it.each([
    ['usage exhausted', new UsageExhaustedError({ tier: 'free', periodEnd: PERIOD_END }), USAGE_EXHAUSTED_ERROR_CODE],
    ['size requires Pro', new SizeRequiresProError({ tier: 'free', size: 'large' }), SIZE_REQUIRES_PRO_ERROR_CODE],
    ['concurrent box limit', new ConcurrentBoxLimitError(2, 2), CONCURRENT_BOX_LIMIT_ERROR_CODE],
  ])('%s → 402 with its code and notice, no console noise', (_label, err, code) => {
    const { res, logged } = handle(err);
    expect(res.statusCode).toBe(402);
    expect(res.body).toEqual({ success: false, error: err.message, code, notice: err.notice });
    expect(logged).toBe(false);
  });

  it.each([
    ['auto-keep default', new AutoKeepDefaultPlanError(), AUTO_KEEP_DEFAULT_ERROR_CODE],
    ['auto-review', new AutoReviewPlanError(), AUTO_REVIEW_ERROR_CODE],
  ])('%s feature gate → 402 with its code', (_label, err, code) => {
    const { res, logged } = handle(err);
    expect(res.statusCode).toBe(402);
    expect(res.body).toEqual({ success: false, error: err.message, code });
    expect(logged).toBe(false);
  });

  it('anything else → 500, logged', () => {
    const { res, logged } = handle(new Error('boom'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'boom' });
    expect(logged).toBe(true);
  });

  it('does nothing once headers are sent', () => {
    const res = { ...fakeRes(), headersSent: true };
    const next = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiErrorHandler(new ConcurrentBoxLimitError(2, 2), {} as Request, res as unknown as Response, next);
    errorSpy.mockRestore();
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
  });
});
