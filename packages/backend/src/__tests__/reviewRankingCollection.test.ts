import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { ReviewRankingRecorder, scorePRForReview, type ReviewRankingRow } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import { workspaces, reviewRankingEvents, reviewRankingOutcomes } from '../db/schema.js';
import { disableRankingCollection, recordRankingOutcome, reconcileRankingOutcomes, storeRankingEvents } from '../services/reviewPriority/collection.js';
import { rankingBatchSchema } from '../services/reviewPriority/captureSchema.js';
import { githubService } from '../services/github.js';

describe('central ranking collection', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: TEST_USER_ID });
    await testDb.db.insert(workspaces).values({ id: 'ranking-ws', ownerId: TEST_USER_ID, name: 'ranking' });
  });
  afterAll(async () => { vi.restoreAllMocks(); await testDb.cleanup(); });

  function batch() {
    const now = Date.now();
    const events: unknown[] = [];
    const row: ReviewRankingRow = {
      id: 'pr-1', workspaceId: 'ranking-ws', owner: 'org', repo: 'repo', number: 1,
      createdAt: new Date(now - 3600_000).toISOString(),
      reviewRequestedFirstSeenAt: new Date(now - 3600_000).toISOString(),
      summary: { draft: false, stack: { position: 1, size: 2 } as ReviewRankingRow['summary']['stack'] },
    };
    row.priority = scorePRForReview(row, { now, pooledScore: 0.5, captureTrace: { source: 'server' } });
    const recorder = new ReviewRankingRecorder((event, properties) => events.push({
      id: randomUUID(), event, properties: { ...properties, session_id: randomUUID(), session_started_at: new Date(now - 1000).toISOString() },
    }), randomUUID);
    recorder.record([row], {
      workspaceId: 'ranking-ws', viewerLogin: 'viewer', sortMode: 'priority', assignedArm: 'candidate',
      filterKey: '', filtered: false, profile: null, repositoryScope: ['org/repo'],
    }, now);
    return rankingBatchSchema.parse({ enabled: true, events });
  }

  it('accepts real recorder output, preserves stack replay, and removes arbitrary text', () => {
    const b = batch();
    const input = JSON.parse(JSON.stringify(b));
    input.events[0].properties.candidates[0].body = 'private PR text';
    expect(JSON.stringify(rankingBatchSchema.parse(input))).not.toContain('private PR text');
  });

  it('deduplicates retries and rejects a different viewer or workspace', async () => {
    const b = batch();
    await storeRankingEvents(testDb.db, 'ranking-ws', TEST_USER_ID, 'viewer', b);
    await storeRankingEvents(testDb.db, 'ranking-ws', TEST_USER_ID, 'viewer', b);
    expect(await testDb.db.select().from(reviewRankingEvents)).toHaveLength(1);
    await expect(storeRankingEvents(testDb.db, 'ranking-ws', TEST_USER_ID, 'other', b)).rejects.toThrow();
    await expect(storeRankingEvents(testDb.db, 'other', TEST_USER_ID, 'viewer', b)).rejects.toThrow();
  });

  it.each(['score', 'gate', 'displayed_rank'])('refuses a changed replay field: %s', (field) => {
    const input = JSON.parse(JSON.stringify(batch()));
    input.events[0].properties.candidates[0][field] = field === 'gate' ? 'actionable' : 999;
    expect(rankingBatchSchema.safeParse(input).success).toBe(false);
  });

  it('records untracked review outcomes once and resolves creation time', async () => {
    const b = batch();
    await storeRankingEvents(testDb.db, 'ranking-ws', TEST_USER_ID, 'viewer', b);
    const submitted = new Date().toISOString();
    const payload = { review: { node_id: 'review-1', state: 'approved', submitted_at: submitted,
      user: { type: 'User', login: 'Viewer' } }, pull_request: { number: 555 } };
    await recordRankingOutcome(['ranking-ws'], 'Org/Repo', payload);
    await recordRankingOutcome(['ranking-ws'], 'Org/Repo', payload);
    expect(await testDb.db.select().from(reviewRankingOutcomes)).toHaveLength(1);
    vi.spyOn(githubService, 'executeGraphql').mockResolvedValue({ nodes: [{
      id: 'review-1', createdAt: new Date(Date.now() - 60_000).toISOString(), submittedAt: submitted, author: { login: 'viewer' },
    }] });
    await reconcileRankingOutcomes();
    const [outcome] = await testDb.db.select().from(reviewRankingOutcomes);
    expect(outcome.createdAt).toBeInstanceOf(Date);
    await disableRankingCollection(testDb.db, TEST_USER_ID);
    await recordRankingOutcome(['ranking-ws'], 'Org/Repo', { ...payload, review: { ...payload.review, node_id: 'review-2' } });
    expect(await testDb.db.select().from(reviewRankingOutcomes)).toHaveLength(1);
  });

  it('restricts the new tables to the backend role and owner policies', async () => {
    for (const table of ['review_ranking_events', 'review_ranking_outcomes', 'review_ranking_participants']) {
      const result = await testDb.pglite.query<{ backend: boolean; browser: boolean; rls: boolean }>(
        `SELECT has_table_privilege('talyn_backend', '${table}', 'INSERT') AS backend,
          has_table_privilege('authenticated', '${table}', 'SELECT') AS browser,
          relrowsecurity AS rls FROM pg_class WHERE relname = '${table}'`);
      expect(result.rows[0]).toEqual({ backend: true, browser: false, rls: true });
    }
  });
});
