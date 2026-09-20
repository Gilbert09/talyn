import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { REVIEW_RANK_MIN_EVENTS } from '@talyn/shared';
import {
  MAX_CHOICE_SET,
  buildPairs,
  buildProfile,
  readReviewRankPayload,
  trainReviewRank,
  type TrainingRow,
} from '../services/reviewPriority/trainer.js';
import { shouldRetrain, RETRAIN_EVENT_DELTA } from '../services/reviewPriority/sweep.js';
import { topDirsOf } from '../services/githubGraphql.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  reviewHistory as reviewHistoryTable,
} from '../db/schema.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (h: number) => new Date(T0 + h * 3_600_000);

function histRow(over: Partial<TrainingRow> = {}): TrainingRow {
  return {
    repoFullName: 'acme/widgets',
    prNumber: 1,
    authorLogin: 'sarah',
    requestedAt: at(0),
    reviewedAt: at(1),
    closedAt: at(2),
    additions: 50,
    deletions: 10,
    dirs: ['src/api'],
    ...over,
  };
}

describe('topDirsOf', () => {
  it('keeps two path segments, because one collapses a monorepo', () => {
    // `packages/backend` and `packages/shared` are different places to a
    // reviewer. Truncating to `packages` would make every PR in this very
    // repository look identical on the familiarity feature.
    expect(topDirsOf(['packages/backend/src/a.ts', 'packages/shared/src/b.ts'])).toEqual([
      'packages/backend',
      'packages/shared',
    ]);
  });

  it('gives a root-level file its own bucket rather than dropping it', () => {
    // A change to package.json or a Dockerfile is a real and recognisable kind
    // of PR, not an absence of directories.
    expect(topDirsOf(['package.json'])).toEqual(['/']);
  });

  it('drops the FILENAME, so sibling files share a bucket', () => {
    // Slicing two segments off the raw path leaves `src/a.ts` — a file, not a
    // directory — and then no two PRs ever share a bucket unless they touch the
    // identical file. The familiarity feature would be permanently zero, and
    // silently so.
    expect(topDirsOf(['src/a.ts', 'src/b.ts', 'src/c.ts'])).toEqual(['src']);
    expect(topDirsOf(['packages/backend/src/deep/a.ts'])).toEqual(['packages/backend']);
  });

  it('de-duplicates and caps', () => {
    expect(topDirsOf(Array.from({ length: 50 }, (_, i) => `d${i}/f.ts`)).length).toBe(8);
  });

  it('returns nothing for no paths', () => {
    expect(topDirsOf([])).toEqual([]);
  });
});

