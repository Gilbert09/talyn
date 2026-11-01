import { describe, expect, it } from 'vitest';
import {
  addMonthsUtc,
  AUTO_TOPUP_DEFAULTS,
  autoTopupMonthKey,
  BOX_HOUR_PRICE_MICROS,
  boxHoursToWeightedSeconds,
  burnCreditLots,
  centsToMicros,
  consumeBudget,
  costMicrosForWeightedSeconds,
  CREDIT_PACK_IDS,
  CREDIT_PACKS,
  creditBalanceMicros,
  creditExpiresAt,
  creditPackBonusMicros,
  crossedUsageThresholds,
  expiringSoonMicros,
  formatBoxHours,
  formatBoxHoursLabel,
  formatBoxHoursUsage,
  formatCreditPack,
  formatPricePerHour,
  formatSizePrice,
  formatUsd,
  includedWeightedSeconds,
  isCreditLotLive,
  isCreditPackId,
  isPlanOverride,
  isPlanTier,
  microsToCents,
  PLAN_LIMITS,
  PLAN_PRICES,
  PLAN_TIERS,
  planTierFromOverride,
  runningCostMicros,
  SANDBOX_SIZES,
  sandboxSizeForResources,
  shouldAutoTopUp,
  SIZE_PRICE_MICROS_PER_HOUR,
  SIZE_WEIGHT,
  sizeAllowedOnTier,
  sizePriceTable,
  teamSeatTier,
  usagePercent,
  usagePeriodFor,
  validateAutoTopupConfig,
  weightedSeconds,
  weightedSecondsDelta,
  weightedSecondsToBoxHours,
  type AutoTopupConfig,
  type CreditPackId,
  type PlanTier,
  type SandboxSize,
} from '@talyn/shared';

const SIZES: SandboxSize[] = ['small', 'standard', 'medium', 'large', 'xlarge'];
const HOUR = 3600;
const d = (iso: string) => new Date(iso);

describe('plan tiers', () => {
  it.each<[PlanTier, number, number, SandboxSize[], boolean, boolean]>([
    ['free', 10, 2, ['small', 'standard'], false, false],
    ['pro', 200, 100, SIZES, true, true],
    ['legacy_pro', 50, 100, SIZES, true, true],
  ])('%s limits', (tier, hours, concurrent, sizes, credits, auto) => {
    expect(PLAN_LIMITS[tier]).toEqual({
      includedBoxHours: hours,
      concurrentBoxes: concurrent,
      sizes,
      creditsAllowed: credits,
      autoFeatures: auto,
    });
    expect(includedWeightedSeconds(tier)).toBe(hours * HOUR);
  });

  it.each<[PlanTier, number, number | null]>([
    ['free', 0, null],
    ['pro', 40_000_000, 400_000_000],
    ['legacy_pro', 15_000_000, 150_000_000],
  ])('%s price', (tier, monthly, annual) => {
    expect(PLAN_PRICES[tier]).toEqual({ monthlyMicros: monthly, annualMicros: annual });
  });

  it('lists every tier once', () => {
    expect([...PLAN_TIERS]).toEqual(['free', 'pro', 'legacy_pro']);
  });

  it.each<[unknown, boolean]>([
    ['free', true], ['pro', true], ['legacy_pro', true],
    ['unlimited', false], ['Pro', false], ['', false], [null, false], [undefined, false], [1, false],
  ])('isPlanTier(%j) = %s', (value, expected) => {
    expect(isPlanTier(value)).toBe(expected);
  });

  it.each<[string | null | undefined, PlanTier | null]>([
    ['free', 'free'],
    ['unlimited', 'pro'],
    ['pro', 'pro'],
    ['legacy_pro', 'legacy_pro'],
    ['team', null],
    ['', null],
    [null, null],
    [undefined, null],
  ])('planTierFromOverride(%j) = %s', (override, expected) => {
    expect(planTierFromOverride(override)).toBe(expected);
  });

  it.each<[unknown, boolean]>([
    ['free', true], ['unlimited', true], ['pro', true], ['legacy_pro', true], ['team', false], [null, false],
  ])('isPlanOverride(%j) = %s', (value, expected) => {
    expect(isPlanOverride(value)).toBe(expected);
  });

  it.each<[string | null | undefined, PlanTier]>([
    ['pro', 'pro'],
    ['legacy_pro', 'legacy_pro'],
    [null, 'legacy_pro'],
    [undefined, 'legacy_pro'],
    ['free', 'legacy_pro'],
    ['garbage', 'legacy_pro'],
  ])('teamSeatTier(%j) = %s', (teamTier, expected) => {
    expect(teamSeatTier(teamTier)).toBe(expected);
  });
});

