import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { NextFunction, Request, Response } from 'express';
import { adminRoutes } from '../routes/admin/index.js';
import { wrapAsyncRoutes } from '../middleware/asyncHandler.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  apiTokens as apiTokensTable,
  fleetHosts as fleetHostsTable,
  repositories as repositoriesTable,
  repositorySetupSteps as setupStepsTable,
  tasks as tasksTable,
  workbenchChats as chatsTable,
  workbenchEvents as eventsTable,
  workbenchTurnTimings as turnTimingsTable,
  workbenches as workbenchesTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import {
  ADMIN_SESSION_CHAT_COLUMNS,
  ADMIN_SESSION_EVENT_COLUMNS,
  sessionListQuery,
} from '../services/admin/sessions.js';
import { loadSandboxClaims, workbenchClaimQuery, workbenchShortId } from '../services/admin/sandboxClaims.js';
import { workspaceFeatures } from '../services/admin/queries.js';
import { computeHostAlerts, OFFLINE_ALERT_WINDOW_MS } from '../services/admin/hostAlerts.js';
import { hostHealthFromStats } from '../services/admin/fleetProxy.js';
import type { FleetHostView } from '../services/fleetHosts.js';
import type { FleetClient } from '../services/selfHosted/client.js';
import { setWorkbenchFleetClientForTests } from '../services/workbenches/sandboxRuntime.js';
import { resetSandboxStatusCacheForTests } from '../services/workbenches/sandboxStatus.js';
import type { AdminFleetAlerts, AdminPage, AdminSessionDetail, AdminSessionSummary } from '@talyn/shared';

/**
 * The console's Sessions surface, the claims lookup behind the Runs page, and
 * the host alerts banner.
 *
 * Three things are pinned here. Every new route refuses a non-admin. Every new
 * list query leaves the big jsonb columns in Postgres (`settings`, the queued
 * prompts on a chat, the transcript `event`). And the session detail shows what
 * an operator needs without the conversation itself.
 */

function stubAuth(req: Request, _res: Response, next: NextFunction): void {
  const who = req.headers['x-test-user'];
  if (who === 'admin') req.user = { id: 'user-admin', email: 'op@talyn.dev', isAdmin: true };
  else if (who === 'member') req.user = { id: 'user-member', email: 'customer@example.test', isAdmin: false };
  next();
}

