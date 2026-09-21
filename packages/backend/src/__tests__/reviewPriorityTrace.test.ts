import { describe, expect, it } from 'vitest';
import {
  scorePRForReview,
  replayPRPriorityTrace,
  type PRPriorityTarget,
  type ReviewRankProfile,
} from '@talyn/shared';

const now = Date.parse('2026-09-21T12:00:00Z');
const profile: ReviewRankProfile = {
  authorAffinity: { 'private-author': { gave: 50, got: 20 } },
  dirAffinity: { 'private-path': 30 },
  repoAffinity: { 'private/repo': 20 },
  teamAffinity: { 'private/team': { gave: 10, got: 20 } },
  featureStats: { mean: [1, 2, 3, 4, 5, 6], sd: [2, 3, 4, 5, 6, 7] },
  model: {
    installed: true, nEvents: 500, weights: [1, 2, 3, 4, 5, -1],
    cvAccuracy: 0.8, baselineAccuracy: 0.5,
  },
};
const row: PRPriorityTarget = {
  id: 'candidate', owner: 'private', repo: 'repo', taskId: 'private-task',
  reviewRequestedFirstSeenAt: '2026-09-15T12:00:00Z',
  summary: {
    author: 'private-author', topDirs: ['private-path'],
    createdAt: '2026-09-01T00:00:00Z', additions: 30, deletions: 10,
    reviewRequestVia: { direct: false, teams: ['private/team'] },
  },
};

describe('production scoring traces', () => {
  it.each([
    {},
    { draft: true },
    { mergeable: 'CONFLICTING' },
    { blockingReason: 'checks_failed' },
    { effectiveReviewDecision: 'CHANGES_REQUESTED' },
    { effectiveReviewDecision: 'APPROVED' },
    { autoMergeBy: 'private-author', reviewDecision: 'REVIEW_REQUIRED' },
    { stack: { size: 8, position: 1 } },
    { checks: { total: 4, passed: 2, failed: 0, inProgress: 2, skipped: 0 } },
    { unresolvedHumanReviewThreads: 3, unresolvedThreadsOpenedByViewer: 2 },
    { viewerLatestReview: { state: 'CHANGES_REQUESTED', submittedAt: null } },
    { author: 'private-author[bot]' },
    { additions: undefined, deletions: undefined },
  ])('replays gates, caps, and state terms exactly: %j', (changes) => {
    const target = { ...row, summary: { ...row.summary, ...changes } };
    for (const active of [false, true]) {
      for (const selectedProfile of [null, profile, { ...profile, featureStats: null }]) {
        const context = { now, profile: selectedProfile, isTaskActive: () => active };
        const expected = scorePRForReview(target, context);
        const recorded = scorePRForReview(target, {
          ...context, captureTrace: { source: 'server', modelVersion: 'a'.repeat(64) },
        });
        const { trace, ...actual } = recorded;
        expect(actual).toEqual(expected);
        expect(replayPRPriorityTrace(JSON.parse(JSON.stringify(trace)))).toEqual(expected);
        const text = JSON.stringify(trace);
        for (const secret of ['private-author', 'private-path', 'private/team', 'private-task', 'private/repo']) {
          expect(text).not.toContain(secret);
        }
      }
    }
  });

  it('retains the original inputs after rows and profiles change', () => {
    const target = structuredClone(row);
    const selectedProfile = structuredClone(profile);
    const { trace, ...expected } = scorePRForReview(target, {
      now, profile: selectedProfile, captureTrace: { source: 'client' },
    });
    target.summary.additions = 5000;
    target.summary.reviewRequestVia!.direct = true;
    selectedProfile.featureStats!.mean[0] = 1000;
    selectedProfile.model!.weights[0] = 0;
    expect(replayPRPriorityTrace(trace!)).toEqual(expected);
  });

  it.each(['version', 'clock', 'weights', 'features', 'stats'])('rejects invalid replay inputs: %s', (fault) => {
    const trace = scorePRForReview(row, { now, profile, captureTrace: { source: 'server' } }).trace!;
    if (fault === 'version') trace.scorerVersion = 'unknown';
    if (fault === 'clock') trace.scoredAt = NaN;
    if (fault === 'weights') trace.rankInputs!.weights.pop();
    if (fault === 'features') trace.rankInputs!.features[0] = Infinity;
    if (fault === 'stats') trace.rankInputs!.stats!.mean.pop();
    expect(() => replayPRPriorityTrace(trace)).toThrow();
  });
});
