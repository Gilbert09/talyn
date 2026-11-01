import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  costMicrosForWeightedSeconds,
  includedWeightedSeconds,
  weightedSeconds,
  type SandboxSize,
} from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  autoTopupSettings,
  creditLots,
  usageIntervals,
  usagePeriods,
  users,
  workbenchChats,
  workbenches,
  workspaces,
} from '../db/schema.js';
import * as websocketModule from '../services/websocket.js';
import * as autoTopupModule from '../services/billing/autoTopup.js';
import { setWorkbenchFleetClientForTests } from '../services/workbenches/sandboxRuntime.js';
import type { FleetClient } from '../services/selfHosted/client.js';
import { chargeOwnerAt, chargeSegments, readBudget } from '../services/billing/usage/charge.js';
import { grantCreditLot } from '../services/billing/usage/credits.js';
import { insertOpenInterval, markIntervalClosed } from '../services/billing/usage/intervals.js';
import { suspendWorkbenchIfExhausted } from '../services/billing/usage/index.js';

const OWNER = 'owner-a';
// Calendar-month periods (a free owner, no anchor).
const NOV = new Date('2026-11-01T00:00:00.000Z');
const DEC = new Date('2026-12-01T00:00:00.000Z');
const T0 = new Date('2026-11-10T12:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const HOUR = 3600;

describe('usage charge step', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let alerts: ReturnType<typeof vi.spyOn>;
  let exhaustedEvents: ReturnType<typeof vi.spyOn>;
  const savedPolar = process.env.POLAR_ACCESS_TOKEN;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    await seedUser(db, { id: OWNER });
    await db.insert(workspaces).values({ id: 'ws', ownerId: OWNER, name: 'W' });
    process.env.POLAR_ACCESS_TOKEN = 'test-token';
    alerts = vi.spyOn(websocketModule, 'emitUsageAlert').mockImplementation(() => {});
    exhaustedEvents = vi.spyOn(websocketModule, 'emitUsageExhausted').mockImplementation(() => {});
    vi.spyOn(websocketModule, 'emitSubscriptionUpdated').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setWorkbenchFleetClientForTests(null);
    if (savedPolar === undefined) delete process.env.POLAR_ACCESS_TOKEN;
    else process.env.POLAR_ACCESS_TOKEN = savedPolar;
    await cleanup();
  });

  const setTier = (planOverride: string | null) => db.update(users).set({ planOverride }).where(eq(users.id, OWNER));
  const open = (sandboxId: string, size: SandboxSize = 'standard', startedAt = T0, kind: 'task' | 'workbench' = 'task', subjectId = `s-${sandboxId}`) =>
    insertOpenInterval({ ownerId: OWNER, workspaceId: 'ws', subjectKind: kind, subjectId, sandboxId, size, startedAt });
  const period = async (start = NOV) =>
    (await db.select().from(usagePeriods).where(eq(usagePeriods.periodStart, start)))[0];
  const lot = (id: string, micros: number, expiresAt = new Date('2027-06-01T00:00:00Z')) =>
    db.insert(creditLots).values({ id, ownerId: OWNER, totalMicros: micros, remainingMicros: micros, source: 'purchase', purchasedAt: T0, expiresAt });

  it.each<[SandboxSize, number]>([
    ['small', 90],
    ['standard', 61],
    ['medium', 3601],
    ['large', 1799],
    ['xlarge', 7],
  ])('bills a %s box for %i s at its weight', async (size, seconds) => {
    await open('box', size);
    await chargeOwnerAt(OWNER, at(seconds));
    expect((await period()).usedWsec).toBe(weightedSeconds(size, seconds));
  });

  it.each([1, 7, 60, 61])('charging every %i s adds up to one charge of the whole interval', async (step) => {
    await open('box', 'medium');
    const total = 1000;
    for (let s = step; s < total; s += step) await chargeOwnerAt(OWNER, at(s));
    await chargeOwnerAt(OWNER, at(total));
    const [row] = await db.select().from(usageIntervals);
    expect((await period()).usedWsec).toBe(weightedSeconds('medium', total));
    expect(Number(row.billedWsec)).toBe(weightedSeconds('medium', total));
  });

  it('two concurrent charges bill each second once', async () => {
    await open('box-1');
    await open('box-2', 'large');
    await Promise.all([chargeOwnerAt(OWNER, at(600)), chargeOwnerAt(OWNER, at(600)), chargeOwnerAt(OWNER, at(600))]);
    expect((await period()).usedWsec).toBe(600 + 1200);
  });

  it('a re-run at the same instant is a no-op', async () => {
    await open('box');
    const first = await chargeOwnerAt(OWNER, at(300));
    const second = await chargeOwnerAt(OWNER, at(300));
    expect(first.chargedIntervals).toBe(1);
    expect(second.chargedIntervals).toBe(0);
    expect((await period()).usedWsec).toBe(300);
  });

  it('bills a closed interval only to its end', async () => {
    await open('box');
    await chargeOwnerAt(OWNER, at(100));
    await markIntervalClosed('box', at(250), 'terminal');
    await chargeOwnerAt(OWNER, at(900));
    expect((await period()).usedWsec).toBe(250);
    await chargeOwnerAt(OWNER, at(1900));
    expect((await period()).usedWsec).toBe(250);
  });

  describe('period rollover', () => {
    it('splits an interval at the period boundary', async () => {
      const start = new Date(DEC.getTime() - 600_000);
      await open('box', 'standard', start);
      await chargeOwnerAt(OWNER, new Date(DEC.getTime() + 900_000));
      expect((await period(NOV)).usedWsec).toBe(600);
      expect((await period(DEC)).usedWsec).toBe(900);
    });

    it('starts the new period with nothing used and no stamps', async () => {
      await setTier('free');
      const start = new Date(DEC.getTime() - 11 * HOUR * 1000);
      await open('box', 'standard', start);
      await chargeOwnerAt(OWNER, new Date(DEC.getTime() - 1000));
      const nov = await period(NOV);
      expect(nov.alert100At).not.toBeNull();
      expect(nov.exhaustedAt).not.toBeNull();
      await markIntervalClosed('box', new Date(DEC.getTime() - 1000), 'terminal');
      await open('box-2', 'standard', DEC);
      await chargeOwnerAt(OWNER, new Date(DEC.getTime() + 60_000));
      const dec = await period(DEC);
      expect(dec.usedWsec).toBe(60);
      expect(dec.alert50At).toBeNull();
      expect(dec.exhaustedAt).toBeNull();
    });

    it.each([
      ['inside one period', '2026-11-10T00:00:00Z', '2026-11-10T01:00:00Z', 1],
      ['across one boundary', '2026-11-30T23:00:00Z', '2026-12-01T01:00:00Z', 2],
      ['across two boundaries', '2026-11-30T23:00:00Z', '2027-01-01T01:00:00Z', 3],
    ])('chargeSegments: %s', (_label, from, to, pieces) => {
      const startedAt = new Date('2026-11-01T00:00:13.400Z');
      const segments = chargeSegments({ size: 'medium', startedAt }, new Date(from), new Date(to), null);
      expect(segments).toHaveLength(pieces);
      const elapsed = (d: string) => (new Date(d).getTime() - startedAt.getTime()) / 1000;
      expect(segments.reduce((s, x) => s + x.wsec, 0)).toBe(weightedSeconds('medium', elapsed(to)) - weightedSeconds('medium', elapsed(from)));
    });
  });

  describe('included hours, then credits', () => {
    it('uses included hours first and burns nothing while they last', async () => {
      await setTier('pro');
      await lot('lot', 10_000_000);
      await open('box');
      await chargeOwnerAt(OWNER, at(HOUR));
      expect(Number((await db.select().from(creditLots))[0].remainingMicros)).toBe(10_000_000);
    });

    it('burns credits for the overage at the size price, soonest expiry first', async () => {
      await setTier('pro');
      const included = includedWeightedSeconds('pro');
      await lot('late', 50_000_000, new Date('2027-08-01T00:00:00Z'));
      await lot('soon', 1_000_000, new Date('2027-01-01T00:00:00Z'));
      await open('box', 'large');
      // A large box (2x) for half the included time plus one hour: two box-hours over.
      await chargeOwnerAt(OWNER, at(included / 2 + HOUR));
      const overageWsec = 2 * HOUR;
      const cost = costMicrosForWeightedSeconds(overageWsec);
      expect(cost).toBe(440_000);
      const lots = Object.fromEntries((await db.select().from(creditLots)).map((r) => [r.id, Number(r.remainingMicros)]));
      expect(lots.soon).toBe(1_000_000 - cost);
      expect(lots.late).toBe(50_000_000);
      const p = await period();
      expect(Number(p.creditMicrosUsed)).toBe(cost);
      expect(Number(p.uncoveredMicros)).toBe(0);
    });

    it('incremental overage burns add up to the total cost', async () => {
      await setTier('legacy_pro');
      const included = includedWeightedSeconds('legacy_pro');
      await lot('lot', 100_000_000);
      await open('box', 'small');
      const end = included * 2 + 4321; // small is 0.5x
      for (let s = included * 2 - 120; s <= end; s += 37) await chargeOwnerAt(OWNER, at(s));
      await chargeOwnerAt(OWNER, at(end));
      const used = weightedSeconds('small', end);
      const cost = costMicrosForWeightedSeconds(used - included);
      expect(Number((await period()).creditMicrosUsed)).toBe(cost);
      expect(Number((await db.select().from(creditLots))[0].remainingMicros)).toBe(100_000_000 - cost);
    });
  });

  describe('thresholds', () => {
    it.each([
      ['below 50%', 0.49, []],
      ['at 50%', 0.5, [50]],
      ['at 85%', 0.85, [50, 80]],
      ['at 100%', 1, [50, 80, 100]],
    ])('%s fires each reached threshold once', async (_label, fraction, expected) => {
      await setTier('free');
      const included = includedWeightedSeconds('free');
      await open('box');
      await chargeOwnerAt(OWNER, at(Math.round(included * fraction)));
      await chargeOwnerAt(OWNER, at(Math.round(included * fraction)));
      expect(alerts.mock.calls.map((c) => (c[1] as { thresholdPct: number }).thresholdPct)).toEqual(expected);
      expect(alerts.mock.calls.every((c) => c[0] === OWNER)).toBe(true);
    });

    it('fires across many small steps exactly once each', async () => {
      await setTier('free');
      const included = includedWeightedSeconds('free');
      await open('box');
      for (let s = 0; s <= included; s += included / 20) await chargeOwnerAt(OWNER, at(s));
      expect(alerts.mock.calls.map((c) => (c[1] as { thresholdPct: number }).thresholdPct)).toEqual([50, 80, 100]);
    });

    it('stays quiet when billing is not configured', async () => {
      delete process.env.POLAR_ACCESS_TOKEN;
      await setTier('free');
      await open('box');
      await chargeOwnerAt(OWNER, at(includedWeightedSeconds('free') + 60));
      expect(alerts).not.toHaveBeenCalled();
      expect(exhaustedEvents).not.toHaveBeenCalled();
      expect((await period()).exhaustedAt).toBeNull();
    });
  });

  describe('exhaustion', () => {
    let suspended: string[];

    beforeEach(async () => {
      suspended = [];
      setWorkbenchFleetClientForTests(async () => ({
        suspendSandbox: async (id: string) => {
          suspended.push(id);
        },
      }) as unknown as FleetClient);
      for (const id of ['wb-idle', 'wb-busy']) {
        await db.insert(workbenches).values({
          id, workspaceId: 'ws', repoFullName: 'acme/app', name: id, branch: 'b', baseBranch: 'main',
          runtime: 'sandbox', agent: 'claude', sandboxId: `talyn-${id}`, sandboxState: 'running', status: 'ready',
        });
        await db.insert(workbenchChats).values({
          id: `chat-${id}`, workbenchId: id, workspaceId: 'ws', title: 't', agent: 'claude',
          status: id === 'wb-busy' ? 'running' : 'idle',
        });
      }
    });

    const runOutFree = async () => {
      await setTier('free');
      await open('talyn-wb-idle', 'standard', T0, 'workbench', 'wb-idle');
      await open('talyn-wb-busy', 'standard', T0, 'workbench', 'wb-busy');
      await open('task-box', 'small', T0, 'task', 'task-1');
    };

    it('suspends idle workbench boxes, leaves a running turn and tasks alone, and announces once', async () => {
      await runOutFree();
      const included = includedWeightedSeconds('free');
      // Three boxes at 1 + 1 + 0.5: the included hours run out at included / 2.5 seconds.
      const result = await chargeOwnerAt(OWNER, at(Math.ceil(included / 2.5) + 10));
      expect(result.exhausted).toBe(true);
      expect(suspended).toEqual(['talyn-wb-idle']);
      const rows = Object.fromEntries((await db.select().from(usageIntervals)).map((r) => [r.sandboxId, r]));
      expect(rows['talyn-wb-idle'].endReason).toBe('exhausted');
      expect(rows['talyn-wb-busy'].endedAt).toBeNull();
      expect(rows['task-box'].endedAt).toBeNull();
      const [wb] = await db.select({ state: workbenches.sandboxState }).from(workbenches).where(eq(workbenches.id, 'wb-idle'));
      expect(wb.state).toBe('suspended');
      expect(exhaustedEvents).toHaveBeenCalledTimes(1);
      expect(exhaustedEvents.mock.calls[0][1]).toMatchObject({ tier: 'free', creditsAllowed: false, periodEnd: DEC.toISOString() });
      expect((await period()).exhaustedAt).not.toBeNull();

      // The turn ends; the next tick suspends that box too, and announces nothing new.
      await db.update(workbenchChats).set({ status: 'idle' }).where(eq(workbenchChats.id, 'chat-wb-busy'));
      await chargeOwnerAt(OWNER, at(Math.ceil(included / 2.5) + 70));
      expect(suspended).toEqual(['talyn-wb-idle', 'talyn-wb-busy']);
      expect(exhaustedEvents).toHaveBeenCalledTimes(1);
    });

    it('suspendWorkbenchIfExhausted acts at the end of a turn', async () => {
      // getBudget reads the clock; pin it inside one calendar month.
      vi.useFakeTimers({ toFake: ['Date'], now: at(includedWeightedSeconds('free') + 600) });
      await setTier('free');
      await open('talyn-wb-idle', 'standard', T0, 'workbench', 'wb-idle');
      expect(await suspendWorkbenchIfExhausted('wb-busy')).toBe(false);
      expect(await suspendWorkbenchIfExhausted('wb-idle')).toBe(true);
      expect(suspended).toEqual(['talyn-wb-idle']);
    });

    it('a failed suspend keeps the interval open for the next tick', async () => {
      setWorkbenchFleetClientForTests(async () => ({
        suspendSandbox: async () => {
          throw new Error('fleet down');
        },
      }) as unknown as FleetClient);
      await runOutFree();
      await chargeOwnerAt(OWNER, at(includedWeightedSeconds('free')));
      const [row] = await db.select().from(usageIntervals).where(eq(usageIntervals.sandboxId, 'talyn-wb-idle'));
      expect(row.endedAt).toBeNull();
    });

    it('credits keep a pro owner going past the included hours', async () => {
      await setTier('pro');
      await lot('lot', 100_000_000);
      await open('talyn-wb-idle', 'standard', T0, 'workbench', 'wb-idle');
      const result = await chargeOwnerAt(OWNER, at(includedWeightedSeconds('pro') + HOUR));
      expect(result.exhausted).toBe(false);
      expect(suspended).toEqual([]);
      expect(exhaustedEvents).not.toHaveBeenCalled();
    });

    it('a pro owner whose credits run out is exhausted, and a purchase clears it', async () => {
      await setTier('pro');
      await lot('lot', 100_000);
      await open('talyn-wb-idle', 'standard', T0, 'workbench', 'wb-idle');
      const result = await chargeOwnerAt(OWNER, at(includedWeightedSeconds('pro') + HOUR));
      expect(result.exhausted).toBe(true);
      const p = await period();
      expect(Number(p.creditMicrosUsed)).toBe(100_000);
      expect(Number(p.uncoveredMicros)).toBe(costMicrosForWeightedSeconds(HOUR) - 100_000);
      expect(exhaustedEvents.mock.calls[0][1]).toMatchObject({ tier: 'pro', creditsAllowed: true });

      await grantCreditLot({ ownerId: OWNER, micros: 25_000_000, source: 'purchase', polarOrderId: 'ord-1' });
      expect((await period()).exhaustedAt).toBeNull();
      expect((await readBudget(OWNER, at(includedWeightedSeconds('pro') + HOUR))).exhausted).toBe(false);
    });

    it('auto top-up covers a shortfall when it grants a lot', async () => {
      await setTier('pro');
      await db.insert(autoTopupSettings).values({ ownerId: OWNER, enabled: true });
      const topUp = vi.spyOn(autoTopupModule, 'tryAutoTopUp').mockImplementation(async (ownerId) => {
        await grantCreditLot({ ownerId, micros: 25_000_000, source: 'auto_topup', polarOrderId: 'auto-1' });
        return true;
      });
      await open('talyn-wb-idle', 'standard', T0, 'workbench', 'wb-idle');
      const result = await chargeOwnerAt(OWNER, at(includedWeightedSeconds('pro') + HOUR));
      expect(topUp).toHaveBeenCalledWith(OWNER, costMicrosForWeightedSeconds(HOUR));
      expect(result.exhausted).toBe(false);
      expect(Number((await period()).uncoveredMicros)).toBe(0);
      expect(Number((await db.select().from(creditLots))[0].remainingMicros)).toBe(25_000_000 - costMicrosForWeightedSeconds(HOUR));
    });

    it('a failed auto top-up leaves the owner exhausted', async () => {
      await setTier('pro');
      await db.insert(autoTopupSettings).values({ ownerId: OWNER, enabled: true });
      vi.spyOn(autoTopupModule, 'tryAutoTopUp').mockResolvedValue(false);
      await open('talyn-wb-idle', 'standard', T0, 'workbench', 'wb-idle');
      const result = await chargeOwnerAt(OWNER, at(includedWeightedSeconds('pro') + HOUR));
      expect(result.exhausted).toBe(true);
      expect(suspended).toEqual(['talyn-wb-idle']);
    });
  });

  describe('budget', () => {
    it.each([
      ['free, nothing used', 'free', 0, 0, null, false],
      ['free, all used', 'free', 1, 0, null, true],
      ['free, all used, with a granted lot', 'free', 1, 5_000_000, null, false],
      ['pro, all used, no credits', 'pro', 1, 0, null, true],
      ['pro, all used, auto top-up on', 'pro', 1, 0, { enabled: true }, false],
      ['pro, all used, auto top-up failed', 'pro', 1, 0, { enabled: true, lastFailure: 'card_declined' }, true],
      ['pro, all used, auto top-up over its monthly limit', 'pro', 1, 0, { enabled: true, monthKey: '2026-11', monthSpentMicros: 90_000_000 }, true],
      ['pro, all used, last month spent', 'pro', 1, 0, { enabled: true, monthKey: '2026-10', monthSpentMicros: 100_000_000 }, false],
      ['free, auto top-up is not a free feature', 'free', 1, 0, { enabled: true }, true],
    ])('%s', async (_label, tier, usedFraction, creditMicros, topup, exhausted) => {
      await setTier(tier);
      const now = at(0);
      if (creditMicros) await lot('lot', creditMicros);
      if (topup) await db.insert(autoTopupSettings).values({ ownerId: OWNER, ...topup });
      const before = await readBudget(OWNER, now);
      await db.update(usagePeriods).set({ usedWsec: Math.round(before.includedWsec * usedFraction) });
      const budget = await readBudget(OWNER, now);
      expect(budget.exhausted).toBe(exhausted);
      expect(budget.creditMicros).toBe(creditMicros);
      expect(budget.period.start.toISOString()).toBe(NOV.toISOString());
    });
  });
});
