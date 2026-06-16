import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  aliasForBranch,
  batchPullRequests,
  computeBlockingReason,
  computeCheckDigest,
  deriveEffectiveReviewDecision,
  decodeBatchResponse,
  decodeBatchByNumberResponse,
  decodeReviewDetail,
  dedupeLatestCheckByName,
  makeBatchPullRequestsQuery,
  makeBatchPullRequestsByNumberQuery,
  normalizeCheckState,
} from '../services/githubGraphql.js';
import { githubService } from '../services/github.js';

describe('normalizeCheckState', () => {
  // CheckRun: status drives the verdict while !COMPLETED.
  it('returns pending for QUEUED / WAITING / PENDING status', () => {
    expect(normalizeCheckState({ status: 'QUEUED' })).toBe('pending');
    expect(normalizeCheckState({ status: 'WAITING' })).toBe('pending');
    expect(normalizeCheckState({ status: 'PENDING' })).toBe('pending');
  });

  it('returns in_progress for IN_PROGRESS status', () => {
    expect(normalizeCheckState({ status: 'IN_PROGRESS' })).toBe('in_progress');
  });

  // CheckRun: status COMPLETED → conclusion wins.
  it('maps SUCCESS / NEUTRAL conclusion to success', () => {
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'SUCCESS' })).toBe('success');
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'NEUTRAL' })).toBe('success');
  });

  it('maps SKIPPED conclusion to skipped (not success)', () => {
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'SKIPPED' })).toBe('skipped');
  });

  it('maps FAILURE / TIMED_OUT / STARTUP_FAILURE / ACTION_REQUIRED to failure', () => {
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'FAILURE' })).toBe('failure');
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'TIMED_OUT' })).toBe('failure');
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' })).toBe('failure');
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' })).toBe('failure');
  });

  it('maps CANCELLED conclusion to cancelled (its own state)', () => {
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'CANCELLED' })).toBe('cancelled');
  });

  it('treats unknown conclusion conservatively as failure', () => {
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'PURPLE' })).toBe('failure');
  });

  // StatusContext: legacy state field.
  it('maps StatusContext SUCCESS state to success', () => {
    expect(normalizeCheckState({ state: 'SUCCESS' })).toBe('success');
  });

  it('maps StatusContext FAILURE / ERROR to failure', () => {
    expect(normalizeCheckState({ state: 'FAILURE' })).toBe('failure');
    expect(normalizeCheckState({ state: 'ERROR' })).toBe('failure');
  });

  it('maps StatusContext PENDING / EXPECTED to pending', () => {
    expect(normalizeCheckState({ state: 'PENDING' })).toBe('pending');
    expect(normalizeCheckState({ state: 'EXPECTED' })).toBe('pending');
  });

  it('returns pending for an entirely empty input (defensive)', () => {
    expect(normalizeCheckState({})).toBe('pending');
  });

  it('is case-insensitive on input', () => {
    expect(normalizeCheckState({ status: 'in_progress' })).toBe('in_progress');
    expect(normalizeCheckState({ status: 'completed', conclusion: 'success' })).toBe('success');
  });
});

