import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { PgDialect } from 'drizzle-orm/pg-core';
import { eq, type SQL } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { invokeRoute } from './helpers/invokeRoute.js';
import type { Database } from '../db/client.js';
import {
  mergeQueueEntries,
  mergeQueueEvents,
  prCodeReviewFindings,
  prCodeReviewRuns,
  prCodeReviews,
  pullRequests,
  repositories,
  tasks,
  usageIntervals,
  usagePeriods,
  workbenchBootSamples,
  workbenchTurnTimings,
  workbenchTurnUsage,
  workbenches,
  workspaces,
} from '../db/schema.js';
import { insertChat, insertWorkbench } from '../services/workbenches/store.js';
import {
  agentsByModelSql,
  agentsDaysSql,
  bootSamplesSql,
  computeBreakdownSql,
  computeDaysSql,
  findingsSql,
  firstReplyNewSessionSql,
  firstReplySql,
  fixRunsSql,
  loadAgents,
  loadCompute,
  loadOutput,
  loadSpeed,
  loadTop,
  outputCountsSql,
  repositoryHoursSql,
  repositoryTokensSql,
  sessionHoursSql,
  sessionNamesSql,
  sessionTokensSql,
  turnDurationSql,
  turnStartSql,
  type InsightsScope,
} from '../services/insights/queries.js';
import { turnFactsSql } from '../services/insights/turnUsage.js';
import { insightsRoutes } from '../routes/insights.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';

const FROM = new Date('2026-11-01T00:00:00.000Z');
const TO = new Date('2026-11-04T00:00:00.000Z');
const IN = (h: number) => new Date(FROM.getTime() + h * 3_600_000);
const BEFORE = new Date('2026-10-20T00:00:00.000Z');
const scope = (overrides: Partial<InsightsScope> = {}): InsightsScope => ({
  ownerId: 'owner', workspaceId: 'ws', from: FROM, to: TO, preset: 'custom', ...overrides,
});