describe('sizes', () => {
  it.each<[SandboxSize, number, number, string]>([
    ['small', 0.5, 110_000, '$0.11/h'],
    ['standard', 1, 220_000, '$0.22/h'],
    ['medium', 1.25, 275_000, '$0.275/h'],
    ['large', 2, 440_000, '$0.44/h'],
    ['xlarge', 2.5, 550_000, '$0.55/h'],
  ])('%s weight %s costs %s micros/h (%s)', (size, weight, micros, text) => {
    expect(SIZE_WEIGHT[size]).toBe(weight);
    expect(SIZE_PRICE_MICROS_PER_HOUR[size]).toBe(micros);
    expect(Number.isInteger(SIZE_PRICE_MICROS_PER_HOUR[size])).toBe(true);
    expect(SIZE_PRICE_MICROS_PER_HOUR[size]).toBe(Math.round(weight * BOX_HOUR_PRICE_MICROS));
    expect(formatSizePrice(size)).toBe(text);
    expect(runningCostMicros(size, HOUR)).toBe(micros);
  });

  it.each(PLAN_TIERS.flatMap((tier) => SIZES.map((size) => [tier, size] as const)))(
    '%s may start %s per its limits',
    (tier, size) => {
      const expected = tier !== 'free' || size === 'small' || size === 'standard';
      expect(sizeAllowedOnTier(tier, size)).toBe(expected);
      expect(sizePriceTable(tier).find((row) => row.size === size)?.allowed).toBe(expected);
    },
  );

  it('sizePriceTable keeps size order and prices', () => {
    expect(sizePriceTable('pro').map((r) => [r.size, r.weight, r.priceMicrosPerHour])).toEqual(
      SIZES.map((s) => [s, SIZE_WEIGHT[s], SIZE_PRICE_MICROS_PER_HOUR[s]]),
    );
  });

  it('small is 2 vCPU / 4 GiB; others keep their resources', () => {
    expect(SANDBOX_SIZES.small).toMatchObject({ memMib: 4096, milliVcpu: 2000 });
    expect(SANDBOX_SIZES.standard).toMatchObject({ memMib: 4096, milliVcpu: 4000 });
    expect(SANDBOX_SIZES.medium).toMatchObject({ memMib: 8192, milliVcpu: 4000 });
    expect(SANDBOX_SIZES.large).toMatchObject({ memMib: 12288, milliVcpu: 6000 });
    expect(SANDBOX_SIZES.xlarge).toMatchObject({ memMib: 16384, milliVcpu: 8000 });
  });

  it.each<[number | null | undefined, number | null | undefined, SandboxSize | null]>([
    [4096, 2000, 'small'],
    [4096, 4000, 'standard'],
    [4096, undefined, 'standard'],
    [4096, null, 'standard'],
    [8192, 4000, 'medium'],
    [8192, undefined, 'medium'],
    [12288, 6000, 'large'],
    [16384, 8000, 'xlarge'],
    [8192, 2000, null],
    [2048, 2000, null],
    [0, 2000, null],
    [undefined, undefined, null],
    [null, null, null],
  ])('sandboxSizeForResources(%s, %s) = %s', (mem, cpu, expected) => {
    expect(sandboxSizeForResources(mem, cpu)).toBe(expected);
  });
});