describe('computeBlockingReason', () => {
  const baseChecks = { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 };

  it('returns merge_conflicts when CONFLICTING (even if reviews + checks are clean)', () => {
    expect(
      computeBlockingReason({
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        reviewDecision: 'APPROVED',
        checks: { ...baseChecks, total: 5, passed: 5 },
      })
    ).toBe('merge_conflicts');
  });

  it('returns changes_requested when reviewDecision says so (even if mergeable)', () => {
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'CHANGES_REQUESTED',
        checks: baseChecks,
      })
    ).toBe('changes_requested');
  });

  it('returns checks_failed when a REQUIRED check fails (merge is BLOCKED)', () => {
    // GitHub reports a failing *required* check as BLOCKED (not UNSTABLE).
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: 'APPROVED',
        checks: { ...baseChecks, total: 3, passed: 2, failed: 1 },
      })
    ).toBe('checks_failed');
  });

  it('returns checks_failed_optional when failures are non-required (UNSTABLE → still mergeable)', () => {
    // UNSTABLE = mergeable despite non-passing checks ⇒ none of the failing
    // checks are required, so they don't block.
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'UNSTABLE',
        reviewDecision: 'APPROVED',
        checks: { ...baseChecks, total: 3, passed: 2, failed: 1 },
      })
    ).toBe('checks_failed_optional');
  });

  it('treats CLEAN/unknown states with failures as blocking (conservative default)', () => {
    // If GitHub doesn't tell us it's UNSTABLE, we can't prove the failure
    // is optional — keep the hard 'checks_failed'.
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'APPROVED',
        checks: { ...baseChecks, total: 3, passed: 2, failed: 1 },
      })
    ).toBe('checks_failed');
  });

  it('a required review still wins over non-required failing checks', () => {
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'UNSTABLE',
        reviewDecision: 'REVIEW_REQUIRED',
        checks: { ...baseChecks, total: 3, passed: 2, failed: 1 },
      })
    ).toBe('blocked');
  });

  it('returns mergeable for the happy path (CLEAN)', () => {
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'APPROVED',
        checks: { ...baseChecks, total: 3, passed: 3 },
      })
    ).toBe('mergeable');
  });

  it('returns mergeable for HAS_HOOKS / UNSTABLE — these are still mergeable in practice', () => {
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'HAS_HOOKS',
        reviewDecision: null,
        checks: { ...baseChecks, total: 1, passed: 1 },
      })
    ).toBe('mergeable');
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'UNSTABLE',
        reviewDecision: null,
        checks: { ...baseChecks, total: 2, passed: 1, inProgress: 1 },
      })
    ).toBe('mergeable');
  });

  it('returns blocked for MERGEABLE + BLOCKED (branch protection)', () => {
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: 'REVIEW_REQUIRED',
        checks: { ...baseChecks, total: 0 },
      })
    ).toBe('blocked');
  });

  it('returns unknown when GitHub has not computed mergeable yet', () => {
    expect(
      computeBlockingReason({
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'UNKNOWN',
        reviewDecision: null,
        checks: baseChecks,
      })
    ).toBe('unknown');
  });

  it('returns blocked for REVIEW_REQUIRED even while mergeable is UNKNOWN', () => {
    // GitHub computes `mergeable` lazily (UNKNOWN on first fetch), but
    // reviewDecision is already known — a waiting-on-review PR should read
    // "Review", not flash an unknown "—".
    expect(
      computeBlockingReason({
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'UNKNOWN',
        reviewDecision: 'REVIEW_REQUIRED',
        checks: baseChecks,
      })
    ).toBe('blocked');
  });

  // --- authoritative path: per-check isRequired is known ---

  it('authoritative: a required failing check blocks (checks_failed)', () => {
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: 'APPROVED',
        checks: { ...baseChecks, total: 3, passed: 2, failed: 1 },
        requiredFailing: 1,
        requiredDataAvailable: true,
      })
    ).toBe('checks_failed');
  });

  it('authoritative: BLOCKED-on-review with only a non-required failure → blocked, not checks_failed', () => {
    // The real PostHog/posthog#63399 shape: GitHub reports the PR as
    // MERGEABLE but BLOCKED (a required review is pending) while the single
    // failing check is non-required. The pending review masks the rollup as
    // BLOCKED, but the failure itself doesn't block — so this must read as
    // "Review", never a red "1/N failing".
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: 'REVIEW_REQUIRED',
        checks: { ...baseChecks, total: 227, passed: 142, failed: 1, skipped: 84 },
        requiredFailing: 0,
        requiredDataAvailable: true,
      })
    ).toBe('blocked');
  });

  it('authoritative: a non-required failure on a CLEAN/approved PR is optional (overrides the conservative default)', () => {
    // Without per-check data this CLEAN+failed case defaults to checks_failed
    // (see the conservative-default test); knowing the failure is
    // non-required lets us de-emphasise it instead.
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'APPROVED',
        checks: { ...baseChecks, total: 3, passed: 2, failed: 1 },
        requiredFailing: 0,
        requiredDataAvailable: true,
      })
    ).toBe('checks_failed_optional');
  });

  it('priority order: conflicts wins over changes_requested wins over checks_failed', () => {
    // All three blocking signals at once → only one is surfaced. Conflicts
    // is the most actionable so wins.
    expect(
      computeBlockingReason({
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        reviewDecision: 'CHANGES_REQUESTED',
        checks: { ...baseChecks, total: 3, passed: 1, failed: 2 },
      })
    ).toBe('merge_conflicts');
  });
});

