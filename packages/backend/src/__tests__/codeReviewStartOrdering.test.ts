import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The evaluation must be scheduled AFTER the plan gate's transaction commits.
 *
 * `withReviewCycleGate` holds a transaction. `scheduleReviewEvaluation` detaches
 * onto its own connection, so a pass triggered from INSIDE the gate read the
 * review before the transition had committed — saw the phase it held before
 * (`ready` or `fixed`, both at rest), decided there was nothing to do, and
 * exited. The review then sat in `queued` until the reconciler noticed, which it
 * only does after two minutes.
 *
 * That was the whole of "why does it take so long to start": not the dispatch,
 * which takes about two seconds, but a first evaluation that raced a commit and
 * lost — and updated `last_evaluated_at` on its way past, which is what made it
 * look like the review had already been looked at.
 *
 * The failure mode is a SLOW review rather than a broken one, so nothing else
 * here would catch it coming back.
 */

const order: string[] = [];
const scheduleReviewEvaluation = vi.fn(() => {
  order.push('scheduled');
});

vi.mock('../services/codeReview/evaluator.js', () => ({ scheduleReviewEvaluation }));

vi.mock('../services/billing/entitlements.js', () => ({
  ReviewCycleLimitError: class extends Error {},
  // Faithful to the real gate in the one way that matters: the callback runs
  // inside it, and the "commit" happens only once the callback has returned.
  withReviewCycleGate: vi.fn(async (_owner: string, _opts: unknown, fn: () => Promise<unknown>) => {
    order.push('gate:open');
    const result = await fn();
    order.push('gate:commit');
    return result;
  }),
}));

vi.mock('../services/codeReview/store.js', () => ({
  getPrForReview: vi.fn(async () => ({
    id: 'pr-1',
    workspaceId: 'ws-1',
    repositoryId: 'repo-1',
    state: 'open',
  })),
  getReviewForPr: vi.fn(async () => ({
    id: 'rev-1',
    workspaceId: 'ws-1',
    phase: 'fixed',
    cycle: 3,
    version: 7,
    startedBy: null,
  })),
  ensureReview: vi.fn(async (input: { id: string }) => ({ ...input, cycle: 0, version: 0 })),
  casTransition: vi.fn(async () => {
    order.push('cas:queued');
    return true;
  }),
  getReview: vi.fn(async () => null),
}));

vi.mock('../services/codeReview/findings.js', () => ({ discardFindings: vi.fn(async () => 0) }));
vi.mock('../services/codeReviewAccess.js', () => ({
  workspaceMayUseCodeReview: vi.fn(async () => true),
}));
// The preset and owner lookups read the workspaces table directly; a stub db is
// enough because what is under test is ORDER, not what they return.
vi.mock('../db/client.js', () => ({
  getDbClient: () => ({
    // One row, so `workspaceOwner` finds an owner; the preset read tolerates the
    // same shape and falls back to the default.
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ ownerId: 'owner-1', settings: null }] }) }),
    }),
  }),
  runWithoutScope: (fn: () => unknown) => fn(),
}));
vi.mock('../services/selfHosted/credentials.js', () => ({ getSelfHostedClient: vi.fn() }));
vi.mock('../services/posthogCode/credentials.js', () => ({ getPostHogCodeClient: vi.fn() }));

describe('startReviewCycle — scheduling order', () => {
  beforeEach(() => {
    order.length = 0;
    scheduleReviewEvaluation.mockClear();
  });

  it('schedules the first evaluation only after the gate has committed', async () => {
    const { startReviewCycle } = await import('../services/codeReview/cycle.js');
    const outcome = await startReviewCycle({ pullRequestId: 'pr-1' });

    expect(outcome.ok).toBe(true);
    expect(scheduleReviewEvaluation).toHaveBeenCalledTimes(1);

    // The assertion that matters: scheduling comes after the commit, not between
    // the CAS and the commit, which is where it used to sit.
    expect(order).toEqual(['gate:open', 'cas:queued', 'gate:commit', 'scheduled']);
    expect(order.indexOf('scheduled')).toBeGreaterThan(order.indexOf('gate:commit'));
  });
});