describe('usage math', () => {
  it.each<[SandboxSize, number, number]>([
    ['small', 0, 0],
    ['small', 1, 1], // 0.5 rounds half up
    ['small', 3, 2], // 1.5 → 2
    ['small', HOUR, 1800],
    ['standard', 1, 1],
    ['standard', HOUR, HOUR],
    ['standard', 0.4, 0],
    ['standard', 59.6, 60],
    ['medium', 4, 5],
    ['medium', HOUR, 4500],
    ['large', 30 * 60, HOUR],
    ['xlarge', HOUR, 9000],
    ['xlarge', 1, 3], // 2.5 → 3
    ['standard', -10, 0],
    ['standard', Number.NaN, 0],
    ['standard', Number.POSITIVE_INFINITY, 0],
  ])('weightedSeconds(%s, %s) = %s', (size, seconds, expected) => {
    expect(weightedSeconds(size, seconds)).toBe(expected);
  });

  it.each(SIZES)('per-step deltas of %s add up to the total, whatever the step', (size) => {
    for (const step of [1, 7, 13.37, 60]) {
      let sum = 0;
      let prev = 0;
      const total = 3 * HOUR + 17.5;
      while (prev < total) {
        const next = Math.min(total, prev + step);
        sum += weightedSecondsDelta(size, prev, next);
        prev = next;
      }
      expect(sum).toBe(weightedSeconds(size, total));
    }
  });

  it('a backward delta is zero', () => {
    expect(weightedSecondsDelta('standard', 100, 50)).toBe(0);
  });

  it.each<[number, number]>([
    [0, 0], [1, HOUR], [0.5, 1800], [10, 36_000], [200, 720_000], [-1, 0], [Number.NaN, 0],
  ])('boxHoursToWeightedSeconds(%s) = %s', (hours, wsec) => {
    expect(boxHoursToWeightedSeconds(hours)).toBe(wsec);
  });

  it.each<[number, number]>([
    [0, 0], [HOUR, 1], [1800, 0.5], [135_000, 37.5], [-5, 0], [Number.NaN, 0],
  ])('weightedSecondsToBoxHours(%s) = %s', (wsec, hours) => {
    expect(weightedSecondsToBoxHours(wsec)).toBe(hours);
  });

  it.each<[number, number]>([
    [0, 0],
    [HOUR, 220_000],
    [1, 61], // 61.11 → 61
    [9, 550],
    [1800, 110_000],
    [-1, 0],
  ])('costMicrosForWeightedSeconds(%s) = %s', (wsec, micros) => {
    expect(costMicrosForWeightedSeconds(wsec)).toBe(micros);
  });

  it.each(SIZES)('runningCostMicros(%s, 0) is zero', (size) => {
    expect(runningCostMicros(size, 0)).toBe(0);
  });

  it.each<[string, { includedWsec: number; usedBeforeWsec: number; deltaWsec: number }, number, number, number]>([
    ['all included', { includedWsec: 36_000, usedBeforeWsec: 0, deltaWsec: 3600 }, 3600, 0, 0],
    ['crosses the line', { includedWsec: 36_000, usedBeforeWsec: 34_200, deltaWsec: 3600 }, 1800, 1800, 110_000],
    ['all overage', { includedWsec: 36_000, usedBeforeWsec: 40_000, deltaWsec: 3600 }, 0, 3600, 220_000],
    ['exactly to the line', { includedWsec: 3600, usedBeforeWsec: 0, deltaWsec: 3600 }, 3600, 0, 0],
    ['nothing included', { includedWsec: 0, usedBeforeWsec: 0, deltaWsec: 3600 }, 0, 3600, 220_000],
    ['zero delta', { includedWsec: 3600, usedBeforeWsec: 5000, deltaWsec: 0 }, 0, 0, 0],
    ['negative delta', { includedWsec: 3600, usedBeforeWsec: 0, deltaWsec: -10 }, 0, 0, 0],
  ])('consumeBudget: %s', (_name, input, fromIncluded, overage, micros) => {
    expect(consumeBudget(input)).toEqual({ fromIncludedWsec: fromIncluded, overageWsec: overage, overageMicros: micros });
  });

  it('consumeBudget overage micros telescope to the total cost', () => {
    let used = 0;
    let micros = 0;
    for (let i = 0; i < 1000; i++) {
      const step = consumeBudget({ includedWsec: 100, usedBeforeWsec: used, deltaWsec: 7 });
      micros += step.overageMicros;
      used += 7;
    }
    expect(micros).toBe(costMicrosForWeightedSeconds(used - 100));
  });

  it.each<[number, number, number]>([
    [0, 36_000, 0],
    [18_000, 36_000, 50],
    [28_799, 36_000, 79],
    [36_000, 36_000, 100],
    [99_999, 36_000, 100],
    [5, 0, 100],
    [0, 0, 0],
    [-5, 100, 0],
  ])('usagePercent(%s, %s) = %s', (used, included, pct) => {
    expect(usagePercent(used, included)).toBe(pct);
  });
});

