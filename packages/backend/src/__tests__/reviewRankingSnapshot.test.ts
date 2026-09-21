import { describe, expect, it, vi } from 'vitest';
import {
  appendReviewRankingLog,
  readReviewRankingLog,
  REVIEW_RANKING_LOG_MAX_CHARS,
  ReviewRankingRecorder,
  scorePRForReview,
  type ReviewRankingContext,
  type ReviewRankingRow,
} from '@talyn/shared';

const now = Date.parse('2026-09-21T12:00:00Z');
const context: ReviewRankingContext = {
  workspaceId: 'workspace', viewerLogin: 'viewer', sortMode: 'newest',
  filterKey: 'private search', filtered: false, profile: null,
};
const rows = (count: number): ReviewRankingRow[] => Array.from({ length: count }, (_, i) => ({
  id: `pr-${i}`, workspaceId: 'workspace', owner: 'org', repo: 'repo', number: i + 1,
  summary: { author: 'private-author', headSha: 'head', topDirs: ['private-path'] },
}));

describe('prospective review snapshots', () => {
  it.each([
    [undefined, null],
    [{ direct: true, teams: [] }, []],
    [{ direct: false, teams: ['Org/Z', 'org/a', 'org/z'] }, ['org/a', 'org/z']],
  ])('records observed teams without inferring missing membership', (via, expected) => {
    const capture = vi.fn();
    const queue = rows(1);
    queue[0].summary.reviewRequestVia = via;
    new ReviewRankingRecorder(capture, () => 'snapshot').record(queue, context, now);
    expect(capture.mock.calls[0][1].candidates[0]).toMatchObject({
      requested_teams: expected, requested_team_count: expected?.length ?? null,
    });
  });

  it('refreshes when matched teams change with the same count', () => {
    const capture = vi.fn();
    const queue = rows(1);
    queue[0].summary.reviewRequestVia = { direct: false, teams: ['org/one'] };
    const recorder = new ReviewRankingRecorder(capture, () => 'snapshot');
    recorder.record(queue, context, now);
    queue[0].summary.reviewRequestVia.teams = ['org/two'];
    recorder.record(queue, context, now + 1);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[0][1].candidates[0].requested_teams).toEqual(['org/one']);
  });

  it('rejects stale rows during a workspace switch', () => {
    const capture = vi.fn();
    const recorder = new ReviewRankingRecorder(capture, () => 'snapshot');
    expect(() => recorder.record(rows(1), { ...context, workspaceId: 'other' }, now)).toThrow();
    expect(capture).not.toHaveBeenCalled();
  });
  it.each([0, 1, 25, 26, 103])('records all %i candidates in bounded chunks', (count) => {
    const capture = vi.fn();
    const recorder = new ReviewRankingRecorder(capture, () => 'snapshot');
    recorder.record(rows(count), context, now);
    expect(capture).toHaveBeenCalledTimes(Math.max(1, Math.ceil(count / 25)));
    const chunks = capture.mock.calls.map((call) => call[1]);
    expect(chunks.flatMap((chunk) => chunk.candidates)).toHaveLength(count);
    expect(chunks.every((chunk) => chunk.candidates.length <= 25)).toBe(true);
    expect(chunks[0]).toMatchObject({ candidate_count: count, recorded_at: new Date(now).toISOString() });
    const text = JSON.stringify(chunks);
    for (const secret of ['private-author', 'private-path', 'private search']) {
      expect(text).not.toContain(secret);
    }
    if (count) expect(chunks[0].candidates[0]).toMatchObject({
      displayed_rank: 1, head_sha: 'head', request_first_seen_at: null, affinity_features: null,
    });
  });

  it('refreshes on order, filters, revisions, and five minutes', () => {
    const capture = vi.fn();
    const recorder = new ReviewRankingRecorder(capture, () => 'snapshot');
    const queue = rows(2);
    recorder.record(queue, context, now);
    recorder.record(queue, context, now + 1);
    expect(capture).toHaveBeenCalledTimes(1);
    recorder.record([...queue].reverse(), context, now + 2);
    recorder.record(queue, { ...context, filterKey: 'new' }, now + 3);
    recorder.record(queue, context, now + 4);
    queue[0].summary.headSha = 'new-head';
    recorder.record(queue, context, now + 5);
    recorder.record(queue, context, now + 300_005);
    expect(capture).toHaveBeenCalledTimes(6);
  });

  it('keeps eligibility, exposure, and opens separate', () => {
    const capture = vi.fn();
    const recorder = new ReviewRankingRecorder(capture, () => 'snapshot');
    recorder.observe(['pr-0'], now);
    recorder.open('pr-0', now);
    expect(capture).not.toHaveBeenCalled();
    recorder.record(rows(2), context, now);
    recorder.observe(['pr-0', 'pr-0', 'absent'], now + 1);
    recorder.observe(['pr-0'], now + 2);
    recorder.open('absent', now + 3);
    recorder.open('pr-1', now + 4);
    expect(capture).toHaveBeenCalledTimes(3);
    expect(capture.mock.calls[1][1].pr_ids).toEqual(['pr-0']);
    expect(capture.mock.calls[2]).toEqual(['pr_review_candidate_opened', expect.objectContaining({
      snapshot_id: 'snapshot', pr_id: 'pr-1', rank: 2,
    })]);
  });

  it('records the actual server inputs when the client profile disagrees', () => {
    const capture = vi.fn();
    const recorder = new ReviewRankingRecorder(capture, () => 'snapshot');
    const queue = rows(1);
    queue[0].priority = scorePRForReview(queue[0], {
      now, captureTrace: { source: 'server', modelVersion: 'a'.repeat(64) },
    });
    recorder.record(queue, {
      ...context,
      repositoryScope: ['Org/Repo', 'org/repo', 'org/empty'],
      profile: {
        authorAffinity: { 'private-author': { gave: 100, got: 10 } },
        dirAffinity: {}, repoAffinity: {}, teamAffinity: {}, featureStats: null, model: null,
      },
    }, now);
    expect(capture.mock.calls[0][1]).toMatchObject({
      model_source: 'scoring_trace', repository_scope: ['org/empty', 'org/repo'],
      candidates: [{ affinity_features: null, affinity_features_source: 'server',
        priority_trace: { source: 'server', rankInputs: null, scoredAt: now } }],
    });
  });

  it('refreshes on scope changes but not an unchanged score clock', () => {
    const capture = vi.fn();
    const recorder = new ReviewRankingRecorder(capture, () => 'snapshot');
    const queue = rows(1);
    queue[0].priority = scorePRForReview(queue[0], { now, captureTrace: { source: 'client' } });
    recorder.record(queue, { ...context, repositoryScope: ['org/repo'] }, now);
    queue[0].priority.trace!.scoredAt += 1;
    recorder.record(queue, { ...context, repositoryScope: ['org/repo'] }, now + 1);
    expect(capture).toHaveBeenCalledTimes(1);
    recorder.record(queue, { ...context, repositoryScope: ['org/repo', 'org/other'] }, now + 2);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[1][1].candidates[0].priority_trace.scoredAt).toBe(now + 1);
  });
});

