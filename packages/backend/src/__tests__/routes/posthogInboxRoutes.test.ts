import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import { workflowRoutes } from '../../routes/workflows.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { internalProxyHeaders, requireAuth } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { workspaces as workspacesTable } from '../../db/schema.js';
import { _resetWorkflowStore } from '../../services/workflows/store.js';
import { resetFeatureFlagsForTests } from '../../services/featureFlags.js';

/**
 * The PostHog Inbox routes: the `posthogInboxRules` gate on every verb, the
 * daily cap on a created rule, the connection status and the dry run's
 * refusals. The dry run against a PostHog project is covered in
 * posthogInboxRules.test.ts.
 */

const headers = { ...internalProxyHeaders(TEST_USER_ID), 'content-type': 'application/json' };
const priorTokenKey = process.env.TALYN_TOKEN_KEY;

const rule = (over: Record<string, unknown> = {}) => ({
  workspaceId: 'ws-mine',
  integration: 'posthog_inbox',
  name: 'Fix ready reports',
  events: ['report_ready'],
  conditions: { priorities: ['P0', 'P1'] },
  actions: [{ type: 'start_session', repositoryId: null, prompt: 'Fix it.' }],
  ...over,
});

describe('PostHog Inbox routes', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let server: Server;

  beforeEach(async () => {
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    process.env.POSTHOG_INBOX_RULES_ENABLED = 'true';
    resetFeatureFlagsForTests();
    _resetWorkflowStore();
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.test' });
    await db.insert(workspacesTable).values({ id: 'ws-mine', ownerId: TEST_USER_ID, name: 'mine', settings: {} });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/workflows', requireAuth, wrapAsyncRoutes(workflowRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workflows`;
  });

  afterEach(async () => {
    if (priorTokenKey === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = priorTokenKey;
    delete process.env.POSTHOG_INBOX_RULES_ENABLED;
    resetFeatureFlagsForTests();
    _resetWorkflowStore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as { success: boolean; data: { id: string } & Record<string, unknown>; error?: string; code?: string } };
  }

  it('creates a rule with the default daily cap, and keeps an edited one', async () => {
    const created = await call('POST', '', rule());
    expect(created.status).toBe(200);
    expect(created.json.data).toMatchObject({ integration: 'posthog_inbox', maxRunsPerDay: 10 });

    const patched = await call('PATCH', `/${created.json.data.id}`, { maxRunsPerDay: 3 });
    expect(patched.json.data).toMatchObject({ maxRunsPerDay: 3 });
    const listed = await call('GET', '?workspaceId=ws-mine&integration=posthog_inbox');
    expect(listed.json.data).toEqual([expect.objectContaining({ id: created.json.data.id, maxRunsPerDay: 3 })]);
  });

  it('refuses a session on a named repository', async () => {
    const res = await call('POST', '', rule({ actions: [{ type: 'start_session', repositoryId: 'r1', prompt: 'x' }] }));
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/report's own repository/);
  });

  it.each([
    ['GET', '/posthog-inbox/status?workspaceId=ws-mine', undefined],
    ['POST', '/posthog-inbox/dry-run', { workspaceId: 'ws-mine', workflow: { conditions: {} } }],
    ['POST', '', rule()],
    ['GET', '?workspaceId=ws-mine&integration=posthog_inbox', undefined],
  ])('hides %s %s behind the flag', async (method, path, body) => {
    process.env.POSTHOG_INBOX_RULES_ENABLED = 'false';
    resetFeatureFlagsForTests();
    const res = await call(method, path, body);
    expect(res.status).toBe(404);
    expect(res.json.code).toBe('posthog_inbox_rules_unavailable');
  });

  it('says the workspace is not connected', async () => {
    const res = await call('GET', '/posthog-inbox/status?workspaceId=ws-mine');
    expect(res.json.data).toMatchObject({ access: 'not_connected', authMethod: null, lastPolledAt: null });
  });

  it('previews a rule without a name or a prompt, and refuses bad conditions', async () => {
    const bad = await call('POST', '/posthog-inbox/dry-run', { workspaceId: 'ws-mine', workflow: { conditions: { priorities: ['P9'] } } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/priority/);
    // Valid conditions, but no PostHog connection to read.
    const noConnection = await call('POST', '/posthog-inbox/dry-run', {
      workspaceId: 'ws-mine',
      workflow: { name: '', actions: [], conditions: { priorities: ['P1'] } },
    });
    expect(noConnection.status).toBe(409);
    expect(noConnection.json.code).toBe('posthog_inbox_unavailable');
  });

  it("refuses another workspace's status", async () => {
    await seedUser(db, { id: 'user-other', email: 'other@example.test' });
    await db.insert(workspacesTable).values({ id: 'ws-theirs', ownerId: 'user-other', name: 'theirs', settings: {} });
    const res = await call('GET', '/posthog-inbox/status?workspaceId=ws-theirs');
    expect([403, 404]).toContain(res.status);
  });
});