async function seed(db: Database) {
  await seedUser(db, { id: 'owner' });
  await seedUser(db, { id: 'stranger' });
  await db.insert(workspaces).values([
    { id: 'ws', ownerId: 'owner', name: 'Mine' },
    { id: 'ws-2', ownerId: 'owner', name: 'My other' },
    { id: 'ws-x', ownerId: 'stranger', name: 'Not mine' },
  ]);
  await db.insert(repositories).values([
    { id: 'repo-1', workspaceId: 'ws', name: 'o/one', url: 'https://github.com/o/one' },
    { id: 'repo-2', workspaceId: 'ws', name: 'o/two', url: 'https://github.com/o/two' },
    { id: 'repo-x', workspaceId: 'ws-x', name: 'x/x', url: 'https://github.com/x/x' },
  ]);
  const wb = (id: string, workspaceId: string, repo: string, extra: Record<string, unknown> = {}) => insertWorkbench({
    id, workspaceId, repoFullName: repo, baseBranch: 'main', branch: id, name: `name-${id}`, runtime: 'sandbox', status: 'ready', agent: 'claude', ...extra,
  });
  await db.insert(pullRequests).values([
    { id: 'pr-1', workspaceId: 'ws', repositoryId: 'repo-1', owner: 'o', repo: 'one', number: 1, state: 'merged', mergedAt: IN(5) },
    { id: 'pr-2', workspaceId: 'ws', repositoryId: 'repo-2', owner: 'o', repo: 'two', number: 2, state: 'open' },
    { id: 'pr-old', workspaceId: 'ws', repositoryId: 'repo-1', owner: 'o', repo: 'one', number: 3, state: 'merged', mergedAt: BEFORE },
  ]);
  await wb('wb-1', 'ws', 'o/one', { title: 'Fix login', createdAt: IN(1), pullRequestId: 'pr-1', pullRequestLinkedAt: IN(2) });
  await wb('wb-2', 'ws', 'o/two', { createdAt: IN(3), archivedAt: IN(40), pullRequestId: 'pr-2', pullRequestLinkedAt: IN(4) });
  await wb('wb-old', 'ws', 'o/one', { createdAt: BEFORE, pullRequestId: 'pr-old', pullRequestLinkedAt: BEFORE });
  await wb('wb-thread', 'ws', '', { kind: 'thread', createdAt: IN(1) });
  await wb('wb-x', 'ws-x', 'x/x', { createdAt: IN(1) });
  await wb('wb-other-ws', 'ws-2', 'o/one', { createdAt: IN(1) });
  // The link trigger stamps the link time on insert; an update of the time alone keeps it.
  for (const [id, linkedAt] of [['wb-1', IN(2)], ['wb-2', IN(4)], ['wb-old', BEFORE]] as const) {
    await db.update(workbenches).set({ pullRequestLinkedAt: linkedAt }).where(eq(workbenches.id, id));
  }
  for (const id of ['wb-1', 'wb-2', 'wb-x']) {
    await insertChat({ id: `chat-${id}`, workbenchId: id, workspaceId: id === 'wb-x' ? 'ws-x' : 'ws', title: 'c', agent: 'claude' });
  }

  const interval = (id: string, workspaceId: string | null, subjectKind: string, subjectId: string, size: string, startedAt: Date, wsec: number, ownerId = 'owner') => ({
    id, ownerId, workspaceId, subjectKind, subjectId, sandboxId: `sb-${id}`, size, weight: '1.00', startedAt,
    endedAt: new Date(startedAt.getTime() + 3_600_000), billedThrough: startedAt, billedWsec: wsec,
  });
  await db.insert(usageIntervals).values([
    interval('i1', 'ws', 'workbench', 'wb-1', 'standard', IN(1), 3600),
    interval('i2', 'ws', 'workbench', 'wb-1', 'large', IN(30), 7200),
    interval('i3', 'ws', 'workbench', 'wb-2', 'standard', IN(50), 1800),
    interval('i4', 'ws', 'task', 't-code', 'small', IN(2), 900),
    interval('i5', 'ws', 'review_unit', 'run-1', 'small', IN(3), 600),
    interval('i-before', 'ws', 'workbench', 'wb-1', 'standard', BEFORE, 99_999),
    interval('i-other-ws', 'ws-2', 'workbench', 'wb-other-ws', 'standard', IN(1), 88_888),
    interval('i-foreign', 'ws', 'workbench', 'wb-1', 'standard', IN(1), 77_777, 'stranger'),
  ]);

  const usage = (chatId: string, turn: number, model: string, extra: Record<string, unknown>) => ({
    chatId, turn, model, workspaceId: 'ws', workbenchId: chatId.replace('chat-', ''), agent: 'claude', isPrimary: true,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, endedAt: IN(1), ...extra,
  });
  await db.insert(workbenchTurnUsage).values([
    usage('chat-wb-1', 1, 'opus', { inputTokens: 100, outputTokens: 200, cacheReadTokens: 1000, cacheWriteTokens: 50, costEstimateMicros: 500_000, durationMs: 10_000, agentSteps: 4, firstReplyMs: 2000, endedAt: IN(1) }),
    usage('chat-wb-1', 1, 'haiku', { isPrimary: false, inputTokens: 10, outputTokens: 10, costEstimateMicros: 1000, endedAt: IN(1) }),
    usage('chat-wb-1', 2, 'opus', { inputTokens: 50, outputTokens: 50, costEstimateMicros: 100_000, durationMs: 30_000, agentSteps: 2, firstReplyMs: 4000, isError: true, endedAt: IN(26) }),
    usage('chat-wb-2', 1, 'gpt-codex', { agent: 'codex', inputTokens: 5000, outputTokens: 100, cacheReadTokens: 20_000, durationMs: 20_000, firstReplyMs: 8000, endedAt: IN(4) }),
    usage('chat-wb-old', 9, 'gpt-codex', { agent: 'codex', inputTokens: 1, firstReplyMs: 1, endedAt: BEFORE }),
    { ...usage('chat-wb-x', 1, 'opus', { inputTokens: 123_456 }), workspaceId: 'ws-x', workbenchId: 'wb-x' },
  ]);

  await db.insert(workbenchBootSamples).values([
    { chatId: 'chat-wb-1', seq: 1, workspaceId: 'ws', workbenchId: 'wb-1', kind: 'box_start', ms: 40_000, cause: 'new', at: IN(1) },
    { chatId: 'chat-wb-1', seq: 2, workspaceId: 'ws', workbenchId: 'wb-1', kind: 'box_start', ms: 20_000, cause: 'new', at: IN(2) },
    { chatId: 'chat-wb-1', seq: 3, workspaceId: 'ws', workbenchId: 'wb-1', kind: 'box_start', ms: 90_000, cause: 'move', at: IN(3) },
    { chatId: 'chat-wb-1', seq: 4, workspaceId: 'ws', workbenchId: 'wb-1', kind: 'wake', ms: 1000, source: 'host', at: IN(4) },
    { chatId: 'chat-wb-1', seq: 5, workspaceId: 'ws', workbenchId: 'wb-1', kind: 'box_start', ms: 1, cause: 'new', at: BEFORE },
    { chatId: 'chat-wb-x', seq: 1, workspaceId: 'ws-x', workbenchId: 'wb-x', kind: 'wake', ms: 5, source: 'host', at: IN(4) },
  ]);
  await db.insert(workbenchTurnTimings).values([
    { chatId: 'chat-wb-1', turn: 1, workbenchId: 'wb-1', startMs: 1500, wallMs: 1, toolMs: 0, modelMs: 0, createdAt: IN(1) },
    { chatId: 'chat-wb-1', turn: 2, workbenchId: 'wb-1', startMs: 500, wallMs: 1, toolMs: 0, modelMs: 0, createdAt: IN(26) },
    { chatId: 'chat-wb-x', turn: 1, workbenchId: 'wb-x', startMs: 99_000, wallMs: 1, toolMs: 0, modelMs: 0, createdAt: IN(1) },
  ]);

  const task = (id: string, workspaceId: string, type: string, extra: Record<string, unknown> = {}) => ({
    id, workspaceId, type, title: id, description: '', createdAt: IN(2), ...extra,
  });
  await db.insert(tasks).values([
    task('t-code', 'ws', 'code_writing', { status: 'completed', repositoryId: 'repo-1', pullRequestId: 'pr-1' }),
    task('t-fail', 'ws', 'code_writing', { status: 'failed' }),
    task('t-mq', 'ws', 'pr_response', { metadata: { source: 'merge_queue' } }),
    task('t-mq2', 'ws', 'pr_response', { metadata: { source: 'merge_queue' } }),
    task('t-keep', 'ws', 'pr_response', { metadata: { source: 'auto_keep' } }),
    task('t-manual', 'ws', 'pr_response', { metadata: {} }),
    task('t-old', 'ws', 'pr_response', { createdAt: BEFORE, metadata: { source: 'merge_queue' } }),
    task('t-x', 'ws-x', 'pr_response', { metadata: { source: 'merge_queue' } }),
  ]);

  await db.insert(mergeQueueEntries).values([
    { id: 'mq-1', pullRequestId: 'pr-1', workspaceId: 'ws', repositoryId: 'repo-1', status: 'merged' },
    { id: 'mq-2', pullRequestId: 'pr-2', workspaceId: 'ws', repositoryId: 'repo-2', status: 'queued' },
  ]);
  await db.insert(mergeQueueEvents).values([
    { entryId: 'mq-1', at: IN(5), fromStatus: 'merging', toStatus: 'merged', trigger: 'webhook' },
    { entryId: 'mq-1', at: IN(4), fromStatus: 'queued', toStatus: 'merging', trigger: 'executor' },
    { entryId: 'mq-2', at: BEFORE, fromStatus: 'merging', toStatus: 'merged', trigger: 'webhook' },
  ]);

  await db.insert(prCodeReviews).values({ id: 'rv-1', workspaceId: 'ws', repositoryId: 'repo-2', pullRequestId: 'pr-2', cycle: 1 });
  await db.insert(prCodeReviewRuns).values([
    { id: 'run-1', reviewId: 'rv-1', workspaceId: 'ws', cycle: 0, kind: 'lens', lens: 'a', createdAt: IN(3) },
    { id: 'run-2', reviewId: 'rv-1', workspaceId: 'ws', cycle: 0, kind: 'lens', lens: 'b', createdAt: IN(3) },
    { id: 'run-3', reviewId: 'rv-1', workspaceId: 'ws', cycle: 1, kind: 'lens', lens: 'a', createdAt: IN(20) },
  ]);
  const finding = (id: string, severity: string, verdict: string) => ({
    id, reviewId: 'rv-1', workspaceId: 'ws', pullRequestId: 'pr-2', dedupeKey: id, severity, title: id, verdict, createdAt: IN(3),
  });
  await db.insert(prCodeReviewFindings).values([
    finding('f1', 'major', 'confirmed'), finding('f2', 'blocker', 'unvalidated'), finding('f3', 'major', 'uncertain'),
    finding('f4', 'nit', 'rejected'),
  ]);
}