describe('deriveEffectiveReviewDecision', () => {
  const review = (author: string, state: string) => ({ author, state });

  it("trusts GitHub's reviewDecision verbatim when present (branch protection)", () => {
    for (const d of ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] as const) {
      expect(
        deriveEffectiveReviewDecision({
          reviewDecision: d,
          // Even contradictory review nodes don't override the gated decision.
          recentReviews: [review('alice', 'CHANGES_REQUESTED')],
          reviewRequests: { users: ['bob'], teams: [] },
        })
      ).toBe(d);
    }
  });

  it('derives APPROVED from an approval when GitHub gives null and nothing outstanding', () => {
    expect(
      deriveEffectiveReviewDecision({
        reviewDecision: null,
        recentReviews: [review('alice', 'APPROVED')],
        reviewRequests: { users: [], teams: [] },
      })
    ).toBe('APPROVED');
  });

  it('derives CHANGES_REQUESTED ahead of everything else (most actionable)', () => {
    expect(
      deriveEffectiveReviewDecision({
        reviewDecision: null,
        recentReviews: [review('bob', 'CHANGES_REQUESTED'), review('alice', 'APPROVED')],
        reviewRequests: { users: ['carol'], teams: [] },
      })
    ).toBe('CHANGES_REQUESTED');
  });

  it('treats an outstanding review request as REVIEW_REQUIRED, superseding a stale approval', () => {
    expect(
      deriveEffectiveReviewDecision({
        reviewDecision: null,
        recentReviews: [review('alice', 'APPROVED')],
        reviewRequests: { users: ['bob'], teams: [] },
      })
    ).toBe('REVIEW_REQUIRED');
    // Team requests count too.
    expect(
      deriveEffectiveReviewDecision({
        reviewDecision: null,
        recentReviews: [],
        reviewRequests: { users: [], teams: [{ slug: 'eng' }] },
      })
    ).toBe('REVIEW_REQUIRED');
  });

  it('takes the latest decision-bearing review per author (freshest-first), ignoring COMMENTED', () => {
    // alice's freshest decision is APPROVED; a later COMMENTED must not erase it.
    expect(
      deriveEffectiveReviewDecision({
        reviewDecision: null,
        recentReviews: [
          review('alice', 'COMMENTED'),
          review('alice', 'APPROVED'),
          review('alice', 'CHANGES_REQUESTED'),
        ],
        reviewRequests: { users: [], teams: [] },
      })
    ).toBe('APPROVED');
  });

  it('returns null when no reviewers are involved at all', () => {
    expect(
      deriveEffectiveReviewDecision({
        reviewDecision: null,
        recentReviews: [review('alice', 'COMMENTED')],
        reviewRequests: { users: [], teams: [] },
      })
    ).toBeNull();
  });
});

describe('computeCheckDigest', () => {
  it('is stable across input order (sorted internally)', () => {
    const a = computeCheckDigest('sha1', [
      { name: 'lint', state: 'success' },
      { name: 'test', state: 'failure' },
    ]);
    const b = computeCheckDigest('sha1', [
      { name: 'test', state: 'failure' },
      { name: 'lint', state: 'success' },
    ]);
    expect(a).toBe(b);
  });

  it('changes when a check transitions state', () => {
    const before = computeCheckDigest('sha1', [{ name: 'test', state: 'in_progress' }]);
    const after = computeCheckDigest('sha1', [{ name: 'test', state: 'success' }]);
    expect(before).not.toBe(after);
  });

  it('changes when the head sha changes (force-push)', () => {
    const before = computeCheckDigest('shaA', [{ name: 'test', state: 'success' }]);
    const after = computeCheckDigest('shaB', [{ name: 'test', state: 'success' }]);
    expect(before).not.toBe(after);
  });
});

describe('makeBatchPullRequestsQuery', () => {
  it('aliases each branch under the single repository node', () => {
    const q = makeBatchPullRequestsQuery(['main', 'feature/x']);
    expect(q).toMatch(/repository\(owner: \$owner, name: \$repo\)/);
    expect(q).toContain(`${aliasForBranch(0)}: pullRequests(headRefName: "main"`);
    expect(q).toContain(`${aliasForBranch(1)}: pullRequests(headRefName: "feature/x"`);
  });

  it('escapes weird branch names safely as JSON strings', () => {
    // Quotes and backslashes in a branch name must not break the query.
    const q = makeBatchPullRequestsQuery(['weird"name', 'with\\back']);
    expect(q).toContain('"weird\\"name"');
    expect(q).toContain('"with\\\\back"');
  });

  it('inlines the PR selection with statusCheckRollup + reviews + comments', () => {
    const q = makeBatchPullRequestsQuery(['main']);
    expect(q).toContain('statusCheckRollup');
    expect(q).toContain('contexts(first: 100)');
    expect(q).toContain('reviews(last: 5)');
    // Both comment surfaces are pulled in the same round-trip so the
    // cursor delta-checker doesn't need a separate REST fan-out.
    expect(q).toContain('reviewThreads(last: 5)');
    expect(q).toContain('comments(last: 5)');
    expect(q).toContain('mergeable');
    expect(q).toContain('mergeStateStatus');
    expect(q).toContain('reviewDecision');
  });

  it('omits isRequired when no PR numbers are supplied (no number to query)', () => {
    const q = makeBatchPullRequestsQuery(['main']);
    expect(q).not.toContain('isRequired');
  });

  it('inlines isRequired(pullRequestNumber:) when numbers are supplied', () => {
    const q = makeBatchPullRequestsQuery(['main', 'feature/x'], [11, 22]);
    expect(q).toContain('isRequired(pullRequestNumber: 11)');
    expect(q).toContain('isRequired(pullRequestNumber: 22)');
  });
});

describe('makeBatchPullRequestsByNumberQuery', () => {
  it('aliases each PR by number and inlines the selection', () => {
    const q = makeBatchPullRequestsByNumberQuery([60538, 60539]);
    expect(q).toMatch(/repository\(owner: \$owner, name: \$repo\)/);
    expect(q).toContain(`${aliasForBranch(0)}: pullRequest(number: 60538)`);
    expect(q).toContain(`${aliasForBranch(1)}: pullRequest(number: 60539)`);
    expect(q).toContain('statusCheckRollup');
  });

  it('asks GitHub whether each check isRequired for that PR', () => {
    const q = makeBatchPullRequestsByNumberQuery([60538, 60539]);
    expect(q).toContain('isRequired(pullRequestNumber: 60538)');
    expect(q).toContain('isRequired(pullRequestNumber: 60539)');
  });
});

