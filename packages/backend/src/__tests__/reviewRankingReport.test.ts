import { describe, expect, it } from 'vitest';
import { summarizeRankingExperiment, type RankingReportEvent, type RankingReportOutcome } from '../services/reviewPriority/report.js';

const start = Date.parse('2026-09-22T10:00:00Z');
const at = (ms: number) => new Date(start + ms);
const snapshot = (id: string, session: string, offset = 0, extras = {}): RankingReportEvent => ({
  workspaceId: 'ws', userId: 'user', event: 'pr_review_queue_snapshot', receivedAt: at(offset),
  payload: { snapshot_id: id, session_id: session, session_started_at: at(offset).toISOString(),
    viewer_login: 'viewer', recorded_at: at(offset).toISOString(), sort_mode: 'priority', assigned_arm: 'control',
    filtered: false, candidate_count: 4, chunk_count: 1, chunk_index: 0,
    candidates: [1, 2, 3, 4].map((n) => ({ pr_id: String(n), repo: 'org/repo', pr_number: n, displayed_rank: n })), ...extras },
});
const outcome = (id: string, number = 1, offset = 60000): RankingReportOutcome => ({
  workspaceId: 'ws', viewerLogin: 'viewer', reviewId: id, repo: 'org/repo', prNumber: number,
  createdAt: at(offset), submittedAt: at(offset + 60000),
});

describe('production ranking report', () => {
  it('includes sessions with zero reviews and counts a repeated submission once', () => {
    const report = summarizeRankingExperiment([snapshot('one', 'one'), snapshot('two', 'two', 3600_000)],
      [outcome('review'), outcome('review')], at(2 * 86_400_000));
    expect(report.arms.control).toMatchObject({ matureSessions: 2, sessionsWithoutReviews: 1, completedReviews: 1, macroHit3: 1 });
  });

  it('does not give a later choice a second chance on the same snapshot', () => {
    const report = summarizeRankingExperiment([snapshot('one', 'one')],
      [outcome('outside', 55), outcome('later', 1, 120000)], at(2 * 86_400_000));
    expect(report.arms.control.informativeChoices).toBe(0);
    expect(report.audit.missingCandidate).toBe(1);
  });

  it.each([{ filtered: true }, { chunk_count: 2 }])('censors an older queue when the latest queue is ineligible: %j', (extras) => {
    const report = summarizeRankingExperiment([snapshot('old', 'one'), snapshot('new', 'one', 30000, extras)],
      [outcome('review')], at(2 * 86_400_000));
    expect(report.arms.control.informativeChoices).toBe(0);
  });

  it('keeps unknown review start times out of Hit@3', () => {
    const report = summarizeRankingExperiment([snapshot('one', 'one')],
      [{ ...outcome('review'), createdAt: null }], at(2 * 86_400_000));
    expect(report.audit.unknownReviewStart).toBe(1);
    expect(report.arms.control).toMatchObject({ completedReviews: 1, informativeChoices: 0 });
  });

  it('waits for the complete session outcome window', () => {
    const report = summarizeRankingExperiment([snapshot('one', 'one')], [outcome('review')], at(3600_000));
    expect(report.arms.control.matureSessions).toBe(0);
    expect(report.arms.control.informativeChoices).toBe(0);
  });

  it('excludes sessions whose assignments changed', () => {
    const report = summarizeRankingExperiment([snapshot('old', 'one'), snapshot('new', 'one', 30000, { assigned_arm: 'candidate' })],
      [outcome('review')], at(2 * 86_400_000));
    expect(report.audit.mixedAssignments).toBe(1);
    expect(report.arms.control.matureSessions + report.arms.candidate.matureSessions).toBe(0);
  });
  it('assigns a duplicated outcome to the latest session across workspaces', () => {
    const second = { ...snapshot('two', 'two', 30000), workspaceId: 'ws-two' };
    const report = summarizeRankingExperiment([snapshot('one', 'one'), second],
      [outcome('review'), { ...outcome('review'), workspaceId: 'ws-two' }], at(2 * 86_400_000));
    expect(report.arms.control).toMatchObject({ completedReviews: 1, matureSessions: 2, informativeChoices: 1 });
  });

  it('does not attribute a new incomplete session to an older complete session', () => {
    const report = summarizeRankingExperiment([snapshot('one', 'one'), snapshot('two', 'two', 30000, { chunk_count: 2 })],
      [outcome('review')], at(2 * 86_400_000));
    expect(report.arms.control).toMatchObject({ completedReviews: 0, matureSessions: 1, informativeChoices: 0 });
    expect(report.audit.incompleteSessions).toBe(1);
  });

  it('rejects conflicting copies of a snapshot chunk', () => {
    const report = summarizeRankingExperiment([snapshot('one', 'one'), snapshot('one', 'one', 0, { filtered: true })],
      [outcome('review')], at(2 * 86_400_000));
    expect(report.audit.conflictingChunks).toBe(1);
    expect(report.arms.control.matureSessions).toBe(0);
  });

  it('censors a known choice when another review has unknown timing', () => {
    const report = summarizeRankingExperiment([snapshot('one', 'one')],
      [outcome('known'), { ...outcome('unknown', 4, 120000), createdAt: null }], at(2 * 86_400_000));
    expect(report.arms.control).toMatchObject({ completedReviews: 2, informativeChoices: 0 });
  });

});
