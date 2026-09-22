import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { replayPRPriorityTrace } from '@talyn/shared';
import {
  _resetReviewPriorityCache,
  invalidateReviewRankProfile,
  scoreReviewRows,
  type ScorableRow,
} from '../services/reviewPriority/score.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  tasks as tasksTable,
  reviewRankModels as reviewRankModelsTable,
} from '../db/schema.js';

/**
 * Server-side scoring for the Reviews tab.
 *
 * The ranking moved here so it can change without a desktop release — the
 * shared package is bundled into the app, and the first week of tuning produced
 * four fixes that were all logic rather than configuration.
 */

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

function row(over: Partial<ScorableRow> = {}): ScorableRow {
  return {
    id: 'pr-1',
    owner: 'acme',
    repo: 'widgets',
    taskId: null,
    mergeQueued: false,
    reviewRequested: true,
    reviewRequestedFirstSeenAt: hoursAgo(30),
    createdAt: hoursAgo(30),
    lastSummary: {
      author: 'sarah',
      draft: false,
      createdAt: hoursAgo(30).toISOString(),
      mergeable: 'MERGEABLE',
      blockingReason: 'mergeable',
      effectiveReviewDecision: 'REVIEW_REQUIRED',
      checks: { total: 8, passed: 8, failed: 0, inProgress: 0, skipped: 0 },
    },
    ...over,
  };
}

