import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { burnCreditLots, creditExpiresAt, includedWeightedSeconds, type PlanTier } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { creditLedger, creditLots, teamSeats, teams, usageIntervals, usagePeriods, users } from '../db/schema.js';
import {
  countOpen,
  countOpenBoxesQuery,
  insertOpenInterval,
  markIntervalClosed,
  openIntervalsQuery,
  ownersWithUnbilledQuery,
  unbilledIntervalsQuery,
} from '../services/billing/usage/intervals.js';
import {
  burnCredits,
  creditBalance,
  creditBalanceQuery,
  expireCreditLots,
  grantCreditLot,
  liveLots,
  liveLotsQuery,
  reverseCreditLot,
} from '../services/billing/usage/credits.js';
import { addUsage, clearExhausted, ensurePeriod, readPeriod, readPeriodQuery, stampAlert, stampExhausted } from '../services/billing/usage/periods.js';
import { deriveUsageTier, resolveUsageTier, usageTierQuery } from '../services/billing/usage/tier.js';
import { closeInterval, countOpenBoxes, openInterval } from '../services/billing/usage/index.js';
import { exhaustedText, usageAlertText } from '../services/billing/usage/alerts.js';

const OWNER = 'owner-a';
const T0 = new Date('2026-11-10T12:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe('usage tier (pure)', () => {
  const base = { plan: 'free', planOverride: null, currentPeriodEnd: null, teamPlan: null, teamPlanOverride: null, teamTier: null };
  const end = new Date('2026-11-20T08:00:00Z');
  it.each<[string, Partial<typeof base> & { currentPeriodEnd?: Date | null }, PlanTier, Date | null]>([
    ['no row', {}, 'free', null],
    ['free', {}, 'free', null],
    ['old unlimited subscriber → legacy pro on their own period', { plan: 'unlimited', currentPeriodEnd: end }, 'legacy_pro', end],
    ['unlimited comp → pro', { planOverride: 'unlimited' }, 'pro', null],
    ['pro override', { planOverride: 'pro' }, 'pro', null],
    ['legacy_pro override', { planOverride: 'legacy_pro' }, 'legacy_pro', null],
    ['free override beats a subscription', { plan: 'unlimited', planOverride: 'free', currentPeriodEnd: end }, 'free', null],
    ['free override beats a team seat', { planOverride: 'free', teamPlan: 'team' }, 'free', null],
    ['legacy team seat', { teamPlan: 'team', teamTier: 'legacy_pro' }, 'legacy_pro', null],
    ['pro team seat', { teamPlan: 'team', teamTier: 'pro' }, 'pro', null],
    ['unpaid team seat', { teamPlan: 'none', teamTier: 'pro' }, 'free', null],
    ['team comp', { teamPlan: 'none', teamPlanOverride: 'team', teamTier: 'pro' }, 'pro', null],
    ['garbage override is ignored', { planOverride: 'gold' }, 'free', null],
  ])('%s', (label, overrides, tier, anchor) => {
    const row = label === 'no row' ? undefined : ({ ...base, ...overrides } as Parameters<typeof deriveUsageTier>[0]);
    expect(deriveUsageTier(row)).toEqual({ tier, periodAnchor: anchor });
  });
});

describe('usage alert text', () => {
  const alert = (thresholdPct: 50 | 80 | 100, tier: PlanTier) => ({
    thresholdPct, tier, usedWsec: 3600 * thresholdPct * 2, includedWsec: 3600 * 200, periodEnd: '2026-12-01T00:00:00.000Z',
  });
  it.each<[50 | 80 | 100, PlanTier, RegExp]>([
    [50, 'pro', /^You have used 50% of your included box-hours \(100 of 200 box-hours\)\. They reset on 2026-12-01\.$/],
    [80, 'free', /Upgrade to Pro for 200 box-hours a month\.$/],
    [80, 'legacy_pro', /Upgrade to Pro for 200 box-hours a month, or add credits\.$/],
    [80, 'pro', /Add credits or turn on auto top-up/],
    [100, 'pro', /^You have used all your included box-hours.*New boxes now use your credits\.$/],
  ])('%i%% on %s', (pct, tier, expected) => {
    expect(usageAlertText(alert(pct, tier))).toMatch(expected);
  });

  it.each<[PlanTier, RegExp]>([
    ['free', /Upgrade to Pro to start new boxes now\.$/],
    ['pro', /Add credits to start new boxes now\.$/],
  ])('exhausted on %s', (tier, expected) => {
    expect(exhaustedText({ tier, periodEnd: '2026-12-01T00:00:00.000Z', creditsAllowed: tier !== 'free' })).toMatch(expected);
  });
});