describe('Insights queries', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    await seed(db);
  });
  afterAll(async () => cleanup());

  it('compute: box time by day, size and kind, scoped to the workspace and its owner', async () => {
    const out = await loadCompute(scope(), null);
    expect(out.totalWsec).toBe(3600 + 7200 + 1800 + 900 + 600);
    expect(out.boxes).toBe(5);
    expect(out.days).toEqual([
      { date: '2026-11-01', wsec: 3600 + 900 + 600 },
      { date: '2026-11-02', wsec: 7200 },
      { date: '2026-11-03', wsec: 1800 },
    ]);
    expect(out.bySize).toEqual([
      { size: 'large', wsec: 7200, boxes: 1 },
      { size: 'standard', wsec: 5400, boxes: 2 },
      { size: 'small', wsec: 1500, boxes: 2 },
    ]);
    expect(out.byKind).toEqual([
      { kind: 'workbench', wsec: 12_600, boxes: 3 },
      { kind: 'task', wsec: 900, boxes: 1 },
      { kind: 'review_unit', wsec: 600, boxes: 1 },
    ]);
    expect(out.range).toEqual({ from: FROM.toISOString(), to: TO.toISOString(), preset: 'custom' });
  });

  it('agents: tokens by model, agent and day, with cost only where reported', async () => {
    const out = await loadAgents(scope());
    expect(out.totals).toEqual({
      inputTokens: 5160, outputTokens: 360, cacheReadTokens: 21_000, cacheWriteTokens: 50,
      turns: 3, failedTurns: 1, agentSteps: 6, costMicros: 601_000, turnsWithCost: 2,
    });
    expect(out.byAgent.map((a) => [a.agent, a.turns, a.costMicros, a.inputTokens])).toEqual([
      ['claude', 2, 601_000, 160],
      ['codex', 1, null, 5000],
    ]);
    expect(out.byModel.map((m) => [m.agent, m.model, m.turns, m.costMicros])).toEqual([
      ['codex', 'gpt-codex', 1, null],
      ['claude', 'opus', 2, 600_000],
      ['claude', 'haiku', 0, 1000],
    ]);
    expect(out.days.map((d) => [d.date, d.turns, d.inputTokens])).toEqual([
      ['2026-11-01', 2, 5110],
      ['2026-11-02', 1, 50],
      ['2026-11-03', 0, 0],
    ]);
    expect(out.turnDuration).toEqual({ count: 3, p50Ms: 20_000, p90Ms: 28_000 });
  });

  it('agents: an empty window', async () => {
    const out = await loadAgents(scope({ from: new Date('2026-12-01T00:00:00Z'), to: new Date('2026-12-02T00:00:00Z') }));
    expect(out.totals).toMatchObject({ turns: 0, costMicros: null, inputTokens: 0 });
    expect(out.byModel).toEqual([]);
    expect(out.turnDuration).toEqual({ count: 0, p50Ms: null, p90Ms: null });
  });

  it('output: sessions, tasks, fix runs, landings and reviews in the window', async () => {
    const out = await loadOutput(scope());
    expect(out.sessions).toEqual({ created: 2, withPullRequest: 2, pullRequestsMerged: 1 });
    expect(out.tasks).toEqual({ created: 6, completed: 1, failed: 1, withPullRequest: 1 });
    expect(out.fixRuns).toEqual([
      { source: 'merge_queue', count: 2 },
      { source: 'auto_keep', count: 1 },
      { source: 'other', count: 1 },
    ]);
    expect(out.mergeQueue).toEqual({ landed: 1 });
    expect(out.codeReview).toEqual({
      reviews: 2,
      findings: [{ severity: 'blocker', count: 1 }, { severity: 'major', count: 2 }],
    });
  });

  it('speed: percentiles of box starts, wakes, replies and turn starts', async () => {
    const out = await loadSpeed(scope());
    expect(out.boxStart).toEqual({
      count: 3, p50Ms: 40_000, p90Ms: 80_000,
      byCause: [
        { cause: 'new', count: 2, p50Ms: 30_000, p90Ms: 38_000 },
        { cause: 'move', count: 1, p50Ms: 90_000, p90Ms: 90_000 },
      ],
    });
    expect(out.wake).toEqual({ count: 1, p50Ms: 1000, p90Ms: 1000, bySource: [{ source: 'host', count: 1, p50Ms: 1000, p90Ms: 1000 }] });
    expect(out.firstReply).toEqual({ count: 3, p50Ms: 4000, p90Ms: 7200 });
    // wb-1's first turn and wb-2's first turn; wb-old was created before the window.
    expect(out.firstReplyNewSession).toEqual({ count: 2, p50Ms: 5000, p90Ms: 7400 });
    expect(out.turnStart).toEqual({ count: 2, p50Ms: 1000, p90Ms: 1400 });
  });

  it('top: repositories and sessions by box-hours and by tokens', async () => {
    const out = await loadTop(scope());
    expect(out.repositoriesByHours).toEqual([
      { repository: 'o/one', wsec: 3600 + 7200 + 900, tokens: 100 + 200 + 1000 + 50 + 20 + 100 },
      { repository: 'o/two', wsec: 1800 + 600, tokens: 25_100 },
    ]);
    expect(out.repositoriesByTokens.map((r) => r.repository)).toEqual(['o/two', 'o/one']);
    expect(out.sessionsByHours).toEqual([
      { workbenchId: 'wb-1', title: 'Fix login', repository: 'o/one', archived: false, wsec: 10_800, tokens: 1470 },
      { workbenchId: 'wb-2', title: 'name-wb-2', repository: 'o/two', archived: true, wsec: 1800, tokens: 25_100 },
    ]);
    expect(out.sessionsByTokens.map((s) => s.workbenchId)).toEqual(['wb-2', 'wb-1']);
  });

  it('another workspace of the same owner sees only its own rows', async () => {
    const out = await loadCompute(scope({ workspaceId: 'ws-2' }), null);
    expect(out.totalWsec).toBe(88_888);
    expect((await loadAgents(scope({ workspaceId: 'ws-2' }))).totals.turns).toBe(0);
    expect((await loadTop(scope({ workspaceId: 'ws-2' }))).sessionsByTokens).toEqual([]);
  });
});