const OWNER_ID = 'user-owner';
const WB_ID = '0b1a719c-5cb9-4c14-901f-5b9812345678';
const THREAD_ID = '11111111-2222-3333-4444-555555555555';
const STUCK_ID = '99999999-8888-7777-6666-555555555555';
const ARCHIVED_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let db: Database;
let cleanup: () => Promise<void>;
let url: string;
let server: Server;

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  await seedUser(db, { id: OWNER_ID, email: 'owner@example.test' });
  await db.insert(workspacesTable).values({ id: 'ws1', ownerId: OWNER_ID, name: 'PostHog', settings: {} });
  await db
    .insert(repositoriesTable)
    .values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'posthog/posthog',
      url: 'https://github.com/posthog/posthog',
      settings: { setupTiming: { totalMs: 580000, repositoryMs: 125000, learnedMs: 455000, measuredAt: '2026-11-03T09:00:00.000Z', workbenchId: WB_ID } } as never,
    });
  await db.insert(workbenchesTable).values([
    {
      id: WB_ID,
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      repoFullName: 'posthog/posthog',
      kind: 'session',
      name: 'lisbon',
      title: 'Fix the login flow',
      branch: 'tom/fix-login',
      baseBranch: 'master',
      runtime: 'sandbox',
      agent: 'claude',
      sandboxId: `talyn-wb-${workbenchShortId(WB_ID)}-r5`,
      sandboxState: 'suspended',
      fleetHost: 'hetzner-64',
      status: 'ready',
      settings: { sandboxSize: 'large', keptSandboxIds: ['talyn-wb-old--1'], prompts: { create_pr: 'SECRET PROMPT' } },
      workCheckpointSha: 'abc123',
      workCheckpointAt: new Date('2026-11-03T10:00:00.000Z'),
      workCheckpointBytes: 2048,
    },
    {
      id: THREAD_ID,
      workspaceId: 'ws1',
      repositoryId: null,
      repoFullName: '',
      kind: 'thread',
      name: 'planning',
      branch: '',
      baseBranch: '',
      runtime: 'sandbox',
      agent: 'claude',
      status: 'ready',
    },
    {
      id: STUCK_ID,
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      repoFullName: 'posthog/posthog',
      name: 'oslo',
      branch: 'tom/oslo',
      baseBranch: 'master',
      runtime: 'sandbox',
      agent: 'codex',
      status: 'provisioning',
      updatedAt: new Date(Date.now() - 60 * 60_000),
    },
    {
      id: ARCHIVED_ID,
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      repoFullName: 'posthog/posthog',
      name: 'rome',
      branch: 'tom/rome',
      baseBranch: 'master',
      runtime: 'sandbox',
      agent: 'claude',
      status: 'archived',
      archivedAt: new Date('2026-11-01T00:00:00.000Z'),
    },
  ]);
  await db.insert(chatsTable).values({
    id: 'chat1',
    workbenchId: WB_ID,
    workspaceId: 'ws1',
    title: 'Chat 1',
    agent: 'claude',
    status: 'running',
    turnCount: 3,
    queuedMessages: [{ id: 'q1', text: 'SECRET QUEUED TEXT', queuedAt: '2026-11-03T10:00:00.000Z' }],
  });
  await db.insert(eventsTable).values([
    { chatId: 'chat1', seq: 1, turn: 1, event: { type: 'user', text: 'SECRET TRANSCRIPT' } },
    { chatId: 'chat1', seq: 2, turn: 1, event: { type: 'result', subtype: 'success' } },
  ]);
  await db.insert(turnTimingsTable).values({
    chatId: 'chat1',
    turn: 1,
    workbenchId: WB_ID,
    wallMs: 60000,
    toolMs: 20000,
    modelMs: 40000,
    calls: 4,
  });
  await db.insert(setupStepsTable).values({
    id: 'step1',
    repositoryId: 'repo1',
    stepKey: 'k1',
    command: 'pnpm install',
    kind: 'install',
    phase: 'setup',
    source: 'learned',
    sessionCount: 4,
    confirmedAt: new Date(),
    boxFailureCount: 1,
    boxLastFailure: 'exit 1',
    typicalDurationMs: 90000,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', stubAuth, wrapAsyncRoutes(adminRoutes()));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/admin`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

async function get<T>(path: string, who: 'admin' | 'member' = 'admin'): Promise<{ status: number; data: T }> {
  const res = await fetch(`${url}${path}`, { headers: { 'x-test-user': who } });
  const body = (await res.json()) as { data: T };
  return { status: res.status, data: body.data };
}

describe('new admin routes refuse a non-admin', () => {
  it.each([
    ['/sessions'],
    [`/sessions/${WB_ID}`],
    ['/fleet/alerts'],
    ['/fleet/runs?kind=session&owner=owner'],
  ])('403s %s', async (path) => {
    const res = await fetch(`${url}${path}`, { headers: { 'x-test-user': 'member' } });
    expect(res.status).toBe(403);
    const res2 = await fetch(`${url}${path}`);
    expect(res2.status).toBe(403);
  });

  it.each([['/sessions'], [`/sessions/${WB_ID}`], ['/fleet/alerts'], ['/fleet/runs?kind=session']])(
    'serves an operator on %s',
    async (path) => {
      expect((await get(path)).status).toBe(200);
    },
  );
});

describe('GET /sessions', () => {
  it('lists live sessions and threads across accounts, newest first, without archived ones', async () => {
    const { data } = await get<AdminPage<AdminSessionSummary>>('/sessions');
    expect(data.items.map((s) => s.id).sort()).toEqual([STUCK_ID, THREAD_ID, WB_ID].sort());
    const s = data.items.find((i) => i.id === WB_ID)!;
    expect(s).toMatchObject({
      kind: 'session',
      title: 'Fix the login flow',
      ownerEmail: 'owner@example.test',
      workspaceName: 'PostHog',
      fleetHost: 'hetzner-64',
      sandboxState: 'suspended',
      sandboxSize: 'large',
      chatCount: 1,
      runningChats: 1,
      stuckProvisioning: false,
    });
    expect(JSON.stringify(data)).not.toContain('SECRET');
  });

  it.each([
    ['kind=thread', [THREAD_ID]],
    ['state=archived', [ARCHIVED_ID]],
    ['state=stuck', [STUCK_ID]],
    ['state=asleep', [WB_ID]],
    ['host=hetzner-64', [WB_ID]],
    ['owner=nobody', []],
    ['q=login', [WB_ID]],
  ])('filters on %s', async (query, ids) => {
    const { data } = await get<AdminPage<AdminSessionSummary>>(`/sessions?${query}`);
    expect(data.items.map((s) => s.id).sort()).toEqual([...ids].sort());
  });

  it.each([
    ['suspended', true],
    ['idle', false],
    ['busy', false],
  ])('the asleep filter asks the fleet for a running row whose box is %s', async (fleetStatus, listed) => {
    await db.update(workbenchesTable).set({ sandboxState: 'running' }).where(eq(workbenchesTable.id, WB_ID));
    setWorkbenchFleetClientForTests(async () => ({
      getSandbox: async (id: string) => ({ sandbox: { id, status: fleetStatus }, terminal: false }),
    }) as unknown as FleetClient);
    try {
      const { data } = await get<AdminPage<AdminSessionSummary>>('/sessions?state=asleep');
      expect(data.items.map((s) => s.id)).toEqual(listed ? [WB_ID] : []);
    } finally {
      setWorkbenchFleetClientForTests(null);
      resetSandboxStatusCacheForTests();
    }
  });

  it('the asleep filter leaves out a running row when the fleet does not answer', async () => {
    await db.update(workbenchesTable).set({ sandboxState: 'running' }).where(eq(workbenchesTable.id, WB_ID));
    resetSandboxStatusCacheForTests();
    const { data } = await get<AdminPage<AdminSessionSummary>>('/sessions?state=asleep');
    expect(data.items).toEqual([]);
  });

  it('flags a session provisioning past the stuck window', async () => {
    const { data } = await get<AdminPage<AdminSessionSummary>>('/sessions');
    expect(data.items.find((s) => s.id === STUCK_ID)?.stuckProvisioning).toBe(true);
  });
});

describe('GET /sessions/:id', () => {
  it('shows chats, turns, event types, setup, checkpoint and the kept boxes, and no content', async () => {
    const { data } = await get<AdminSessionDetail>(`/sessions/${WB_ID}`);
    expect(data.chats).toEqual([
      expect.objectContaining({ id: 'chat1', status: 'running', turnCount: 3, queuedCount: 1 }),
    ]);
    expect(data.turns).toEqual([expect.objectContaining({ turn: 1, wallMs: 60000, calls: 4 })]);
    expect(data.events.map((e) => [e.seq, e.type, e.subtype])).toEqual([
      [2, 'result', 'success'],
      [1, 'user', null],
    ]);
    expect(data.workCheckpoint).toEqual({ sha: 'abc123', at: '2026-11-03T10:00:00.000Z', bytes: 2048 });
    expect(data.keptSandboxIds).toEqual(['talyn-wb-old--1']);
    expect(data.setup?.timing).toMatchObject({ totalMs: 580000, thisSession: true });
    expect(data.setup?.steps).toEqual([
      expect.objectContaining({ command: 'pnpm install', live: true, boxFailureCount: 1, typicalDurationMs: 90000 }),
    ]);
    // No fleet in a test: the live read fails, and says why, rather than 500.
    expect(data.sandbox).toBeNull();
    expect(data.sandboxError).toBeTruthy();
    expect(JSON.stringify(data)).not.toContain('SECRET');
  });

  it('404s an unknown session', async () => {
    const res = await fetch(`${url}/sessions/nope`, { headers: { 'x-test-user': 'admin' } });
    expect(res.status).toBe(404);
  });
});

describe('egress', () => {
  it('the session list never selects settings, source or diff_stat whole', () => {
    const { sql } = sessionListQuery({}, 50).toSQL();
    expect(sql).not.toMatch(/"workbenches"\."settings"(,| from)/);
    expect(sql).not.toContain('"diff_stat"');
    expect(sql).not.toContain('"queued_messages"');
    expect(sql).toContain("->> 'sandboxSize'");
  });

  it('the chat projection never selects the prompt-bearing columns', () => {
    const { sql } = db.select(ADMIN_SESSION_CHAT_COLUMNS).from(chatsTable).toSQL();
    for (const col of ['"turn_parser"', '"turn_message"', '"agent_backup"', '"imported_from"']) {
      expect(sql).not.toContain(col);
    }
    // Only its length is read.
    expect(sql).toContain('jsonb_array_length');
  });

  it('the event projection reads the type words, never the event', () => {
    const { sql } = db.select(ADMIN_SESSION_EVENT_COLUMNS).from(eventsTable).toSQL();
    expect(sql).not.toMatch(/"event"(,| from)/);
    expect(sql).toContain("->> 'type'");
  });

  it('the claims lookup never selects settings whole', () => {
    const { sql } = workbenchClaimQuery(['abc'], ['talyn-wb-abc']).toSQL();
    expect(sql).not.toMatch(/"workbenches"\."settings"(,| from)/);
    expect(sql).not.toContain('"transcript"');
  });
});

describe('loadSandboxClaims', () => {
  it('finds the session, task and nothing for an unknown box', async () => {
    await db.insert(tasksTable).values({
      id: '325792e2-4f3c-4a73-b04d-f10e7b361b2a',
      workspaceId: 'ws1',
      type: 'pr_response',
      status: 'in_progress',
      priority: 'medium',
      title: 'Fix CI',
      description: 'd',
      metadata: { cloudTask: { provider: 'selfhosted', remoteRunId: 'talyn-325792e2-4f3c-4a73-b04d-f10e7b361b2a', extra: { host: 'scaleway-1' } } },
    });
    const claims = await loadSandboxClaims([
      `talyn-wb-${workbenchShortId(WB_ID)}-r5--3542ee`,
      'talyn-325792e2-4f3c-4a73-b04d-f10e7b361b2a',
      'deploy-api-1',
    ]);
    expect(claims.workbenches.map((w) => w.id)).toEqual([WB_ID]);
    expect(claims.workbenches[0]).toMatchObject({ sandboxSize: 'large', keptSandboxIds: ['talyn-wb-old--1'], ownerEmail: 'owner@example.test' });
    expect(claims.tasks.get('325792e2-4f3c-4a73-b04d-f10e7b361b2a')).toMatchObject({ fleetHost: 'scaleway-1', title: 'Fix CI' });
  });
});

describe('host alerts', () => {
  const stats = (conditions: unknown[]) => ({ health: { diskPressure: 'low', diskFreeBytes: 1 }, conditions });

  it('lists the conditions each online host reports, critical first', async () => {
    const now = Date.now();
    await db.insert(fleetHostsTable).values([
      { name: 'hetzner-64', reportedAt: new Date(now - 5_000), apiEndpoint: 'http://h' },
      { name: 'scaleway-1', reportedAt: new Date(now - 5_000), apiEndpoint: 'http://s' },
    ]);
    const read = async (host: FleetHostView) =>
      host.name === 'hetzner-64'
        ? stats([{ kind: 'bake_failing', severity: 'warning', detail: 'bakes' }])
        : stats([{ kind: 'disk_low', severity: 'critical', detail: 'disk' }]);
    const result: AdminFleetAlerts = await computeHostAlerts(now, read);
    expect(result.alerts.map((a) => [a.host, a.kind, a.severity])).toEqual([
      ['scaleway-1', 'disk_low', 'critical'],
      ['hetzner-64', 'bake_failing', 'warning'],
    ]);
  });

  it.each([
    ['a host offline for an hour', 60 * 60_000, true],
    ['a host retired a week ago', OFFLINE_ALERT_WINDOW_MS + 60_000, false],
  ])('alerts on %s: %s', async (_label, ago, alerted) => {
    const now = Date.now();
    await db.insert(fleetHostsTable).values({ name: 'old-box', reportedAt: new Date(now - ago) });
    const result = await computeHostAlerts(now, async () => null);
    expect(result.alerts.some((a) => a.kind === 'host_offline' && a.host === 'old-box')).toBe(alerted);
  });

  it('shows nothing for a healthy host or one we could not read', async () => {
    const now = Date.now();
    await db.insert(fleetHostsTable).values({ name: 'hetzner-64', reportedAt: new Date(now) });
    expect((await computeHostAlerts(now, async () => stats([]))).alerts).toEqual([]);
    expect((await computeHostAlerts(now, async () => null)).alerts).toEqual([]);
  });
});

describe('hostHealthFromStats', () => {
  it('reads health, conditions and box counts', () => {
    const out = hostHealthFromStats({
      runsByStatus: { busy: 2, idle: 1, starting: 1, suspended: 7, queued: 1, stopped: 30 },
      health: {
        diskFreeBytes: 5 * 1024 ** 3,
        diskPressure: 'critical',
        diskReserveMib: 20480,
        diskTopWriters: [{ id: 'talyn-wb-x', writtenMib: 9000, rateMibPerMin: 400 }],
        hibernateUploadFailing: 2,
        bake: { failingRepos: 1, maxConsecutiveFailures: 4 },
      },
      conditions: [{ kind: 'disk_low', severity: 'critical', detail: 'store full' }],
    });
    expect(out.boxes).toEqual({ running: 4, asleep: 7, queued: 1 });
    expect(out.health).toMatchObject({
      diskPressure: 'critical',
      diskReserveMib: 20480,
      hibernateUploadFailing: 2,
      bakeFailingRepos: 1,
      bakeMaxConsecutiveFailures: 4,
      diskTopWriters: [{ id: 'talyn-wb-x', writtenMib: 9000, rateMibPerMin: 400 }],
    });
    expect(out.conditions).toEqual([{ kind: 'disk_low', severity: 'critical', detail: 'store full' }]);
  });

  it('reads an older fleetd with neither field as unknown, not healthy', () => {
    expect(hostHealthFromStats({ runsByStatus: {} })).toEqual({
      health: null,
      conditions: null,
      boxes: { running: 0, asleep: 0, queued: 0 },
    });
  });
});

describe('workspaceFeatures', () => {
  it('counts live sessions and threads, and the owner tokens that reach the workspace', async () => {
    const token = (id: string, over: Partial<typeof apiTokensTable.$inferInsert> = {}) => ({
      id,
      ownerId: OWNER_ID,
      name: id,
      tokenPrefix: id,
      tokenHash: `hash-${id}`,
      scopes: ['read'],
      ...over,
    });
    await db.insert(apiTokensTable).values([
      token('all-workspaces'),
      token('this-workspace', { workspaceIds: ['ws1'] }),
      token('other-workspace', { workspaceIds: ['ws2'] }),
      token('revoked', { revokedAt: new Date() }),
    ]);
    expect(await workspaceFeatures('ws1', OWNER_ID)).toEqual({
      // The archived session is not counted.
      sessions: 2,
      threads: 1,
      loops: { enabled: 0, total: 0 },
      workflows: { enabled: 0, total: 0 },
      mcpServers: 0,
      webhookEndpoints: 0,
      apiTokens: 2,
    });
  });

  it('scopes the sessions list to one workspace', async () => {
    const { data } = await get<AdminPage<AdminSessionSummary>>('/sessions?workspaceId=nope');
    expect(data.items).toEqual([]);
  });
});