describe('usage ledger', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    await seedUser(db, { id: OWNER });
  });

  afterEach(async () => {
    await cleanup();
  });

  const open = (sandboxId: string, startedAt = T0, size: 'small' | 'standard' | 'large' = 'standard') =>
    insertOpenInterval({ ownerId: OWNER, workspaceId: 'ws', subjectKind: 'task', subjectId: `task-${sandboxId}`, sandboxId, size, startedAt });

  describe('intervals', () => {
    it('opens once per box: a second open while one is open is a no-op', async () => {
      expect(await open('box-1')).toBe(true);
      expect(await open('box-1', at(30))).toBe(false);
      const rows = await db.select().from(usageIntervals);
      expect(rows).toHaveLength(1);
      expect(rows[0].startedAt.toISOString()).toBe(T0.toISOString());
      expect(rows[0].billedThrough.toISOString()).toBe(T0.toISOString());
      expect(rows[0].weight).toBe('1.00');
    });

    it('opens a new interval for a box after its last one closed', async () => {
      await open('box-1');
      await markIntervalClosed('box-1', at(60), 'suspended');
      expect(await open('box-1', at(120))).toBe(true);
      expect(await db.select().from(usageIntervals)).toHaveLength(2);
      expect(await countOpen(OWNER)).toBe(1);
    });

    it('closes only once; a close with nothing open is a no-op', async () => {
      await open('box-1');
      expect(await markIntervalClosed('box-1', at(60), 'terminal')).toEqual({ ownerId: OWNER });
      expect(await markIntervalClosed('box-1', at(90), 'sweep')).toBeNull();
      expect(await markIntervalClosed('never-opened', at(90), 'sweep')).toBeNull();
      const [row] = await db.select().from(usageIntervals);
      expect(row.endedAt?.toISOString()).toBe(at(60).toISOString());
      expect(row.endReason).toBe('terminal');
    });

    it('never ends an interval before what was already billed', async () => {
      await open('box-1');
      await db.update(usageIntervals).set({ billedThrough: at(120) });
      await markIntervalClosed('box-1', at(60), 'suspended');
      const [row] = await db.select().from(usageIntervals);
      expect(row.endedAt?.toISOString()).toBe(at(120).toISOString());
    });

    it('counts open boxes per owner and lists owners with anything left to bill', async () => {
      await seedUser(db, { id: 'owner-b' });
      await open('box-1');
      await open('box-2');
      await insertOpenInterval({ ownerId: 'owner-b', subjectKind: 'workbench', subjectId: 'wb', sandboxId: 'box-3', size: 'small', startedAt: T0 });
      await markIntervalClosed('box-2', at(60), 'terminal');
      expect(await countOpenBoxes(OWNER)).toBe(1);
      // box-2 is closed but not billed to its end yet, so it is still owed.
      expect((await unbilledIntervalsQuery(OWNER)).map((r) => r.sandboxId).sort()).toEqual(['box-1', 'box-2']);
      expect((await ownersWithUnbilledQuery()).map((r) => r.ownerId).sort()).toEqual([OWNER, 'owner-b']);
      await db.update(usageIntervals).set({ billedThrough: at(60) }).where(eq(usageIntervals.sandboxId, 'box-2'));
      expect((await unbilledIntervalsQuery(OWNER)).map((r) => r.sandboxId)).toEqual(['box-1']);
    });

    it('the public open/close never throw and close charges the owner', async () => {
      await openInterval({ ownerId: OWNER, subjectKind: 'task', subjectId: 't', sandboxId: 'box-1', size: 'standard', startedAt: new Date(Date.now() - 3_600_000) });
      await closeInterval('box-1', new Date(), 'terminal');
      await closeInterval('box-1', new Date(), 'terminal');
      const [row] = await db.select().from(usageIntervals);
      expect(row.endedAt).not.toBeNull();
      expect(Number(row.billedWsec)).toBeGreaterThanOrEqual(3599);
      expect(row.billedThrough.getTime()).toBe(row.endedAt!.getTime());
    });
  });

  describe('credits', () => {
    const lot = (id: string, remaining: number, expiresAt: Date) =>
      db.insert(creditLots).values({
        id, ownerId: OWNER, totalMicros: remaining, remainingMicros: remaining, source: 'purchase',
        purchasedAt: new Date(expiresAt.getTime() - 86_400_000), expiresAt,
      });

    it.each([
      ['inside the first lot', 3_000_000],
      ['exactly the first lot', 5_000_000],
      ['across two lots', 7_500_000],
      ['across all live lots', 15_000_000],
      ['more than the balance', 40_000_000],
      ['nothing', 0],
    ])('burns soonest expiry first, skips expired lots (%s)', async (_label, amount) => {
      const now = at(0);
      const fixtures = [
        { id: 'lot-late', remainingMicros: 10_000_000, expiresAt: new Date('2027-06-01T00:00:00Z') },
        { id: 'lot-soon', remainingMicros: 5_000_000, expiresAt: new Date('2027-01-01T00:00:00Z') },
        { id: 'lot-expired', remainingMicros: 9_000_000, expiresAt: new Date('2026-11-01T00:00:00Z') },
      ];
      for (const f of fixtures) await lot(f.id, f.remainingMicros, f.expiresAt);
      const expected = burnCreditLots(
        fixtures.map((f) => ({ ...f, expiresAt: f.expiresAt.toISOString() })),
        amount,
        now,
      );
      const burn = await burnCredits(OWNER, amount, now, { intervalId: 'iv-1', periodStart: T0 });
      expect(burn).toEqual(expected);
      const remaining = Object.fromEntries((await db.select().from(creditLots)).map((r) => [r.id, Number(r.remainingMicros)]));
      expect(remaining['lot-expired']).toBe(9_000_000);
      const ledger = await db.select().from(creditLedger);
      expect(ledger.map((l) => [l.lotId, Number(l.deltaMicros), l.reason])).toEqual(expected.burns.map((b) => [b.lotId, -b.micros, 'burn']));
    });

    it('two concurrent burns never take more than the lots hold', async () => {
      await lot('lot-1', 4_000_000, new Date('2027-01-01T00:00:00Z'));
      await lot('lot-2', 4_000_000, new Date('2027-02-01T00:00:00Z'));
      const [a, b] = await Promise.all([burnCredits(OWNER, 5_000_000, T0), burnCredits(OWNER, 5_000_000, T0)]);
      expect(a.burnedMicros + b.burnedMicros).toBe(8_000_000);
      expect(a.shortMicros + b.shortMicros).toBe(2_000_000);
      expect(await creditBalance(OWNER, T0)).toBe(0);
    });

    it('grants a lot once per order, with a 12-month expiry, and clears exhaustion', async () => {
      const period = { start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z') };
      await ensurePeriod(OWNER, 'pro', period);
      await stampExhausted(OWNER, period.start, T0);
      const first = await grantCreditLot({ ownerId: OWNER, micros: 25_000_000, source: 'purchase', polarOrderId: 'ord-1', purchasedAt: T0 });
      const again = await grantCreditLot({ ownerId: OWNER, micros: 25_000_000, source: 'purchase', polarOrderId: 'ord-1', purchasedAt: T0 });
      expect(first.created).toBe(true);
      expect(again).toEqual({ lotId: first.lotId, created: false });
      const lots = await liveLots(OWNER, T0);
      expect(lots).toHaveLength(1);
      expect(lots[0].expiresAt).toBe(creditExpiresAt(T0).toISOString());
      expect(await creditBalance(OWNER, T0)).toBe(25_000_000);
      expect((await readPeriod(OWNER, period.start))?.exhaustedAt).toBeNull();
      expect((await db.select().from(creditLedger)).map((l) => [Number(l.deltaMicros), l.reason])).toEqual([[25_000_000, 'purchase']]);
    });

    it('grants without an order id are never collapsed', async () => {
      await grantCreditLot({ ownerId: OWNER, micros: 1_000_000, source: 'grant' });
      await grantCreditLot({ ownerId: OWNER, micros: 1_000_000, source: 'grant' });
      expect(await creditBalance(OWNER, new Date())).toBe(2_000_000);
    });

    it('reverses what is left of a refunded order, once', async () => {
      await grantCreditLot({ ownerId: OWNER, micros: 25_000_000, source: 'purchase', polarOrderId: 'ord-1', purchasedAt: T0 });
      await burnCredits(OWNER, 10_000_000, T0);
      expect(await reverseCreditLot('ord-1')).toBe(15_000_000);
      expect(await reverseCreditLot('ord-1')).toBe(0);
      expect(await reverseCreditLot('unknown')).toBe(0);
      expect(await creditBalance(OWNER, T0)).toBe(0);
    });

    it('expires lots past their date with a ledger row, idempotently', async () => {
      await lot('old', 3_000_000, new Date('2026-11-01T00:00:00Z'));
      await lot('live', 2_000_000, new Date('2027-11-01T00:00:00Z'));
      expect(await creditBalance(OWNER, T0)).toBe(2_000_000);
      expect(await expireCreditLots(T0)).toBe(1);
      expect(await expireCreditLots(T0)).toBe(0);
      const ledger = await db.select().from(creditLedger);
      expect(ledger.map((l) => [l.lotId, Number(l.deltaMicros), l.reason])).toEqual([['old', -3_000_000, 'expire']]);
    });
  });

  describe('periods', () => {
    const period = { start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z') };

    it('creates the row lazily and moves the included amount when the tier changes', async () => {
      await ensurePeriod(OWNER, 'free', period);
      await ensurePeriod(OWNER, 'free', period);
      expect((await readPeriod(OWNER, period.start))?.includedWsec).toBe(includedWeightedSeconds('free'));
      await addUsage(OWNER, period.start, 100);
      await ensurePeriod(OWNER, 'pro', period);
      const row = await readPeriod(OWNER, period.start);
      expect(row?.tier).toBe('pro');
      expect(row?.includedWsec).toBe(includedWeightedSeconds('pro'));
      expect(row?.usedWsec).toBe(100);
    });

    it('adds atomically under concurrency', async () => {
      await ensurePeriod(OWNER, 'pro', period);
      await Promise.all(Array.from({ length: 20 }, () => addUsage(OWNER, period.start, 7)));
      expect((await readPeriod(OWNER, period.start))?.usedWsec).toBe(140);
    });

    it.each([50, 80, 100] as const)('stamps the %i%% alert once', async (pct) => {
      await ensurePeriod(OWNER, 'pro', period);
      const results = await Promise.all([stampAlert(OWNER, period.start, pct, T0), stampAlert(OWNER, period.start, pct, T0)]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('stamps exhaustion once and clears it', async () => {
      await ensurePeriod(OWNER, 'pro', period);
      expect(await stampExhausted(OWNER, period.start, T0)).toBe(true);
      expect(await stampExhausted(OWNER, period.start, T0)).toBe(false);
      expect(await clearExhausted(OWNER)).toBe(true);
      expect(await clearExhausted(OWNER)).toBe(false);
    });
  });

  describe('tier', () => {
    it('reads a seat through the GitHub id', async () => {
      await db.update(users).set({ githubUserId: 42 }).where(eq(users.id, OWNER));
      await db.insert(teams).values({ id: 'team-1', name: 'T', plan: 'team', tier: 'pro' });
      await db.insert(teamSeats).values({ id: 'seat-1', teamId: 'team-1', githubUserId: 42, githubLogin: 'a' });
      expect(await resolveUsageTier(OWNER)).toEqual({ tier: 'pro', periodAnchor: null });
    });

    it('existing teams default to legacy pro', async () => {
      await db.insert(teams).values({ id: 'team-2', name: 'T' });
      const [row] = await db.select({ tier: teams.tier }).from(teams).where(eq(teams.id, 'team-2'));
      expect(row.tier).toBe('legacy_pro');
    });
  });

  describe('egress', () => {
    it.each([
      ['openIntervalsQuery', () => openIntervalsQuery()],
      ['unbilledIntervalsQuery', () => unbilledIntervalsQuery(OWNER)],
      ['countOpenBoxesQuery', () => countOpenBoxesQuery(OWNER)],
      ['liveLotsQuery', () => liveLotsQuery(OWNER, T0)],
      ['creditBalanceQuery', () => creditBalanceQuery(OWNER, T0)],
      ['readPeriodQuery', () => readPeriodQuery(OWNER, T0)],
      ['usageTierQuery', () => usageTierQuery(OWNER)],
    ])('%s selects explicit columns only', (_name, build) => {
      const text = build().toSQL().sql;
      expect(text).not.toMatch(/select \*/i);
      for (const heavy of ['transcript', 'last_summary', 'settings', '"config"']) expect(text).not.toContain(heavy);
    });

    it('the usage period table is keyed by owner and period start', async () => {
      await ensurePeriod(OWNER, 'free', { start: T0, end: at(60) });
      await expect(db.insert(usagePeriods).values({ ownerId: OWNER, periodStart: T0, periodEnd: at(60), tier: 'free', includedWsec: 1 })).rejects.toThrow();
    });
  });
});