describe('Insights route', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const router = insightsRoutes();

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    await seed(db);
    await db.insert(usagePeriods).values({
      ownerId: 'owner', periodStart: new Date('2026-11-01T00:00:00Z'), periodEnd: new Date('2026-12-01T00:00:00Z'),
      tier: 'free', includedWsec: 36_000, usedWsec: 12_000, creditMicrosUsed: 0,
    });
  });
  beforeEach(() => {
    vi.stubEnv('USAGE_INSIGHTS_ENABLED', 'true');
    resetFeatureFlagsForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetFeatureFlagsForTests();
  });
  afterAll(async () => cleanup());

  const call = (section: string, query: Record<string, unknown>, user = 'owner') =>
    invokeRoute<{ success: boolean; data?: Record<string, unknown>; error?: string; code?: string }>(router, 'GET', '/:section', {
      params: { section }, query, user: { id: user, email: `${user}@test.invalid`, isAdmin: false },
    } as never);

  it.each(['compute', 'agents', 'output', 'speed', 'top'])('answers %s for the owner', async (section) => {
    const res = await call(section, { workspaceId: 'ws', from: FROM.toISOString(), to: TO.toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.data?.range).toEqual({ from: FROM.toISOString(), to: TO.toISOString(), preset: 'custom' });
  });

  it('compute carries the owner period', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-04T12:00:00Z'), toFake: ['Date'] });
    try {
      const res = await call('compute', { workspaceId: 'ws', range: 'period' });
      expect(res.body.data?.period).toEqual({
        tier: 'free', periodStart: '2026-11-01T00:00:00.000Z', periodEnd: '2026-12-01T00:00:00.000Z',
        includedWsec: 36_000, usedWsec: 12_000, creditMicrosUsed: 0,
      });
      expect(res.body.data?.range).toMatchObject({ from: '2026-11-01T00:00:00.000Z', preset: 'period' });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each<[string, string, Record<string, unknown>, string, number, string | undefined]>([
    ['an unknown section', 'everything', { workspaceId: 'ws' }, 'owner', 404, undefined],
    ['no workspace', 'compute', {}, 'owner', 400, undefined],
    ['a workspace the caller does not own', 'compute', { workspaceId: 'ws-x' }, 'owner', 404, undefined],
    ['a caller who owns nothing here', 'top', { workspaceId: 'ws' }, 'stranger', 404, undefined],
    ['a bad range', 'compute', { workspaceId: 'ws', range: 'forever' }, 'owner', 400, undefined],
  ])('refuses %s', async (_label, section, query, user, status, code) => {
    const res = await call(section, query, user);
    expect(res.status).toBe(status);
    expect(res.body.success).toBe(false);
    if (code) expect(res.body.code).toBe(code);
  });

  it.each(['false', ''])('refuses with 403 when the flag is off (USAGE_INSIGHTS_ENABLED=%j, no PostHog)', async (value) => {
    vi.stubEnv('USAGE_INSIGHTS_ENABLED', value);
    vi.stubEnv('TALYN_POSTHOG_KEY', '');
    resetFeatureFlagsForTests();
    const res = await call('compute', { workspaceId: 'ws' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('insights_unavailable');
  });
});

describe('Insights egress: no blob column is read', () => {
  const dialect = new PgDialect();
  const s = scope();
  const queries: [string, SQL][] = [
    ['computeDays', computeDaysSql(s)],
    ['computeBreakdown', computeBreakdownSql(s)],
    ['agentsByModel', agentsByModelSql(s)],
    ['agentsDays', agentsDaysSql(s)],
    ['turnDuration', turnDurationSql(s)],
    ['outputCounts', outputCountsSql(s)],
    ['fixRuns', fixRunsSql(s)],
    ['findings', findingsSql(s)],
    ['bootSamples', bootSamplesSql(s)],
    ['firstReply', firstReplySql(s)],
    ['firstReplyNewSession', firstReplyNewSessionSql(s)],
    ['turnStart', turnStartSql(s)],
    ['repositoryHours', repositoryHoursSql(s)],
    ['repositoryTokens', repositoryTokensSql(s)],
    ['sessionHours', sessionHoursSql(s)],
    ['sessionHoursFor', sessionHoursSql(s, ['a', 'b'])],
    ['sessionTokens', sessionTokensSql(s)],
    ['sessionTokensFor', sessionTokensSql(s, ['a'])],
    ['sessionNames', sessionNamesSql('ws', ['a'])],
  ];

  it.each(queries)('%s reads no transcript, summary, body, settings or whole jsonb', (_name, query) => {
    const text = dialect.sqlToQuery(query).sql;
    expect(text).not.toMatch(/workbench_events/);
    expect(text).not.toMatch(/\btranscript\b/);
    expect(text).not.toMatch(/last_summary/);
    expect(text).not.toMatch(/\bbody\b/);
    expect(text).not.toMatch(/\bsettings\b/);
    expect(text).not.toMatch(/SELECT \*/i);
    expect(text).not.toMatch(/\.\*/);
    // tasks.metadata ships only its `source` string.
    for (const match of text.matchAll(/metadata/g)) {
      expect(text.slice(match.index!, match.index! + 21)).toBe("metadata ->> 'source'");
    }
  });

  it('the turn-facts read (writer and backfill) never returns a whole event', () => {
    const text = dialect.sqlToQuery(turnFactsSql(['c1'], 3)).sql;
    expect(text).not.toMatch(/e\.event\s*(,|AS|\)|$)/m);
    expect(text).not.toMatch(/SELECT \*/i);
  });
});

describe('Insights queries: no unencoded Date reaches the driver', () => {
  let pglite: PGlite;
  let cleanup: () => Promise<void>;
  let params: unknown[][];

  beforeAll(async () => {
    const t = await createTestDb();
    pglite = t.pglite;
    cleanup = t.cleanup;
    params = [];
    const original = pglite.query.bind(pglite) as (query: string, p?: unknown[], o?: unknown) => Promise<unknown>;
    (pglite as unknown as { query: typeof original }).query = (query, p, o) => {
      if (p) params.push(p);
      return original(query, p, o);
    };
  });
  afterAll(async () => cleanup());

  it('every loader sends dates as strings', async () => {
    await loadCompute(scope(), null);
    await loadAgents(scope());
    await loadOutput(scope());
    await loadSpeed(scope());
    await loadTop(scope());
    expect(params.length).toBeGreaterThan(0);
    expect(params.flat().filter((p) => p instanceof Date)).toEqual([]);
  });
});
