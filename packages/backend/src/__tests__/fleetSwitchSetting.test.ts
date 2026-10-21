import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FLEET_SWITCH_AT_PERCENT,
  FEATURE_FLAGS,
  MIN_FLEET_SWITCH_AT_PERCENT,
  normaliseFleetSwitchAtPercent,
  readFlagOverride,
} from '@talyn/shared';

describe('fleetMultiAccount flag', () => {
  it('is a released kill switch that fails open', () => {
    expect(FEATURE_FLAGS.fleetMultiAccount).toMatchObject({
      posthogKey: 'fleet-multi-account',
      envOverride: 'FLEET_MULTI_ACCOUNT_ENABLED',
      fallback: true,
      availability: 'general',
    });
  });

  it.each([
    ['false', false],
    ['true', true],
  ])('env override %s -> %s', (value, expected) => {
    expect(readFlagOverride('fleetMultiAccount', { FLEET_MULTI_ACCOUNT_ENABLED: value })).toBe(expected);
  });
});

describe('normaliseFleetSwitchAtPercent', () => {
  it('has the agreed bounds', () => {
    expect(DEFAULT_FLEET_SWITCH_AT_PERCENT).toBe(100);
    expect(MIN_FLEET_SWITCH_AT_PERCENT).toBe(50);
  });

  it.each([50, 51, 95, 99, 100])('accepts %i', (v) => {
    expect(normaliseFleetSwitchAtPercent(v)).toEqual({ ok: true, value: v });
  });

  it.each([49, 101, 0, -5, 95.5, NaN, Infinity, '95', null, undefined, {}, true])('rejects %j', (v) => {
    const r = normaliseFleetSwitchAtPercent(v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('50 to 100');
  });
});