describe('local review log', () => {
  function storage() {
    const values = new Map<string, string>();
    return { values, getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } };
  }
  const properties = (snapshot: string, extra = {}) => ({
    workspace_id: 'workspace', snapshot_id: snapshot, ...extra,
  });

  it('isolates workspaces and removes expired events on the next write', () => {
    const store = storage();
    appendReviewRankingLog(store, 'queue', properties('old'), now - 7 * 86_400_000);
    appendReviewRankingLog(store, 'queue', properties('fresh'), now);
    appendReviewRankingLog(store, 'queue', properties('other', { workspace_id: 'other' }), now);
    expect(readReviewRankingLog(store, 'workspace', now).map((e) => e.properties.snapshot_id)).toEqual(['fresh']);
    expect(readReviewRankingLog(store, 'other', now)).toHaveLength(1);
    expect([...store.values.values()].join('')).not.toContain('"old"');
  });

  it('evicts whole snapshots when the size limit is reached', () => {
    const store = storage();
    const payload = 'x'.repeat(REVIEW_RANKING_LOG_MAX_CHARS / 2);
    appendReviewRankingLog(store, 'queue', properties('one', { payload }), now);
    appendReviewRankingLog(store, 'visible', properties('one'), now);
    appendReviewRankingLog(store, 'queue', properties('two', { payload }), now);
    const log = readReviewRankingLog(store, 'workspace', now);
    expect(log).toHaveLength(1);
    expect(log[0].properties.snapshot_id).toBe('two');
    expect(JSON.stringify(log).length).toBeLessThanOrEqual(REVIEW_RANKING_LOG_MAX_CHARS);
  });

  it.each(['null', '{}', '{broken', '[null, 3, {}]'])('tolerates corrupt storage: %s', (value) => {
    const store = { getItem: () => value, setItem: vi.fn() };
    expect(readReviewRankingLog(store, 'workspace', now)).toEqual([]);
    expect(() => appendReviewRankingLog(store, 'queue', properties('one'), now)).not.toThrow();
  });

  it('does not break review actions when storage is full or disabled', () => {
    const fail = () => { throw new Error('disabled'); };
    expect(readReviewRankingLog({ getItem: fail, setItem: fail }, 'workspace', now)).toEqual([]);
    expect(() => appendReviewRankingLog({ getItem: fail, setItem: fail }, 'queue', properties('one'), now)).not.toThrow();
  });
});
