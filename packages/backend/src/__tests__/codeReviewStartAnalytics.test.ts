import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `code_review_started` comes from `startReviewCycle`, for every caller.
 *
 * It used to come from the route alone. An automatic review or a workflow then
 * started cycles with no start event, so the review-to-fix funnel had no first
 * step for them, and a fix asked for on their findings counted nowhere.
 */

const { capture, getPrForReview } = vi.hoisted(() => ({
  capture: vi.fn(),
  getPrForReview: vi.fn(),
}));

vi.mock('../services/analytics.js', () => ({ captureWorkspaceEvent: capture }));
vi.mock('../services/codeReview/evaluator.js', () => ({ scheduleReviewEvaluation: vi.fn() }));
vi.mock('../services/billing/entitlements.js', () => ({
  ReviewCycleLimitError: class extends Error {},
  withReviewCycleGate: vi.fn(async (_owner: string, _opts: unknown, fn: () => Promise<unknown>) =>
    fn()
  ),
}));
vi.mock('../services/codeReview/store.js', () => ({
  getPrForReview,
  getReviewForPr: vi.fn(async () => ({
    id: 'rev-1',
    workspaceId: 'ws-1',
    phase: 'ready',
    cycle: 1,
    version: 3,
    startedBy: null,
  })),
  ensureReview: vi.fn(),
  casTransition: vi.fn(async () => true),
}));
vi.mock('../services/codeReview/findings.js', () => ({ discardFindings: vi.fn(async () => 0) }));
vi.mock('../services/codeReviewAccess.js', () => ({
  workspaceMayUseCodeReview: vi.fn(async () => true),
}));
vi.mock('../db/client.js', () => ({
  getDbClient: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ ownerId: 'owner-1', settings: null }] }) }),
    }),
  }),
  runWithoutScope: (fn: () => unknown) => fn(),
}));
vi.mock('../services/selfHosted/credentials.js', () => ({ getSelfHostedClient: vi.fn() }));
vi.mock('../services/posthogCode/credentials.js', () => ({ getPostHogCodeClient: vi.fn() }));

const { startReviewCycle } = await import('../services/codeReview/cycle.js');

function startEvents() {
  return capture.mock.calls.filter(([, event]) => event === 'code_review_started');
}

describe('startReviewCycle — code_review_started', () => {
  beforeEach(() => {
    capture.mockClear();
    getPrForReview.mockResolvedValue({
      id: 'pr-1',
      workspaceId: 'ws-1',
      repositoryId: 'repo-1',
      owner: 'acme',
      repo: 'api',
      state: 'open',
    });
  });

  it.each([
    [{}, 'api'],
    [{ auto: true }, 'auto'],
    [{ auto: true, trigger: 'workflow' as const }, 'workflow'],
  ])('sends one start event for %o with trigger %s', async (input, trigger) => {
    const outcome = await startReviewCycle({ pullRequestId: 'pr-1', ...input });

    expect(outcome.ok).toBe(true);
    expect(startEvents()).toHaveLength(1);
    expect(startEvents()[0]).toEqual([
      'ws-1',
      'code_review_started',
      expect.objectContaining({ trigger, started: true, is_rereview: true }),
    ]);
  });

  it('sends no start event when the start is refused', async () => {
    getPrForReview.mockResolvedValue({ id: 'pr-1', workspaceId: 'ws-1', state: 'closed' });

    const outcome = await startReviewCycle({ pullRequestId: 'pr-1', auto: true });

    expect(outcome.ok).toBe(false);
    expect(startEvents()).toHaveLength(0);
  });
});
