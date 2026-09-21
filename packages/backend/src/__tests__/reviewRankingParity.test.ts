import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scorePRForReview, reviewRankingCandidate, type ReviewRankingRow } from '@talyn/shared';

const now = Date.parse('2026-09-21T12:00:00Z');

function fixture() {
  const rows: ReviewRankingRow[] = [
    { id: 'older', summary: { createdAt: '2026-09-01T00:00:00Z' } },
    { id: 'a', summary: { createdAt: '2026-09-02T00:00:00Z' } },
    { id: 'b', summary: { createdAt: '2026-09-02T00:00:00Z' } },
    { id: 'draft', summary: { draft: true, createdAt: '2026-08-01T00:00:00Z' } },
  ].map((row, index) => ({
    ...row, workspaceId: 'workspace', owner: 'org', repo: 'repo', number: index + 1,
    reviewRequestedFirstSeenAt: new Date(now).toISOString(),
  }));
  for (const row of rows) row.priority = scorePRForReview(row, {
    now, captureTrace: { source: row.id === 'a' ? 'client' : 'server', modelVersion: 'a'.repeat(64) },
  });
  const context = {
    workspaceId: 'workspace', viewerLogin: 'viewer', sortMode: 'priority' as const,
    filterKey: '', filtered: false, profile: null,
  };
  return { snapshot_id: 'snapshot', at: now / 1000, sort_mode: 'priority',
    candidates: rows.map((row, index) => reviewRankingCandidate(row, index + 1, context)) };
}

function replay(snapshot: ReturnType<typeof fixture>) {
  const process = spawnSync(globalThis.process.execPath, [
    resolve(__dirname, '../../../../scripts/review-ranking/production-parity.mjs'),
  ], { input: JSON.stringify([snapshot]), encoding: 'utf8', timeout: 10_000 });
  expect(process.error).toBeUndefined();
  expect(process.status, process.stderr).toBe(0);
  return JSON.parse(process.stdout);
}

describe('production parity command', () => {
  it('uses the built serving scorer, gates, older-first ties, and identity ties', () => {
    const result = replay(fixture());
    expect(result.all_passed).toBe(true);
    expect(result.runtime_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.snapshots[0].order_checked).toBe(true);
  });

  it.each([
    ['score', 'score_mismatch'], ['gate', 'score_mismatch'], ['order', 'order_mismatch'],
    ['missing', 'missing_trace'], ['future', 'invalid_trace'], ['model', 'invalid_trace'],
    ['target', 'invalid_trace'], ['version', 'invalid_trace'], ['empty', 'empty_queue'],
  ])('rejects %s errors', (fault, failure) => {
    const snapshot = fixture();
    const candidate = snapshot.candidates[0];
    if (fault === 'score') candidate.score! += 1;
    if (fault === 'gate') candidate.gate = 'not_ready';
    if (fault === 'order') snapshot.candidates.reverse();
    if (fault === 'missing') candidate.priority_trace = null;
    if (fault === 'future') candidate.priority_trace!.scoredAt += 1;
    if (fault === 'model') candidate.priority_trace!.modelVersion = null;
    if (fault === 'target') candidate.priority_trace!.target.id = 'other';
    if (fault === 'version') candidate.priority_trace!.scorerVersion = 'unknown';
    if (fault === 'empty') snapshot.candidates = [];
    const result = replay(snapshot);
    expect(result.all_passed).toBe(false);
    expect(result.snapshots[0].failures).toContain(failure);
  });

  it('does not claim to check Priority order for another display mode', () => {
    const snapshot = fixture();
    snapshot.sort_mode = 'newest';
    snapshot.candidates.reverse();
    const result = replay(snapshot);
    expect(result.all_passed).toBe(true);
    expect(result.snapshots[0].order_checked).toBe(false);
  });
});