describe('buildProfile', () => {
  it('counts a review performed as "gave", and every request as "got"', () => {
    const p = buildProfile([
      histRow({ prNumber: 1, authorLogin: 'sarah', reviewedAt: at(1) }),
      histRow({ prNumber: 2, authorLogin: 'sarah', reviewedAt: null }),
    ]);
    expect(p.authorAffinity.sarah).toEqual({ gave: 1, got: 2 });
  });

  it('counts the DENOMINATOR, which is what makes affinity a rate', () => {
    // Built only from reviews performed it would say "you review the people you
    // review" — true, and useless for ranking.
    const p = buildProfile([
      histRow({ prNumber: 1, authorLogin: 'eager', reviewedAt: at(1) }),
      histRow({ prNumber: 2, authorLogin: 'ignored', reviewedAt: null }),
      histRow({ prNumber: 3, authorLogin: 'ignored', reviewedAt: null }),
    ]);
    expect(p.authorAffinity.eager.got).toBe(1);
    expect(p.authorAffinity.ignored.gave).toBe(0);
    expect(p.authorAffinity.ignored.got).toBe(2);
  });

  it('credits directories only for reviews ACTUALLY performed', () => {
    // A PR you were asked about and ignored taught you nothing about its files.
    // Counting it would make "familiar with" mean "adjacent to".
    const p = buildProfile([
      histRow({ prNumber: 1, dirs: ['src/read'], reviewedAt: at(1) }),
      histRow({ prNumber: 2, dirs: ['src/ignored'], reviewedAt: null }),
    ]);
    expect(p.dirAffinity['src/read']).toBe(1);
    expect(p.dirAffinity['src/ignored']).toBeUndefined();
  });

  it('expresses repo affinity as a share that sums to one', () => {
    const p = buildProfile([
      histRow({ prNumber: 1, repoFullName: 'acme/a', reviewedAt: at(1) }),
      histRow({ prNumber: 2, repoFullName: 'acme/a', reviewedAt: at(1) }),
      histRow({ prNumber: 3, repoFullName: 'acme/b', reviewedAt: at(1) }),
    ]);
    expect(p.repoAffinity['acme/a']).toBeCloseTo(2 / 3, 6);
    expect(Object.values(p.repoAffinity).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it('lowercases logins and repos so casing cannot split a person in two', () => {
    const p = buildProfile([histRow({ authorLogin: 'SaRaH', repoFullName: 'ACME/Widgets' })]);
    expect(p.authorAffinity.sarah).toBeDefined();
    expect(p.repoAffinity['acme/widgets']).toBeDefined();
  });

  it('survives a history with no reviews at all', () => {
    const p = buildProfile([histRow({ reviewedAt: null })]);
    expect(Object.values(p.repoAffinity).every((v) => v === 0)).toBe(true);
  });
});

describe('buildPairs — the choice set', () => {
  const profile = { authorAffinity: {}, dirAffinity: {}, repoAffinity: {} };

  it('pairs a reviewed PR against everything pending at that instant', () => {
    const rows = [
      histRow({ prNumber: 1, requestedAt: at(0), reviewedAt: at(5), closedAt: at(6) }),
      histRow({ prNumber: 2, requestedAt: at(1), reviewedAt: null, closedAt: at(20) }),
      histRow({ prNumber: 3, requestedAt: at(2), reviewedAt: null, closedAt: at(20) }),
    ];
    const { pairs, nEvents } = buildPairs(rows, profile);
    expect(nEvents).toBe(1);
    expect(pairs).toHaveLength(2);
  });

  it('excludes a PR that had not been requested yet — the opportunity rule', () => {
    // Gmail's constraint, satisfied structurally rather than by heuristic: a PR
    // is only a negative because it was demonstrably in front of the viewer and
    // passed over. Nothing they had not yet been asked about can be penalised.
    const rows = [
      histRow({ prNumber: 1, requestedAt: at(0), reviewedAt: at(5) }),
      histRow({ prNumber: 2, requestedAt: at(10), reviewedAt: null, closedAt: at(20) }),
    ];
    expect(buildPairs(rows, profile).pairs).toHaveLength(0);
  });

  it('excludes a PR already reviewed by then', () => {
    const rows = [
      histRow({ prNumber: 1, requestedAt: at(0), reviewedAt: at(5) }),
      histRow({ prNumber: 2, requestedAt: at(0), reviewedAt: at(1) }),
    ];
    // #2 was answered at hour 1, so it was not an alternative at hour 5.
    const forFive = buildPairs(rows, profile).pairs.filter(() => true);
    // One event each way: #2's own review at hour 1 sees #1 pending, but #1's
    // at hour 5 does not see #2.
    expect(forFive).toHaveLength(1);
  });

  it('excludes a PR that had already closed', () => {
    const rows = [
      histRow({ prNumber: 1, requestedAt: at(0), reviewedAt: at(5) }),
      histRow({ prNumber: 2, requestedAt: at(0), reviewedAt: null, closedAt: at(2) }),
    ];
    expect(buildPairs(rows, profile).pairs).toHaveLength(0);
  });

  it('caps one decision’s contribution', () => {
    // A reviewer with sixty standing requests who reviews one would otherwise
    // produce fifty-nine pairs from a single decision, letting their busiest
    // week outvote every other week combined.
    const rows: TrainingRow[] = [
      histRow({ prNumber: 0, requestedAt: at(0), reviewedAt: at(50) }),
      ...Array.from({ length: 40 }, (_, i) =>
        histRow({ prNumber: i + 1, requestedAt: at(1), reviewedAt: null, closedAt: at(100) }),
      ),
    ];
    expect(buildPairs(rows, profile).pairs).toHaveLength(MAX_CHOICE_SET);
  });

  it('counts EVENTS, not pairs', () => {
    // The pairs from one decision are one choice seen from several angles.
    // Counting them would inflate the parameter budget fourfold.
    const rows = [
      histRow({ prNumber: 1, requestedAt: at(0), reviewedAt: at(5) }),
      histRow({ prNumber: 2, requestedAt: at(0), reviewedAt: null, closedAt: at(20) }),
      histRow({ prNumber: 3, requestedAt: at(0), reviewedAt: null, closedAt: at(20) }),
    ];
    const { pairs, nEvents } = buildPairs(rows, profile);
    expect(pairs.length).toBeGreaterThan(nEvents);
    expect(nEvents).toBe(1);
  });

  it('gives every pair from one decision the same fold key', () => {
    const rows = [
      histRow({ prNumber: 1, requestedAt: at(0), reviewedAt: at(5) }),
      histRow({ prNumber: 2, requestedAt: at(0), reviewedAt: null, closedAt: at(20) }),
      histRow({ prNumber: 3, requestedAt: at(0), reviewedAt: null, closedAt: at(20) }),
    ];
    const keys = new Set(buildPairs(rows, profile).pairs.map((p) => p.eventKey));
    expect(keys.size).toBe(1);
  });

  it('never pairs a PR against itself', () => {
    const rows = [histRow({ prNumber: 1, requestedAt: at(0), reviewedAt: at(5) })];
    expect(buildPairs(rows, profile).pairs).toHaveLength(0);
  });

  it('ignores rows with no request time at all', () => {
    const rows = [
      histRow({ prNumber: 1, requestedAt: null, reviewedAt: at(5) }),
      histRow({ prNumber: 2, requestedAt: null, reviewedAt: null }),
    ];
    expect(buildPairs(rows, profile).nEvents).toBe(0);
  });
});

describe('shouldRetrain', () => {
  const now = Date.parse('2026-09-21T00:00:00Z');

  it('trains when nothing has ever been fitted', () => {
    expect(shouldRetrain(null, 0, 0, now)).toBe(true);
  });

  it('trains once the history has grown enough', () => {
    const yesterday = new Date(now - 24 * 3_600_000);
    expect(shouldRetrain(yesterday, 100, 100 + RETRAIN_EVENT_DELTA, now)).toBe(true);
    expect(shouldRetrain(yesterday, 100, 101, now)).toBe(false);
  });

  it('trains on age alone, so a quiet month still refreshes', () => {
    const longAgo = new Date(now - 30 * 24 * 3_600_000);
    expect(shouldRetrain(longAgo, 100, 100, now)).toBe(true);
  });
});

describe('trainReviewRank — end to end', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
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
    vi.restoreAllMocks();
  });

  async function seedHistory(n: number, reviewedEvery = 2) {
    await db.insert(reviewHistoryTable).values(
      Array.from({ length: n }, (_, i) => ({
        workspaceId: 'ws1',
        viewerLogin: 'me',
        repoFullName: 'acme/widgets',
        prNumber: i + 1,
        authorLogin: i % 3 === 0 ? 'sarah' : 'raj',
        requestedAt: at(i),
        reviewedAt: i % reviewedEvery === 0 ? at(i + 0.5) : null,
        closedAt: at(i + 10),
        direct: i % 2 === 0,
        additions: 10 + i,
        deletions: 5,
        dirs: i % 2 === 0 ? ['src/api'] : ['src/ui'],
      })),
    );
  }

  it('stores a REFUSAL, with its numbers, when there is too little history', async () => {
    // "We looked and it was not worth it" is a fact with evidence. An absent row
    // would be indistinguishable from a trainer that never ran, which is the
    // one thing we must be able to tell apart later.
    await seedHistory(20);
    const result = await trainReviewRank('ws1', 'me');
    expect(result.installed).toBe(false);
    expect(result.refusedBecause).toBe('too_few_events');

    const payload = await readReviewRankPayload('ws1', 'me');
    expect(payload.model?.installed).toBe(false);
    expect(payload.nEvents).toBeGreaterThan(0);
  });

  it('stores the aggregates even when the fit is refused', async () => {
    // The whole point of the shipped prior: a viewer with no model still gets
    // ranked on who they actually review.
    await seedHistory(20);
    await trainReviewRank('ws1', 'me');
    const payload = await readReviewRankPayload('ws1', 'me');
    expect(Object.keys(payload.authorAffinity).length).toBeGreaterThan(0);
    expect(payload.featureStats).not.toBeNull();
  });

  it('reports how many more reviews are needed', async () => {
    await seedHistory(20);
    await trainReviewRank('ws1', 'me');
    const payload = await readReviewRankPayload('ws1', 'me');
    expect(payload.eventsUntilPersonalized).toBe(REVIEW_RANK_MIN_EVENTS - payload.nEvents);
  });

  it('is idempotent — a second run replaces rather than duplicates', async () => {
    await seedHistory(20);
    await trainReviewRank('ws1', 'me');
    await trainReviewRank('ws1', 'me');
    const payload = await readReviewRankPayload('ws1', 'me');
    expect(payload.nEvents).toBeGreaterThan(0);
  });

  it('answers a serving-the-prior shape for a viewer with no row at all', async () => {
    // One shape for the client to handle. "No model yet" is a normal state, not
    // an error — the ordering works without one.
    const payload = await readReviewRankPayload('ws1', 'nobody');
    expect(payload.model).toBeNull();
    expect(payload.nEvents).toBe(0);
    expect(payload.eventsUntilPersonalized).toBe(REVIEW_RANK_MIN_EVENTS);
  });

  it('keeps one viewer’s history out of another’s model', async () => {
    // Per VIEWER, not per workspace: two people in one workspace have entirely
    // different habits, and averaging them describes neither.
    await seedHistory(20);
    await trainReviewRank('ws1', 'me');
    const other = await readReviewRankPayload('ws1', 'someone-else');
    expect(other.nEvents).toBe(0);
  });
});
