import { describe, it, expect } from 'vitest';
import { wantsImmediateRepass } from '../services/codeReview/executor.js';

/**
 * A phase boundary must cost nothing.
 *
 * `wantsImmediateRepass` answers "should the evaluator look again straight
 * away". It used to answer no after advancing a phase, on the reading that the
 * row had moved and the pass was therefore finished. That reading is wrong in
 * the expensive direction: entering a phase is exactly when its work becomes
 * available, so stopping there parked the review until something else poked it —
 * and the only thing that reliably does is the 60-second reconciler, because the
 * poller only visits units that are already running and a review between phases
 * has none.
 *
 * Measured on the first real review: 2m42s sitting in `queued` and 2m04s in
 * `preparing`, out of 41 minutes, for dispatches that take two seconds.
 *
 * The failure mode is SILENT — the review still completes, just slowly — which is
 * why this is a test and not a comment.
 */
describe('wantsImmediateRepass', () => {
  it.each([
    ['phase', 'the new phase has work available right now'],
    ['prepare', 'preparing ends by moving to reviewing, which has units to dispatch'],
    ['dispatch', 'units may already have settled'],
  ] as const)('asks for another pass after %s — %s', (type) => {
    expect(wantsImmediateRepass(type)).toBe(true);
  });

  it.each([
    ['finish', 'a finished cycle has nothing left to do'],
    ['fail', 'a failed cycle must not be re-driven'],
  ] as const)('stops after %s — %s', (type) => {
    // The other direction matters just as much: re-driving a terminal review is
    // how a finished cycle would start another one.
    expect(wantsImmediateRepass(type)).toBe(false);
  });
});