describe('usage periods', () => {
  it.each<[string, string, string, string]>([
    ['Jan 31 + 1', '2026-01-31T10:00:00.000Z', '2026-02-28T10:00:00.000Z', '1'],
    ['leap Feb', '2028-01-31T00:00:00.000Z', '2028-02-29T00:00:00.000Z', '1'],
    ['year roll', '2026-12-15T00:00:00.000Z', '2027-01-15T00:00:00.000Z', '1'],
    ['back a month', '2026-03-31T00:00:00.000Z', '2026-02-28T00:00:00.000Z', '-1'],
    ['back across a year', '2026-01-10T00:00:00.000Z', '2025-12-10T00:00:00.000Z', '-1'],
    ['twelve months', '2026-05-05T05:05:05.005Z', '2027-05-05T05:05:05.005Z', '12'],
    ['zero', '2026-05-05T00:00:00.000Z', '2026-05-05T00:00:00.000Z', '0'],
  ])('addMonthsUtc: %s', (_name, from, to, n) => {
    expect(addMonthsUtc(d(from), Number(n)).toISOString()).toBe(to);
  });

  it.each<[string, string | null, string, string]>([
    ['free, mid-month', null, '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'],
    ['free, December', null, '2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
  ])('usagePeriodFor %s', (_name, anchor, start, end) => {
    const now = _name.includes('December') ? d('2026-12-31T23:59:59.999Z') : d('2026-11-15T12:00:00.000Z');
    const p = usagePeriodFor({ now, anchor: anchor ? d(anchor) : null });
    expect([p.start.toISOString(), p.end.toISOString()]).toEqual([start, end]);
  });

  it.each<[string, string, string, string]>([
    // [now, anchor, start, end]
    ['2026-11-15T00:00:00.000Z', '2026-11-20T09:00:00.000Z', '2026-10-20T09:00:00.000Z', '2026-11-20T09:00:00.000Z'],
    ['2026-11-20T09:00:00.000Z', '2026-11-20T09:00:00.000Z', '2026-11-20T09:00:00.000Z', '2026-12-20T09:00:00.000Z'],
    ['2026-12-01T00:00:00.000Z', '2026-11-20T09:00:00.000Z', '2026-11-20T09:00:00.000Z', '2026-12-20T09:00:00.000Z'],
    // annual subscription: anchor months away, still monthly windows
    ['2026-03-05T00:00:00.000Z', '2027-01-31T00:00:00.000Z', '2026-02-28T00:00:00.000Z', '2026-03-31T00:00:00.000Z'],
    ['2026-04-30T12:00:00.000Z', '2027-01-31T00:00:00.000Z', '2026-04-30T00:00:00.000Z', '2026-05-31T00:00:00.000Z'],
    // webhook late: anchor already in the past
    ['2027-02-10T00:00:00.000Z', '2026-11-30T00:00:00.000Z', '2027-01-30T00:00:00.000Z', '2027-02-28T00:00:00.000Z'],
  ])('usagePeriodFor now=%s anchor=%s', (now, anchor, start, end) => {
    const p = usagePeriodFor({ now: d(now), anchor: d(anchor) });
    expect([p.start.toISOString(), p.end.toISOString()]).toEqual([start, end]);
    expect(p.start.getTime()).toBeLessThanOrEqual(d(now).getTime());
    expect(p.end.getTime()).toBeGreaterThan(d(now).getTime());
  });

  it('an invalid anchor falls back to the calendar month', () => {
    const p = usagePeriodFor({ now: d('2026-11-15T00:00:00.000Z'), anchor: new Date('nope') });
    expect(p.start.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('alerts', () => {
  it.each<[number, number, number, number[]]>([
    [0, 17_999, 36_000, []],
    [0, 18_000, 36_000, [50]],
    [17_999, 28_800, 36_000, [50, 80]],
    [0, 40_000, 36_000, [50, 80, 100]],
    [18_000, 20_000, 36_000, []],
    [28_800, 36_000, 36_000, [100]],
    [36_000, 50_000, 36_000, []],
    [0, 100, 0, []],
    [0, 0, 36_000, []],
  ])('crossedUsageThresholds(%s → %s of %s) = %j', (before, after, included, expected) => {
    expect(crossedUsageThresholds(before, after, included)).toEqual(expected);
  });
});

describe('credits', () => {
  it.each<[CreditPackId, number, number, number, string]>([
    ['25', 25_000_000, 25_000_000, 0, '$25'],
    ['100', 100_000_000, 105_000_000, 5, '$100 (+5% bonus)'],
    ['500', 500_000_000, 550_000_000, 10, '$500 (+10% bonus)'],
  ])('pack %s', (id, price, credit, bonus, label) => {
    expect(CREDIT_PACKS[id]).toEqual({ id, priceMicros: price, creditMicros: credit, bonusPercent: bonus });
    expect(creditPackBonusMicros(id)).toBe(credit - price);
    expect(CREDIT_PACKS[id].creditMicros).toBe(Math.round(price * (1 + bonus / 100)));
    expect(formatCreditPack(id)).toBe(label);
  });

  it.each<[unknown, boolean]>([
    ['25', true], ['100', true], ['500', true], [25, false], ['50', false], [null, false],
  ])('isCreditPackId(%j) = %s', (value, expected) => {
    expect(isCreditPackId(value)).toBe(expected);
  });

  it('lists every pack once', () => {
    expect([...CREDIT_PACK_IDS]).toEqual(Object.keys(CREDIT_PACKS));
  });

  it.each<[string, string]>([
    ['2026-11-01T10:00:00.000Z', '2027-11-01T10:00:00.000Z'],
    ['2028-02-29T00:00:00.000Z', '2029-02-28T00:00:00.000Z'],
    ['2026-12-31T23:59:59.999Z', '2027-12-31T23:59:59.999Z'],
  ])('a lot bought %s expires %s', (bought, expires) => {
    expect(creditExpiresAt(d(bought)).toISOString()).toBe(expires);
  });

  const now = d('2026-11-01T00:00:00.000Z');
  const lots = [
    { id: 'b', remainingMicros: 3_000_000, expiresAt: '2026-11-20T00:00:00.000Z' },
    { id: 'a', remainingMicros: 2_000_000, expiresAt: '2026-11-20T00:00:00.000Z' },
    { id: 'late', remainingMicros: 10_000_000, expiresAt: '2027-10-01T00:00:00.000Z' },
    { id: 'expired', remainingMicros: 50_000_000, expiresAt: '2026-10-31T23:59:59.000Z' },
    { id: 'empty', remainingMicros: 0, expiresAt: '2027-01-01T00:00:00.000Z' },
    { id: 'edge', remainingMicros: 1_000_000, expiresAt: '2026-11-01T00:00:00.000Z' },
  ];

  it.each<[string, boolean]>([
    ['b', true], ['late', true], ['expired', false], ['empty', false], ['edge', false],
  ])('lot %s live = %s', (id, live) => {
    expect(isCreditLotLive(lots.find((l) => l.id === id)!, now)).toBe(live);
  });

  it('balance counts live lots only', () => {
    expect(creditBalanceMicros(lots, now)).toBe(15_000_000);
    expect(creditBalanceMicros([], now)).toBe(0);
  });

  it.each<[number, number]>([
    [30, 5_000_000],
    [18, 0],
    [19, 5_000_000],
    [365, 15_000_000],
  ])('expiring within %s days = %s', (days, micros) => {
    expect(expiringSoonMicros(lots, now, days)).toBe(micros);
  });

  it.each<[number, Array<{ lotId: string; micros: number }>, number, number]>([
    [0, [], 0, 0],
    [1_500_000, [{ lotId: 'a', micros: 1_500_000 }], 1_500_000, 0],
    [4_000_000, [{ lotId: 'a', micros: 2_000_000 }, { lotId: 'b', micros: 2_000_000 }], 4_000_000, 0],
    [
      20_000_000,
      [{ lotId: 'a', micros: 2_000_000 }, { lotId: 'b', micros: 3_000_000 }, { lotId: 'late', micros: 10_000_000 }],
      15_000_000,
      5_000_000,
    ],
    [-5, [], 0, 0],
  ])('burnCreditLots(%s) burns soonest expiry first', (amount, burns, burned, short) => {
    expect(burnCreditLots(lots, amount, now)).toEqual({ burns, burnedMicros: burned, shortMicros: short });
  });

  it.each<[number, number]>([[0, 0], [1, 10_000], [2500, 25_000_000]])('centsToMicros(%s) = %s', (cents, micros) => {
    expect(centsToMicros(cents)).toBe(micros);
  });

  it.each<[number, number]>([[0, 0], [10_000, 1], [4_999, 0], [5_000, 1], [25_000_000, 2500]])(
    'microsToCents(%s) = %s',
    (micros, cents) => {
      expect(microsToCents(micros)).toBe(cents);
    },
  );
});

describe('auto top-up', () => {
  it('defaults: off, below $5 buy $25, $100 a month', () => {
    expect(AUTO_TOPUP_DEFAULTS).toEqual({ enabled: false, triggerMicros: 5_000_000, pack: '25', monthlyLimitMicros: 100_000_000 });
  });

  it.each<[string, string]>([
    ['2026-01-01T00:00:00.000Z', '2026-01'],
    ['2026-12-31T23:59:59.999Z', '2026-12'],
    ['2027-09-15T12:00:00.000Z', '2027-09'],
  ])('month key of %s is %s', (iso, key) => {
    expect(autoTopupMonthKey(d(iso))).toBe(key);
  });

  const on: AutoTopupConfig = { ...AUTO_TOPUP_DEFAULTS, enabled: true };
  it.each<[string, AutoTopupConfig, number, number, boolean]>([
    ['off', AUTO_TOPUP_DEFAULTS, 0, 0, false],
    ['below trigger', on, 4_999_999, 0, true],
    ['at trigger', on, 5_000_000, 0, false],
    ['last pack fits', on, 0, 75_000_000, true],
    ['limit reached', on, 0, 75_000_001, false],
    ['big pack over limit', { ...on, pack: '500' }, 0, 0, false],
    ['big pack within limit', { ...on, pack: '500', monthlyLimitMicros: 500_000_000 }, 0, 0, true],
  ])('shouldAutoTopUp: %s', (_name, config, balance, spent, expected) => {
    expect(shouldAutoTopUp(config, { balanceMicros: balance, monthSpentMicros: spent })).toBe(expected);
  });

  it.each<[string, unknown, number]>([
    ['valid defaults', AUTO_TOPUP_DEFAULTS, 0],
    ['valid custom', { enabled: true, triggerMicros: 0, pack: '100', monthlyLimitMicros: 100_000_000 }, 0],
    ['not an object', 'x', 1],
    ['null', null, 1],
    ['array', [], 1],
    ['bad enabled', { ...AUTO_TOPUP_DEFAULTS, enabled: 'yes' }, 1],
    ['bad pack', { ...AUTO_TOPUP_DEFAULTS, pack: '50' }, 1],
    ['negative trigger', { ...AUTO_TOPUP_DEFAULTS, triggerMicros: -1 }, 1],
    ['fractional trigger', { ...AUTO_TOPUP_DEFAULTS, triggerMicros: 1.5 }, 1],
    ['limit below pack', { ...AUTO_TOPUP_DEFAULTS, pack: '100', monthlyLimitMicros: 99_999_999 }, 1],
    ['missing limit', { enabled: true, triggerMicros: 0, pack: '25' }, 1],
    ['everything wrong', {}, 4],
  ])('validateAutoTopupConfig: %s', (_name, input, errors) => {
    expect(validateAutoTopupConfig(input)).toHaveLength(errors);
  });
});

describe('formatting', () => {
  it.each<[number, number | undefined, string]>([
    [0, undefined, '$0.00'],
    [25_000_000, undefined, '$25.00'],
    [4_374_999, undefined, '$4.37'],
    [4_375_000, undefined, '$4.38'],
    [-1_500_000, undefined, '-$1.50'],
    [-1, undefined, '$0.00'],
    [1_234_567_890, undefined, '$1,234.57'],
    [100_000_000, 0, '$100'],
    [275_000, 3, '$0.275'],
    [1, 6, '$0.000001'],
  ])('formatUsd(%s, %s) = %s', (micros, digits, text) => {
    expect(formatUsd(micros, digits)).toBe(text);
  });

  it.each<[number, string]>([
    [220_000, '$0.22/h'],
    [275_000, '$0.275/h'],
    [1_000_000, '$1.00/h'],
    [0, '$0.00/h'],
  ])('formatPricePerHour(%s) = %s', (micros, text) => {
    expect(formatPricePerHour(micros)).toBe(text);
  });

  it.each<[number, string]>([
    [0, '0'],
    [-50, '0'],
    [359, '0'],
    [360, '0.1'],
    [135_000, '37.5'],
    [719_999, '199.9'],
    [720_000, '200'],
    [HOUR, '1'],
  ])('formatBoxHours(%s) = %s', (wsec, text) => {
    expect(formatBoxHours(wsec)).toBe(text);
  });

  it.each<[number, string]>([
    [HOUR, '1 box-hour'],
    [0, '0 box-hours'],
    [9000, '2.5 box-hours'],
  ])('formatBoxHoursLabel(%s) = %s', (wsec, text) => {
    expect(formatBoxHoursLabel(wsec)).toBe(text);
  });

  it.each<[number, number, string]>([
    [135_000, 720_000, '37.5 of 200 box-hours'],
    [0, 36_000, '0 of 10 box-hours'],
    [1800, HOUR, '0.5 of 1 box-hour'],
  ])('formatBoxHoursUsage(%s, %s) = %s', (used, included, text) => {
    expect(formatBoxHoursUsage(used, included)).toBe(text);
  });
});