describe('scoreReviewRows', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    _resetReviewPriorityCache();
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'ws',
      settings: {},
    });
  });

  afterEach(async () => {
    await cleanup();
    _resetReviewPriorityCache();
    vi.restoreAllMocks();
  });

  it('scores only the review cohort', async () => {
    const out = await scoreReviewRows(db, 'ws1', 'me', [
      row({ id: 'mine', reviewRequested: false }),
      row({ id: 'theirs', reviewRequested: true }),
    ]);
    expect([...out.keys()]).toEqual(['theirs']);
  });

  it('translates the DB row rather than casting it', async () => {
    // The trap this exists for: the column is `last_summary` carrying `Date`s,
    // while the shared scorer speaks `summary` and ISO strings. A cast would
    // compile and then hand the age term a Date it reads as NaN — a silently
    // dead signal, not an error.
    const out = await scoreReviewRows(db, 'ws1', 'me', [row({ id: 'a' })]);
    const verdict = out.get('a');
    expect(verdict?.terms.map((t) => t.reason)).toContain('waited');
    expect(verdict?.terms.map((t) => t.reason)).toContain('checks_green');
  });

  it('prefers the cohort-entry stamp over the open date for age', async () => {
    const old = await scoreReviewRows(db, 'ws1', 'me', [
      row({ id: 'a', createdAt: hoursAgo(500), reviewRequestedFirstSeenAt: hoursAgo(1) }),
    ]);
    // Requested an hour ago: below the ramp's first step, so no wait term.
    expect(old.get('a')?.terms.map((t) => t.reason)).not.toContain('waited');
  });

  it('suppresses a PR whose linked task is still running', async () => {
    await db.insert(tasksTable).values({
      id: 'task-1',
      workspaceId: 'ws1',
      type: 'pr_response',
      status: 'in_progress',
      priority: 'medium',
      title: 't',
      description: 'd',
    });
    const out = await scoreReviewRows(db, 'ws1', 'me', [row({ id: 'a', taskId: 'task-1' })]);
    expect(out.get('a')?.gate).toBe('not_ready');
  });

  it('does not suppress on a task that has finished', async () => {
    await db.insert(tasksTable).values({
      id: 'task-2',
      workspaceId: 'ws1',
      type: 'pr_response',
      status: 'completed',
      priority: 'medium',
      title: 't',
      description: 'd',
    });
    const out = await scoreReviewRows(db, 'ws1', 'me', [row({ id: 'a', taskId: 'task-2' })]);
    expect(out.get('a')?.gate).toBe('actionable');
  });

  it('applies a stored profile, so affinity reaches the server-side score', async () => {
    await db.insert(reviewRankModelsTable).values({
      workspaceId: 'ws1',
      viewerLogin: 'me',
      weights: [1, 0.8, 0.5, 0.3, 0.7, -0.3],
      featureStats: { mean: [0, 0, 0, 0, 0, 0], sd: [1, 1, 1, 1, 1, 1] },
      profile: {
        authorAffinity: { sarah: { gave: 60, got: 60 } },
        teamAffinity: {},
        dirAffinity: {},
        repoAffinity: {},
      },
      nEvents: 400,
      installed: true,
    });
    const out = await scoreReviewRows(db, 'ws1', 'me', [row({ id: 'a' })]);
    expect(out.get('a')?.terms.map((t) => t.reason)).toContain('known_author');
  });

  it('scores without a profile rather than refusing', async () => {
    // A viewer whose history has never been read still gets the deterministic
    // ordering. "No model yet" is a normal state, not an error.
    const out = await scoreReviewRows(db, 'ws1', 'me', [row({ id: 'a' })]);
    expect(out.get('a')).toBeDefined();
    expect(out.get('a')?.terms.map((t) => t.reason)).not.toContain('known_author');
  });

  it('scores with no viewer login at all', async () => {
    const out = await scoreReviewRows(db, 'ws1', null, [row({ id: 'a' })]);
    expect(out.get('a')).toBeDefined();
  });

  it('degrades to an empty map instead of throwing', async () => {
    // This runs while serving the list that paints the Reviews page. A ranking
    // that cannot be computed must cost the ordering, never the page — the
    // client falls back to its own copy of the same function.
    vi.spyOn(db, 'select').mockImplementation(() => {
      throw new Error('boom');
    });
    const out = await scoreReviewRows(db, 'ws1', 'me', [row({ id: 'a' })]);
    expect(out.size).toBe(0);
  });

  it('does no work at all for a list with no review-requested rows', async () => {
    const spy = vi.spyOn(db, 'select');
    const out = await scoreReviewRows(db, 'ws1', 'me', [row({ reviewRequested: false })]);
    expect(out.size).toBe(0);
    // Not even the profile read: an authored-only list must not pay for a
    // ranking nobody is going to look at.
    expect(spy).not.toHaveBeenCalled();
  });

  it('caches the profile, so a list request is not a profile read', async () => {
    await db.insert(reviewRankModelsTable).values({
      workspaceId: 'ws1',
      viewerLogin: 'me',
      profile: { authorAffinity: {}, teamAffinity: {}, dirAffinity: {}, repoAffinity: {} },
      featureStats: { mean: [0, 0, 0, 0, 0, 0], sd: [1, 1, 1, 1, 1, 1] },
    });
    await scoreReviewRows(db, 'ws1', 'me', [row({ id: 'a' })]);
    const spy = vi.spyOn(db, 'select');
    await scoreReviewRows(db, 'ws1', 'me', [row({ id: 'b' })]);
    // Only the task lookup may run — and with no linked task, not even that.
    expect(spy).not.toHaveBeenCalled();
  });

  it('drops the cache when the trainer writes a new profile', async () => {
    await db.insert(reviewRankModelsTable).values({
      workspaceId: 'ws1',
      viewerLogin: 'me',
      profile: { authorAffinity: {}, teamAffinity: {}, dirAffinity: {}, repoAffinity: {} },
      featureStats: { mean: [0, 0, 0, 0, 0, 0], sd: [1, 1, 1, 1, 1, 1] },
    });
    await scoreReviewRows(db, 'ws1', 'me', [row({ id: 'a' })]);
    invalidateReviewRankProfile('ws1', 'me');
    const spy = vi.spyOn(db, 'select');
    await scoreReviewRows(db, 'ws1', 'me', [row({ id: 'b' })]);
    expect(spy).toHaveBeenCalled();
  });

  it('serves the candidate with a reproducible trace and falls back for missing inputs', async () => {
    const scored = await scoreReviewRows(db, 'ws1', 'me', [row()], 'candidate');
    expect(scored.get('pr-1')?.experiment).toMatchObject({ assigned: 'candidate', served: 'candidate', fallback: null });
    const candidate = scored.get('pr-1')!;
    expect(replayPRPriorityTrace(candidate.trace!).score).toBe(candidate.score);
    const missing = await scoreReviewRows(db, 'ws1', 'me', [row({ reviewRequestedFirstSeenAt: null })], 'candidate');
    expect(missing.get('pr-1')?.experiment).toMatchObject({ assigned: 'candidate', served: 'control', fallback: 'missing_or_future_timestamp' });
  });

  it('pins one clock across the whole pass', async () => {
    // A comparator whose inputs were scored at different instants is
    // non-transitive, and V8 returns a scrambled array with no error.
    const out = await scoreReviewRows(db, 'ws1', 'me', [
      row({ id: 'a' }),
      row({ id: 'b' }),
      row({ id: 'c' }),
    ]);
    const waits = [...out.values()].map(
      (v) => v.terms.find((t) => t.reason === 'waited')?.points,
    );
    expect(out.size).toBe(3);
    expect(new Set(waits).size).toBe(1);
    const versions = new Set<string>();
    const clocks = new Set<number>();
    for (const { trace, experiment, ...verdict } of out.values()) {
      expect(trace?.source).toBe('server');
      expect(trace?.modelVersion).toMatch(/^[a-f0-9]{64}$/);
      versions.add(trace!.modelVersion!);
      clocks.add(trace!.scoredAt);
      expect(experiment?.assigned).toBe('control');
      expect(experiment?.baselineScore).toBe(verdict.score);
      expect(replayPRPriorityTrace(trace!)).toEqual(verdict);
    }
    expect(versions.size).toBe(1);
    expect(clocks.size).toBe(1);
  });
  it('excludes hidden PRs from shared queue features and serving', async () => {
    const out = await scoreReviewRows(db, 'ws1', 'me', [
      row({ id: 'visible' }), row({ id: 'hidden', reviewHiddenAt: new Date() }),
    ], 'candidate');
    expect([...out.keys()]).toEqual(['visible']);
    expect(out.get('visible')?.experiment?.features?.[6]).toBe(Math.log1p(1));
  });

});