describe('decodeBatchByNumberResponse', () => {
  it('maps each alias node back to its number; null when absent', () => {
    const result = decodeBatchByNumberResponse(
      [1, 2],
      {
        repository: {
          [aliasForBranch(0)]: {
            number: 1,
            title: 't',
            body: '',
            url: 'u',
            isDraft: false,
            state: 'OPEN',
            mergedAt: null,
            closedAt: null,
            updatedAt: '2026-01-01T00:00:00Z',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            reviewDecision: null,
            author: { login: 'me' },
            headRefName: 'feature/a',
            baseRefName: 'main',
            headRefOid: 'sha',
            reviews: { nodes: [] },
            reviewThreads: { nodes: [] },
            comments: { nodes: [] },
            commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
          },
          [aliasForBranch(1)]: null,
        },
      } as never,
      'acme',
      'widgets'
    );
    expect(result[0].number).toBe(1);
    expect(result[0].pr?.number).toBe(1);
    expect(result[1]).toEqual({ number: 2, pr: null });
  });

  it('returns all-null when the repository node is null', () => {
    const result = decodeBatchByNumberResponse(
      [1, 2],
      { repository: null },
      'acme',
      'widgets'
    );
    expect(result).toEqual([
      { number: 1, pr: null },
      { number: 2, pr: null },
    ]);
  });

  it('flows isRequired through to the blocking reason + checkContexts (the #63399 shape)', () => {
    const node = {
      number: 63399,
      title: 'fix(cloudflare)',
      body: '',
      url: 'u',
      isDraft: false,
      state: 'OPEN',
      mergedAt: null,
      closedAt: null,
      updatedAt: '2026-01-01T00:00:00Z',
      // MERGEABLE + BLOCKED + REVIEW_REQUIRED: the PR is held on a pending
      // required review, not on the one non-required failing check.
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      reviewDecision: 'REVIEW_REQUIRED',
      author: { login: 'gilbert' },
      headRefName: 'cloudflare-skip-forbidden-zones',
      baseRefName: 'master',
      headRefOid: 'sha',
      reviews: { nodes: [] },
      reviewThreads: { nodes: [] },
      comments: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: 'FAILURE',
                contexts: {
                  nodes: [
                    {
                      __typename: 'CheckRun',
                      id: '1',
                      name: 'shellcheck',
                      status: 'COMPLETED',
                      conclusion: 'SUCCESS',
                      isRequired: true,
                    },
                    {
                      __typename: 'CheckRun',
                      id: '2',
                      name: 'Django Tests Pass',
                      status: 'COMPLETED',
                      conclusion: 'FAILURE',
                      isRequired: false,
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        ],
      },
    };
    const pr = decodeBatchByNumberResponse(
      [63399],
      { repository: { [aliasForBranch(0)]: node } } as never,
      'PostHog',
      'posthog'
    )[0].pr!;
    expect(pr.checks.failed).toBe(1);
    // The failure is non-required → the PR reads as blocked-on-review, not
    // a red failing-checks verdict.
    expect(pr.blockingReason).toBe('blocked');
    expect(pr.checkContexts.find((c) => c.name === 'Django Tests Pass')?.required).toBe(false);
    expect(pr.checkContexts.find((c) => c.name === 'shellcheck')?.required).toBe(true);
  });
});

describe('dedupeLatestCheckByName', () => {
  it('keeps the latest run when a name repeats; preserves distinct names', () => {
    const out = dedupeLatestCheckByName([
      { name: 'a', ts: 100, state: 'failure' },
      { name: 'a', ts: 200, state: 'pending' }, // newer re-run supersedes
      { name: 'b', ts: 50, state: 'success' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((c) => c.name === 'a')?.state).toBe('pending');
    expect(out.find((c) => c.name === 'b')?.state).toBe('success');
  });

  it('on an exact-timestamp tie, the later-in-array run wins', () => {
    const out = dedupeLatestCheckByName([
      { name: 'a', ts: 100, state: 'failure' },
      { name: 'a', ts: 100, state: 'success' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].state).toBe('success');
  });
});

describe('rawToSummary check de-duplication (via decodeBatchResponse)', () => {
  // Reproduces PostHog/posthog#63722: a required "Pass" gate that re-ran has
  // an OLD failure run sitting in the rollup behind a fresh QUEUED run of the
  // same name. We must count only the latest (queued → pending), not the stale
  // failure — otherwise the pill shows a phantom failure.
  function prWithContexts(contexts: unknown[]): unknown {
    return {
      number: 7,
      title: 'x',
      body: '',
      url: 'https://github.com/acme/widgets/pull/7',
      isDraft: false,
      state: 'OPEN',
      mergedAt: null,
      closedAt: null,
      createdAt: '2026-06-15T00:00:00Z',
      updatedAt: '2026-06-15T00:00:00Z',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      reviewDecision: 'APPROVED',
      author: { login: 'alice' },
      headRefName: 'feature/x',
      baseRefName: 'master',
      headRefOid: 'sha7',
      reviews: { nodes: [] },
      reviewThreads: { nodes: [] },
      comments: { nodes: [] },
      commits: {
        nodes: [{ commit: { statusCheckRollup: { state: 'PENDING', contexts: { nodes: contexts } } } }],
      },
    };
  }
  const checkRun = (over: Record<string, unknown>) => ({
    __typename: 'CheckRun',
    id: String(Math.random()),
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    checkSuite: { app: { name: 'GitHub Actions' } },
    ...over,
  });

  it('counts the fresh queued re-run, not the superseded failure of the same name', () => {
    const data = {
      repository: {
        [aliasForBranch(0)]: {
          nodes: [
            prWithContexts([
              checkRun({
                name: 'Frontend Tests Pass',
                status: 'COMPLETED',
                conclusion: 'FAILURE',
                startedAt: '2026-06-15T21:16:57Z',
                completedAt: '2026-06-15T21:16:59Z',
              }),
              checkRun({
                name: 'Frontend Tests Pass',
                status: 'QUEUED',
                conclusion: null,
                startedAt: '2026-06-15T21:24:14Z',
                completedAt: null,
              }),
              checkRun({ name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }),
            ]),
          ],
        },
      },
    };
    const [{ pr }] = decodeBatchResponse(['feature/x'], data, 'acme', 'widgets');
    expect(pr).not.toBeNull();
    // The stale "Frontend Tests Pass = FAILURE" must NOT be counted.
    expect(pr!.checks.failed).toBe(0);
    expect(pr!.checks.inProgress).toBe(1); // the queued run → pending
    expect(pr!.checks.passed).toBe(1); // lint
    expect(pr!.checks.total).toBe(2); // de-duped: 2 distinct names
    expect(pr!.blockingReason).not.toBe('checks_failed');
  });
});

describe('decodeBatchResponse', () => {
  function rawPR(over: Record<string, unknown> = {}): unknown {
    return {
      number: 42,
      title: 'Add feature',
      body: 'description',
      url: 'https://github.com/acme/widgets/pull/42',
      isDraft: false,
      state: 'OPEN',
      mergedAt: null,
      closedAt: null,
      createdAt: '2025-12-30T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: 'APPROVED',
      author: { login: 'alice' },
      headRefName: 'feature/x',
      baseRefName: 'main',
      headRefOid: 'abcdef1',
      reviews: { nodes: [] },
      reviewThreads: { nodes: [] },
      comments: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: 'SUCCESS',
                contexts: { nodes: [] },
              },
            },
          },
        ],
      },
      ...over,
    };
  }

  it('returns null for branches with no matching PR', () => {
    const result = decodeBatchResponse(
      ['feature/x'],
      { repository: { [aliasForBranch(0)]: { nodes: [] } } },
      'acme',
      'widgets'
    );
    expect(result).toEqual([{ branch: 'feature/x', pr: null }]);
  });

  it('returns all-null when the repository node itself is null (repo deleted/renamed)', () => {
    const result = decodeBatchResponse(['a', 'b'], { repository: null }, 'acme', 'widgets');
    expect(result).toEqual([
      { branch: 'a', pr: null },
      { branch: 'b', pr: null },
    ]);
  });

  it('decodes a happy-path PR with rolled-up checks', () => {
    const data = {
      repository: {
        [aliasForBranch(0)]: {
          nodes: [
            rawPR({
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        state: 'SUCCESS',
                        contexts: {
                          nodes: [
                            {
                              __typename: 'CheckRun',
                              id: '1',
                              name: 'lint',
                              status: 'COMPLETED',
                              conclusion: 'SUCCESS',
                            },
                            {
                              __typename: 'CheckRun',
                              id: '2',
                              name: 'test',
                              status: 'COMPLETED',
                              conclusion: 'FAILURE',
                            },
                            {
                              __typename: 'StatusContext',
                              id: '3',
                              context: 'ci/external',
                              state: 'PENDING',
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            }),
          ],
        },
      },
    };
    const result = decodeBatchResponse(
      ['feature/x'],
      data as Parameters<typeof decodeBatchResponse>[1],
      'acme',
      'widgets'
    );
    expect(result).toHaveLength(1);
    const pr = result[0].pr!;
    expect(pr.owner).toBe('acme');
    expect(pr.repo).toBe('widgets');
    expect(pr.number).toBe(42);
    expect(pr.headBranch).toBe('feature/x');
    expect(pr.baseBranch).toBe('main');
    expect(pr.headSha).toBe('abcdef1');
    expect(pr.createdAt).toBe('2025-12-30T00:00:00Z');
    expect(pr.checks).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      inProgress: 1,
      skipped: 0,
    });
    // Failed check trumps APPROVED review for the verdict.
    expect(pr.blockingReason).toBe('checks_failed');
    // Per-check rows are exposed alongside the rollup (live detail
    // fetch surfaces these to the desktop Checks tab).
    // required is null here: this by-branch fixture carries no isRequired.
    expect(pr.checkContexts).toEqual([
      { name: 'lint', state: 'success', url: null, required: null },
      { name: 'test', state: 'failure', url: null, required: null },
      { name: 'ci/external', state: 'pending', url: null, required: null },
    ]);
  });

  it('treats a PR with no statusCheckRollup as zero checks (early-PR case)', () => {
    const data = {
      repository: {
        [aliasForBranch(0)]: {
          nodes: [
            rawPR({
              commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
            }),
          ],
        },
      },
    };
    const result = decodeBatchResponse(
      ['feature/x'],
      data as Parameters<typeof decodeBatchResponse>[1],
      'acme',
      'widgets'
    );
    const pr = result[0].pr!;
    expect(pr.checks.total).toBe(0);
    expect(pr.blockingReason).toBe('mergeable');
  });

  it('captures up to 5 recent reviews freshest-first (GitHub returns last:N oldest-first)', () => {
    const data = {
      repository: {
        [aliasForBranch(0)]: {
          nodes: [
            rawPR({
              // GraphQL `last: 5` returns oldest-first within the window;
              // the decoder must reverse so freshest sits at index 0.
              reviews: {
                nodes: [
                  {
                    id: 'r-old',
                    author: { login: 'alice' },
                    state: 'COMMENTED',
                    submittedAt: '2026-01-01T00:00:00Z',
                    url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-r-old',
                  },
                  {
                    id: 'r-new',
                    author: { login: 'bob' },
                    state: 'APPROVED',
                    submittedAt: '2026-01-02T00:00:00Z',
                    url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-r-new',
                  },
                ],
              },
            }),
          ],
        },
      },
    };
    const result = decodeBatchResponse(
      ['feature/x'],
      data as Parameters<typeof decodeBatchResponse>[1],
      'acme',
      'widgets'
    );
    expect(result[0].pr?.recentReviews).toHaveLength(2);
    expect(result[0].pr?.recentReviews[0].id).toBe('r-new');
    expect(result[0].pr?.recentReviews[0].author).toBe('bob');
    expect(result[0].pr?.recentReviews[1].id).toBe('r-old');
  });

  it('flattens reviewThreads → recentReviewComments freshest-first', () => {
    const data = {
      repository: {
        [aliasForBranch(0)]: {
          nodes: [
            rawPR({
              reviewThreads: {
                nodes: [
                  {
                    comments: {
                      nodes: [
                        {
                          id: 'rc-old',
                          author: { login: 'alice' },
                          createdAt: '2026-01-01T00:00:00Z',
                          url: 'https://github.com/acme/widgets/pull/42#discussion_r-old',
                        },
                      ],
                    },
                  },
                  {
                    comments: {
                      nodes: [
                        {
                          id: 'rc-new',
                          author: { login: 'bob' },
                          createdAt: '2026-01-02T00:00:00Z',
                          url: 'https://github.com/acme/widgets/pull/42#discussion_r-new',
                        },
                      ],
                    },
                  },
                ],
              },
            }),
          ],
        },
      },
    };
    const pr = decodeBatchResponse(
      ['feature/x'],
      data as Parameters<typeof decodeBatchResponse>[1],
      'acme',
      'widgets'
    )[0].pr!;
    expect(pr.recentReviewComments.map((c) => c.id)).toEqual(['rc-new', 'rc-old']);
  });

  it('counts unresolved review threads (capped at the first 100)', () => {
    const data = {
      repository: {
        [aliasForBranch(0)]: {
          nodes: [
            rawPR({
              unresolvedThreads: {
                nodes: [
                  { isResolved: false },
                  { isResolved: true },
                  { isResolved: false },
                ],
              },
            }),
          ],
        },
      },
    };
    const pr = decodeBatchResponse(
      ['feature/x'],
      data as Parameters<typeof decodeBatchResponse>[1],
      'acme',
      'widgets'
    )[0].pr!;
    expect(pr.unresolvedReviewThreads).toBe(2);
  });

  it('defaults unresolvedReviewThreads to 0 when the field is absent', () => {
    const data = {
      repository: {
        [aliasForBranch(0)]: { nodes: [rawPR()] },
      },
    };
    const pr = decodeBatchResponse(
      ['feature/x'],
      data as Parameters<typeof decodeBatchResponse>[1],
      'acme',
      'widgets'
    )[0].pr!;
    expect(pr.unresolvedReviewThreads).toBe(0);
  });

  it('captures top-level PR comments freshest-first', () => {
    const data = {
      repository: {
        [aliasForBranch(0)]: {
          nodes: [
            rawPR({
              comments: {
                nodes: [
                  {
                    id: 'c-old',
                    author: { login: 'alice' },
                    createdAt: '2026-01-01T00:00:00Z',
                    url: 'https://github.com/acme/widgets/pull/42#issuecomment-c-old',
                  },
                  {
                    id: 'c-new',
                    author: { login: 'bob' },
                    createdAt: '2026-01-02T00:00:00Z',
                    url: 'https://github.com/acme/widgets/pull/42#issuecomment-c-new',
                  },
                ],
              },
            }),
          ],
        },
      },
    };
    const pr = decodeBatchResponse(
      ['feature/x'],
      data as Parameters<typeof decodeBatchResponse>[1],
      'acme',
      'widgets'
    )[0].pr!;
    expect(pr.recentComments.map((c) => c.id)).toEqual(['c-new', 'c-old']);
  });

  it('maps state MERGED / CLOSED to the lowercase variants', () => {
    const merged = decodeBatchResponse(
      ['x'],
      {
        repository: {
          [aliasForBranch(0)]: {
            nodes: [rawPR({ state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z' })],
          },
        },
      } as Parameters<typeof decodeBatchResponse>[1],
      'acme',
      'widgets'
    );
    expect(merged[0].pr?.state).toBe('merged');
    expect(merged[0].pr?.mergedAt).toBe('2026-01-01T00:00:00Z');
  });
});

describe('batchPullRequests — orchestration', () => {
  beforeEach(() => {
    vi.spyOn(githubService, 'executeGraphql').mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns [] for an empty branch list without hitting GraphQL', async () => {
    const spy = vi.spyOn(githubService, 'executeGraphql');
    const out = await batchPullRequests({
      workspaceId: 'ws1',
      owner: 'acme',
      repo: 'widgets',
      branches: [],
    });
    expect(out).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('chunks 12 branches into 3 queries (chunk size 5 → 5 + 5 + 2)', async () => {
    const spy = vi
      .spyOn(githubService, 'executeGraphql')
      .mockImplementation(async (_workspaceId, _query, _vars) => {
        // Return empty repository node — every branch comes back as null.
        // We assert the chunking, not the decoding, here.
        return { repository: {} } as never;
      });
    const branches = Array.from({ length: 12 }, (_, i) => `b/${i}`);
    const out = await batchPullRequests({
      workspaceId: 'ws1',
      owner: 'acme',
      repo: 'widgets',
      branches,
    });
    expect(out).toHaveLength(12);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('passes owner + repo as variables on every query', async () => {
    const spy = vi
      .spyOn(githubService, 'executeGraphql')
      .mockResolvedValue({ repository: {} } as never);
    await batchPullRequests({
      workspaceId: 'ws1',
      owner: 'acme',
      repo: 'widgets',
      branches: ['main'],
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const callArgs = spy.mock.calls[0];
    expect(callArgs[0]).toBe('ws1');
    expect(callArgs[2]).toEqual({ owner: 'acme', repo: 'widgets' });
  });

  it('paginates statusCheckRollup contexts past the 100-node cap', async () => {
    const ctx = (over: Record<string, unknown>) => ({ __typename: 'CheckRun', status: 'COMPLETED', ...over });
    const spy = vi
      .spyOn(githubService, 'executeGraphql')
      .mockImplementation(async (_ws, query: string) => {
        if (query.includes('ContextsPage')) {
          // Page 2: the remaining contexts, including a failure that the
          // first (capped) page didn't contain.
          return {
            repository: {
              pullRequest: {
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          contexts: {
                            nodes: [
                              ctx({ id: '2', name: 'b', conclusion: 'SUCCESS' }),
                              ctx({ id: '3', name: 'c', conclusion: 'FAILURE' }),
                            ],
                            pageInfo: { hasNextPage: false, endCursor: null },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          } as never;
        }
        // Page 1 (the batch query): one passing check + "more to come".
        return {
          repository: {
            [aliasForBranch(0)]: {
              nodes: [
                {
                  number: 42,
                  title: 'big',
                  body: '',
                  url: 'https://github.com/acme/widgets/pull/42',
                  isDraft: false,
                  state: 'OPEN',
                  mergedAt: null,
                  closedAt: null,
                  updatedAt: '2026-01-01T00:00:00Z',
                  mergeable: 'MERGEABLE',
                  mergeStateStatus: 'CLEAN',
                  reviewDecision: 'APPROVED',
                  author: { login: 'alice' },
                  headRefName: 'feature/x',
                  baseRefName: 'main',
                  headRefOid: 'abc',
                  reviews: { nodes: [] },
                  reviewThreads: { nodes: [] },
                  comments: { nodes: [] },
                  commits: {
                    nodes: [
                      {
                        commit: {
                          statusCheckRollup: {
                            state: 'FAILURE',
                            contexts: {
                              nodes: [ctx({ id: '1', name: 'a', conclusion: 'SUCCESS' })],
                              pageInfo: { hasNextPage: true, endCursor: 'C1' },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        } as never;
      });

    const out = await batchPullRequests({
      workspaceId: 'ws1',
      owner: 'acme',
      repo: 'widgets',
      branches: ['feature/x'],
    });

    // One batch query + one follow-up contexts page.
    expect(spy).toHaveBeenCalledTimes(2);
    const pr = out[0].pr!;
    expect(pr.checks.total).toBe(3);
    expect(pr.checks.passed).toBe(2);
    expect(pr.checks.failed).toBe(1);
    // The failure lived past the first page — the blocking reason must
    // reflect it rather than reading green.
    expect(pr.blockingReason).toBe('checks_failed');
  });

  it('limits in-flight queries to 3 even when more chunks exist', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(githubService, 'executeGraphql').mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield to the event loop so the runner can hand work to siblings.
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { repository: {} } as never;
    });
    // 50 branches → 10 chunks of 5 each.
    const branches = Array.from({ length: 50 }, (_, i) => `b/${i}`);
    await batchPullRequests({
      workspaceId: 'ws1',
      owner: 'acme',
      repo: 'widgets',
      branches,
    });
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('decodeReviewDetail', () => {
  function resp(over: {
    reviews?: unknown[];
    threads?: unknown[];
    comments?: unknown[];
  } = {}) {
    return {
      repository: {
        pullRequest: {
          reviews: { nodes: over.reviews ?? [] },
          reviewThreads: { nodes: over.threads ?? [] },
          comments: { nodes: over.comments ?? [] },
        },
      },
    } as Parameters<typeof decodeReviewDetail>[0];
  }

  it('returns empty arrays when the PR is missing', () => {
    const out = decodeReviewDetail({ repository: null } as Parameters<typeof decodeReviewDetail>[0]);
    expect(out).toEqual({ reviews: [], threads: [], comments: [] });
  });

  it('drops PENDING reviews and bodyless COMMENTED reviews, keeps the rest', () => {
    const out = decodeReviewDetail(
      resp({
        reviews: [
          { id: 'r1', author: { login: 'a', avatarUrl: null }, state: 'PENDING', body: 'x', submittedAt: '2026-01-01T00:00:00Z', url: 'u1' },
          { id: 'r2', author: { login: 'b', avatarUrl: null }, state: 'COMMENTED', body: '   ', submittedAt: '2026-01-02T00:00:00Z', url: 'u2' },
          { id: 'r3', author: { login: 'c', avatarUrl: null }, state: 'COMMENTED', body: 'real comment', submittedAt: '2026-01-03T00:00:00Z', url: 'u3' },
          { id: 'r4', author: { login: 'd', avatarUrl: null }, state: 'APPROVED', body: '', submittedAt: '2026-01-04T00:00:00Z', url: 'u4' },
        ],
      })
    );
    expect(out.reviews.map((r) => r.id)).toEqual(['r3', 'r4']);
  });

  it('sorts reviews oldest-first by submittedAt', () => {
    const out = decodeReviewDetail(
      resp({
        reviews: [
          { id: 'late', author: { login: 'a', avatarUrl: null }, state: 'APPROVED', body: '', submittedAt: '2026-02-01T00:00:00Z', url: 'u' },
          { id: 'early', author: { login: 'b', avatarUrl: null }, state: 'APPROVED', body: '', submittedAt: '2026-01-01T00:00:00Z', url: 'u' },
        ],
      })
    );
    expect(out.reviews.map((r) => r.id)).toEqual(['early', 'late']);
  });

  it('orders threads unresolved-first and pulls diffHunk from the first comment', () => {
    const out = decodeReviewDetail(
      resp({
        threads: [
          {
            id: 'resolved',
            isResolved: true,
            isOutdated: false,
            path: 'a.ts',
            line: 1,
            comments: { nodes: [{ id: 'c1', author: { login: 'a', avatarUrl: null }, body: 'b', diffHunk: '@@ -1 +1 @@', createdAt: '2026-01-01T00:00:00Z', url: 'u' }] },
          },
          {
            id: 'open',
            isResolved: false,
            isOutdated: true,
            path: 'b.ts',
            line: 2,
            comments: { nodes: [{ id: 'c2', author: { login: 'a', avatarUrl: null }, body: 'b', diffHunk: '@@ -2 +2 @@', createdAt: '2026-01-02T00:00:00Z', url: 'u' }] },
          },
          {
            id: 'empty',
            isResolved: false,
            isOutdated: false,
            path: 'c.ts',
            line: 3,
            comments: { nodes: [] },
          },
        ],
      })
    );
    expect(out.threads.map((t) => t.id)).toEqual(['open', 'resolved']);
    expect(out.threads[0].diffHunk).toBe('@@ -2 +2 @@');
  });

  it('sorts conversation comments oldest-first', () => {
    const out = decodeReviewDetail(
      resp({
        comments: [
          { id: 'late', author: { login: 'a', avatarUrl: null }, body: 'b', createdAt: '2026-03-01T00:00:00Z', url: 'u' },
          { id: 'early', author: { login: 'a', avatarUrl: null }, body: 'b', createdAt: '2026-01-01T00:00:00Z', url: 'u' },
        ],
      })
    );
    expect(out.comments.map((c) => c.id)).toEqual(['early', 'late']);
  });
});
