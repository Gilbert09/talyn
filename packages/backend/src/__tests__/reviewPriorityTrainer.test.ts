import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  REVIEW_AFFINITY_HALF_LIFE_DAYS,
  REVIEW_RANK_MIN_EVENTS,
  recencyWeight,
} from '@talyn/shared';
import {
  MAX_CHOICE_SET,
  buildPairs,
  buildProfile,
  readReviewRankPayload,
  trainReviewRank,
  type TrainingRow,
} from '../services/reviewPriority/trainer.js';
import {
  BOOT_DELAY_MS,
  RETRAIN_EVENT_DELTA,
  SWEEP_INTERVAL_MS,
  reviewPrioritySweep,
  shouldRetrain,
} from '../services/reviewPriority/sweep.js';
import { topDirsOf } from '../services/githubGraphql.js';
import { BACKFILL_VERSION, hasBackfilled } from '../services/reviewPriority/backfill.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  reviewHistory as reviewHistoryTable,
  reviewRankModels as reviewRankModelsTable,
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
    teams: [],
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
  /**
   * `buildProfile` is recency-weighted, so a test that does not pin `now` is
   * really testing how long ago its fixtures were written. These fixtures live
   * at T0, so the clock goes just after them.
   */
  const buildProfileAt = (rows: TrainingRow[]) => buildProfile(rows, T0 + 3 * 3_600_000);

  it('counts a review performed as "gave", and every request as "got"', () => {
    const p = buildProfileAt([
      histRow({ prNumber: 1, authorLogin: 'sarah', reviewedAt: at(1) }),
      histRow({ prNumber: 2, authorLogin: 'sarah', reviewedAt: null }),
    ]);
    // Close-to, not equal: every contribution is recency-weighted, so these
    // are weights rather than counts. A review seconds old is worth ~1, never
    // exactly 1.
    expect(p.authorAffinity.sarah.gave).toBeCloseTo(1, 2);
    expect(p.authorAffinity.sarah.got).toBeCloseTo(2, 2);
  });

  it('counts the DENOMINATOR, which is what makes affinity a rate', () => {
    // Built only from reviews performed it would say "you review the people you
    // review" — true, and useless for ranking.
    const p = buildProfileAt([
      histRow({ prNumber: 1, authorLogin: 'eager', reviewedAt: at(1) }),
      histRow({ prNumber: 2, authorLogin: 'ignored', reviewedAt: null }),
      histRow({ prNumber: 3, authorLogin: 'ignored', reviewedAt: null }),
    ]);
    expect(p.authorAffinity.eager.got).toBeCloseTo(1, 2);
    expect(p.authorAffinity.ignored.gave).toBe(0);
    expect(p.authorAffinity.ignored.got).toBeCloseTo(2, 2);
  });

  it('credits directories only for reviews ACTUALLY performed', () => {
    // A PR you were asked about and ignored taught you nothing about its files.
    // Counting it would make "familiar with" mean "adjacent to".
    const p = buildProfileAt([
      histRow({ prNumber: 1, dirs: ['src/read'], reviewedAt: at(1) }),
      histRow({ prNumber: 2, dirs: ['src/ignored'], reviewedAt: null }),
    ]);
    expect(p.dirAffinity['src/read']).toBeCloseTo(1, 2);
    expect(p.dirAffinity['src/ignored']).toBeUndefined();
  });

  it('expresses repo affinity as a share that sums to one', () => {
    const p = buildProfileAt([
      histRow({ prNumber: 1, repoFullName: 'acme/a', reviewedAt: at(1) }),
      histRow({ prNumber: 2, repoFullName: 'acme/a', reviewedAt: at(1) }),
      histRow({ prNumber: 3, repoFullName: 'acme/b', reviewedAt: at(1) }),
    ]);
    expect(p.repoAffinity['acme/a']).toBeCloseTo(2 / 3, 6);
    expect(Object.values(p.repoAffinity).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it('lowercases logins and repos so casing cannot split a person in two', () => {
    const p = buildProfileAt([histRow({ authorLogin: 'SaRaH', repoFullName: 'ACME/Widgets' })]);
    expect(p.authorAffinity.sarah).toBeDefined();
    expect(p.repoAffinity['acme/widgets']).toBeDefined();
  });

  it('survives a history with no reviews at all', () => {
    const p = buildProfileAt([histRow({ reviewedAt: null })]);
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

describe('the sweep actually runs', () => {
  afterEach(() => {
    reviewPrioritySweep.stop();
    vi.useRealTimers();
  });

  it('sweeps shortly after boot, not an hour later', async () => {
    // The defect this guards: `setInterval` alone puts the first sweep a full
    // hour out, and every push to main redeploys this backend — restarting the
    // hour. On a repo that deploys per-push, the sweep can go days without
    // firing once, and nothing says so: the Reviews ordering silently runs on
    // its deterministic half while the model it advertises is never built.
    vi.useFakeTimers();
    const tick = vi.spyOn(reviewPrioritySweep, 'tick').mockResolvedValue({
      workspaces: 0,
      backfilled: 0,
      trained: 0,
    });

    reviewPrioritySweep.init();
    expect(tick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('keeps sweeping on the interval afterwards', async () => {
    vi.useFakeTimers();
    const tick = vi.spyOn(reviewPrioritySweep, 'tick').mockResolvedValue({
      workspaces: 0,
      backfilled: 0,
      trained: 0,
    });

    reviewPrioritySweep.init();
    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('stops both timers, so a stopped sweep stays stopped', async () => {
    vi.useFakeTimers();
    const tick = vi.spyOn(reviewPrioritySweep, 'tick').mockResolvedValue({
      workspaces: 0,
      backfilled: 0,
      trained: 0,
    });

    reviewPrioritySweep.init();
    reviewPrioritySweep.stop();
    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS + SWEEP_INTERVAL_MS);
    expect(tick).not.toHaveBeenCalled();
  });
});

describe('recency — "these days", not "ever"', () => {
  const NOW = Date.parse('2026-09-21T00:00:00Z');
  const daysAgo = (d: number) => new Date(NOW - d * 86_400_000);

  it('halves a contribution at the half-life', () => {
    expect(recencyWeight(0)).toBe(1);
    expect(recencyWeight(REVIEW_AFFINITY_HALF_LIFE_DAYS)).toBeCloseTo(0.5, 6);
    expect(recencyWeight(REVIEW_AFFINITY_HALF_LIFE_DAYS * 2)).toBeCloseTo(0.25, 6);
  });

  it('decays smoothly rather than falling off a window edge', () => {
    // A cutoff would make somebody's affinity lurch the day an old review
    // dropped out of it, and there is no principled place to put the edge.
    const a = recencyWeight(89);
    const b = recencyWeight(91);
    expect(a).toBeGreaterThan(b);
    expect(a - b).toBeLessThan(0.02);
  });

  it('never rewards a future or nonsense timestamp with more than full weight', () => {
    expect(recencyWeight(-10)).toBe(1);
    expect(recencyWeight(Number.NaN)).toBe(1);
  });

  it('ranks a team reviewed RECENTLY above one reviewed long ago', () => {
    // The whole point. Without decay these two are identical — both are
    // "20 reviews given, 20 requested" — and the profile can only say who the
    // viewer has EVER worked with, never who they work with now.
    const rows: TrainingRow[] = [
      ...Array.from({ length: 20 }, (_, i) =>
        histRow({
          prNumber: 100 + i,
          teams: ['posthog/current'],
          requestedAt: daysAgo(10),
          reviewedAt: daysAgo(9),
        }),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        histRow({
          prNumber: 200 + i,
          teams: ['posthog/former'],
          requestedAt: daysAgo(400),
          reviewedAt: daysAgo(399),
        }),
      ),
    ];
    const p = buildProfile(rows, NOW);
    expect(p.teamAffinity['posthog/current'].gave).toBeGreaterThan(
      p.teamAffinity['posthog/former'].gave * 5,
    );
  });

  it('keeps the RATE intact for a team that is simply quiet now', () => {
    // Decay must shrink both halves together. A team you always serviced and
    // which has gone quiet should read as "still trusted, just idle" — not as
    // one you ignore.
    const rows: TrainingRow[] = Array.from({ length: 10 }, (_, i) =>
      histRow({
        prNumber: 300 + i,
        teams: ['posthog/quiet'],
        requestedAt: daysAgo(300),
        reviewedAt: daysAgo(299),
      }),
    );
    const p = buildProfile(rows, NOW);
    const t = p.teamAffinity['posthog/quiet'];
    expect(t.gave / t.got).toBeCloseTo(1, 6);
  });

  it('decays author affinity the same way', () => {
    const rows: TrainingRow[] = [
      histRow({ prNumber: 1, authorLogin: 'recent', requestedAt: daysAgo(5), reviewedAt: daysAgo(4) }),
      histRow({ prNumber: 2, authorLogin: 'lapsed', requestedAt: daysAgo(500), reviewedAt: daysAgo(499) }),
    ];
    const p = buildProfile(rows, NOW);
    expect(p.authorAffinity.recent.gave).toBeGreaterThan(p.authorAffinity.lapsed.gave * 10);
  });

  it('counts an unreviewed request against the team, recency-weighted', () => {
    // The denominator matters as much as the numerator: ignoring recent
    // requests is what "I don't review for them these days" actually looks
    // like in the data.
    const rows: TrainingRow[] = Array.from({ length: 10 }, (_, i) =>
      histRow({
        prNumber: 400 + i,
        teams: ['posthog/ignored'],
        requestedAt: daysAgo(6),
        reviewedAt: null,
      }),
    );
    const p = buildProfile(rows, NOW);
    expect(p.teamAffinity['posthog/ignored'].got).toBeGreaterThan(0);
    expect(p.teamAffinity['posthog/ignored'].gave).toBe(0);
  });
});

describe('the backfill marker is VERSIONED', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({
      id: 'ws2',
      ownerId: TEST_USER_ID,
      name: 'ws',
      settings: {},
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  it('re-reads a viewer backfilled under an OLDER recipe', async () => {
    // The failure this prevents: migration 0063 added team slugs, and every
    // viewer already marked "done" would keep a history without them. Team
    // affinity would read zero for all of them and nothing would say so — the
    // model just quietly gets worse than it should be.
    await db.insert(reviewRankModelsTable).values({
      workspaceId: 'ws2',
      viewerLogin: 'me',
      backfilledAt: new Date(),
      backfillVersion: BACKFILL_VERSION - 1,
    });
    expect(await hasBackfilled('ws2', 'me')).toBe(false);
  });

  it('leaves a viewer on the current recipe alone', async () => {
    await db.insert(reviewRankModelsTable).values({
      workspaceId: 'ws2',
      viewerLogin: 'me',
      backfilledAt: new Date(),
      backfillVersion: BACKFILL_VERSION,
    });
    expect(await hasBackfilled('ws2', 'me')).toBe(true);
  });

  it('treats the pre-column default of 0 as needing a re-read', async () => {
    // Rows written before migration 0064 default to 0, which is below every
    // real version — that default is what makes them re-run.
    await db.insert(reviewRankModelsTable).values({
      workspaceId: 'ws2',
      viewerLogin: 'me',
      backfilledAt: new Date(),
    });
    expect(await hasBackfilled('ws2', 'me')).toBe(false);
  });

  it('does not claim a viewer with no row at all is done', async () => {
    expect(await hasBackfilled('ws2', 'nobody')).toBe(false);
  });
});
