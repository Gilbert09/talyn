import { describe, it, expect, beforeEach } from 'vitest';
import {
  shouldAnnounceDeferral,
  _resetDeferredRunsGuard,
} from '../hooks/useDeferredRuns';

/**
 * When to tell a free user that auto-keep quietly stopped keeping their PRs
 * green. The other two free-plan limits refuse a request and become the
 * UpgradeModal via the 402; this one has no request behind it, so the only
 * choice left is when to volunteer it.
 */
describe('shouldAnnounceDeferral', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_757_000_000_000;

  beforeEach(() => _resetDeferredRunsGuard());

  it('says nothing when nothing is deferred', () => {
    // Never show a wall the user is not currently standing at — their slots
    // may well have freed up between the deferral and them opening the app.
    expect(shouldAnnounceDeferral(0, 0, NOW)).toBe(false);
    expect(shouldAnnounceDeferral(0, NOW - 10 * DAY, NOW)).toBe(false);
  });

  it('announces a deferral that has never been announced', () => {
    expect(shouldAnnounceDeferral(1, 0, NOW)).toBe(true);
  });

  it.each([0, 1, DAY - 1])(
    'stays quiet %pms after the last announcement',
    (elapsed) => {
      // The 24h floor is what stops a continuously-degraded user being told
      // every single launch. Being at the cap for a month is one problem, not
      // thirty.
      expect(shouldAnnounceDeferral(3, NOW - elapsed, NOW)).toBe(false);
    },
  );

  it.each([DAY, DAY + 1, 30 * DAY])(
    'announces again once %pms have passed',
    (elapsed) => {
      // An ongoing degradation is worth repeating — just not often. A user who
      // dismissed it yesterday and is still capped today still has a problem.
      expect(shouldAnnounceDeferral(1, NOW - elapsed, NOW)).toBe(true);
    },
  );

  it('does not care how many PRs are deferred, only that some are', () => {
    // One skipped run is the same message as five; the count is for the copy,
    // not the decision.
    expect(shouldAnnounceDeferral(1, 0, NOW)).toBe(shouldAnnounceDeferral(9, 0, NOW));
  });
});
