import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import cors from 'cors';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { callPublic, mintToken, startPublicApi } from './helpers/publicApi.js';
import { repositories, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import { MemoryRateLimitStore } from '../middleware/publicRateLimit.js';
import { publicApiRouter } from '../routes/public/index.js';
import { revokeApiToken, validateApiToken } from '../services/apiTokens.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import { PublicApiError, toPublicApiError } from '../services/public/errors.js';
import { LoopLimitError, MergeQueueLimitError, TaskLimitError } from '../services/billing/entitlements.js';
import { WorkbenchError } from '../services/workbenches/errors.js';
import { AccessError } from '../middleware/auth.js';

/**
 * Who gets through `/v1`, and what a refusal looks like: tokens, scopes, the
 * `publicApi` and `workbenches` flags, workspace binding, tenancy, request
 * ids, and no CORS.
 */

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let api: Awaited<ReturnType<typeof startPublicApi>>;

beforeAll(async () => {
  testDb = await createTestDb();
  await seedUser(testDb.db, { id: 'owner-a' });
  await seedUser(testDb.db, { id: 'owner-b' });
  await testDb.db.insert(workspaces).values([
    { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
    { id: 'ws-a2', ownerId: 'owner-a', name: 'A2' },
    { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
  ]);
  await testDb.db.insert(repositories).values([
    { id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main' },
    { id: 'repo-a2', workspaceId: 'ws-a2', name: 'acme/two', url: 'https://github.com/acme/two', defaultBranch: 'main' },
    { id: 'repo-b', workspaceId: 'ws-b', name: 'other/app', url: 'https://github.com/other/app', defaultBranch: 'main' },
  ]);
  await testDb.db.insert(workbenches).values([
    { id: 'wb-a2', workspaceId: 'ws-a2', repositoryId: 'repo-a2', repoFullName: 'acme/two', name: 'a2', branch: 'a2', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready' },
    { id: 'wb-b', workspaceId: 'ws-b', repositoryId: 'repo-b', repoFullName: 'other/app', name: 'b', branch: 'b', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready' },
  ]);
  await testDb.db.insert(workbenchChats).values([
    { id: 'chat-a2', workbenchId: 'wb-a2', workspaceId: 'ws-a2', title: 'Chat', agent: 'claude' },
    { id: 'chat-b', workbenchId: 'wb-b', workspaceId: 'ws-b', title: 'Chat', agent: 'claude' },
  ]);
  api = await startPublicApi();
});

afterAll(async () => {
  await api.close();
  await testDb.cleanup();
});

beforeEach(() => {
  vi.stubEnv('PUBLIC_API_ENABLED', 'true');
  vi.stubEnv('WORKBENCHES_ENABLED', 'true');
  resetFeatureFlagsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetFeatureFlagsForTests();
});

const get = (path: string, token?: string, headers?: Record<string, string>) => callPublic(api.base, 'GET', path, { token, headers });

describe('tokens', () => {
  it('refuses a request with no token, with a challenge and a request id', async () => {
    const res = await get('/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ type: 'authentication_error', code: 'missing_token' });
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    expect(res.headers.get('x-request-id')).toMatch(/^req_[0-9A-Z]{26}$/);
    expect(res.body.error.request_id).toBe(res.headers.get('x-request-id'));
  });

  it.each([
    ['a Supabase JWT', 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJvd25lci1hIn0.c2ln'],
    ['a personal MCP token', 'talyn_mcp_abcdefghijklmnop'],
    ['a session token', 'talyn_mcs_abcdefghijklmnop'],
    ['an unknown PAT', 'talyn_pat_doesnotexist'],
  ])('refuses %s as invalid_token', async (_label, raw) => {
    const res = await get('/me', raw);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_token');
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('refuses a revoked token', async () => {
    const token = await mintToken('owner-a');
    const result = await validateApiToken(token);
    if (!result.ok) throw new Error('expected a valid token');
    await revokeApiToken('owner-a', result.principal.tokenId);
    const res = await get('/me', token);
    expect([res.status, res.body.error.code]).toEqual([401, 'token_revoked']);
  });

  it('refuses an expired token', async () => {
    const token = await mintToken('owner-a', { expiresInDays: 1, now: new Date('2020-01-01T00:00:00Z') });
    const res = await get('/me', token);
    expect([res.status, res.body.error.code]).toEqual([401, 'token_expired']);
  });

  it('answers /me with the token and its owner', async () => {
    const token = await mintToken('owner-a', { scopes: ['sessions:read'], workspaceIds: ['ws-a'] });
    const res = await get('/me', token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: 'token',
      token: { name: 'test', scopes: ['sessions:read'], workspace_ids: ['ws-a'] },
      user: { id: 'owner-a', email: 'owner-a@example.test' },
    });
    expect(res.headers.get('ratelimit-limit')).toBe('600');
  });

  it('answers an unknown route with a 404 in the public shape', async () => {
    const res = await get('/nope', await mintToken('owner-a'));
    expect([res.status, res.body.error.type, res.body.error.code]).toEqual([404, 'not_found_error', 'route_not_found']);
  });
});

describe('the publicApi flag', () => {
  it('refuses every authenticated route when it is off for the owner', async () => {
    const token = await mintToken('owner-a');
    vi.stubEnv('PUBLIC_API_ENABLED', 'false');
    resetFeatureFlagsForTests();
    for (const path of ['/me', '/workspaces', '/sessions?workspace_id=ws-a']) {
      const res = await get(path, token);
      expect([res.status, res.body.error.type, res.body.error.code], path).toEqual([403, 'permission_error', 'public_api_unavailable']);
    }
  });

  it('fails closed with no PostHog key and no override', async () => {
    const token = await mintToken('owner-a');
    vi.stubEnv('PUBLIC_API_ENABLED', '');
    vi.stubEnv('TALYN_POSTHOG_KEY', '');
    resetFeatureFlagsForTests();
    expect((await get('/me', token)).status).toBe(403);
  });

  it('still serves the spec, which needs no token', async () => {
    vi.stubEnv('PUBLIC_API_ENABLED', 'false');
    resetFeatureFlagsForTests();
    const res = await get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
  });
});

describe('scopes', () => {
  it.each([
    ['GET', '/workspaces', ['sessions:read'], 'workspaces:read'],
    ['GET', '/repositories?workspace_id=ws-a', ['workspaces:read'], 'repositories:read'],
    ['GET', '/sessions?workspace_id=ws-a', ['workspaces:read'], 'sessions:read'],
    ['POST', '/sessions', ['sessions:read'], 'sessions:write'],
    ['POST', '/chats/chat-a2/messages', ['sessions:read'], 'sessions:write'],
    ['GET', '/chats/chat-a2/events', ['repositories:read'], 'sessions:read'],
  ] as const)('refuses %s %s without the scope', async (method, path, scopes, required) => {
    const token = await mintToken('owner-a', { scopes: [...scopes] });
    const res = await callPublic(api.base, method, path, { token, body: method === 'POST' ? {} : undefined });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ type: 'permission_error', code: 'insufficient_scope', required_scope: required });
    expect(res.headers.get('www-authenticate')).toContain(`scope="${required}"`);
  });

  it('lets a write scope read', async () => {
    const token = await mintToken('owner-a', { scopes: ['sessions:write'] });
    expect((await get('/sessions?workspace_id=ws-a', token)).status).toBe(200);
  });
});

describe('the workbenches flag', () => {
  it('refuses session routes when sessions are off for the owner, and leaves workspaces alone', async () => {
    const token = await mintToken('owner-a');
    vi.stubEnv('WORKBENCHES_ENABLED', 'false');
    resetFeatureFlagsForTests();
    const res = await get('/sessions?workspace_id=ws-a', token);
    expect([res.status, res.body.error.code]).toEqual([403, 'workbenches_unavailable']);
    expect((await get('/chats/chat-a2', token)).status).toBe(403);
    expect((await get('/workspaces', token)).status).toBe(200);
  });
});

describe('tenancy and binding', () => {
  it.each([
    ['/workspaces/ws-b', 'workspace_not_found'],
    ['/repositories?workspace_id=ws-b', 'workspace_not_found'],
    ['/sessions?workspace_id=ws-b', 'workspace_not_found'],
    ['/sessions/wb-b', 'session_not_found'],
    ['/chats/chat-b', 'chat_not_found'],
    ['/chats/chat-b/events', 'chat_not_found'],
    ['/workspaces/ws-missing', 'workspace_not_found'],
  ])("answers 404 for another owner's %s", async (path, code) => {
    const res = await get(path, await mintToken('owner-a'));
    expect([res.status, res.body.error.code]).toEqual([404, code]);
  });

  it('a bound token sees only its workspaces, and the rest as missing', async () => {
    const token = await mintToken('owner-a', { workspaceIds: ['ws-a'] });
    const list = await get('/workspaces', token);
    expect(list.body.data.map((w: { id: string }) => w.id)).toEqual(['ws-a']);
    for (const [path, code] of [
      ['/workspaces/ws-a2', 'workspace_not_found'],
      ['/repositories?workspace_id=ws-a2', 'workspace_not_found'],
      ['/sessions/wb-a2', 'session_not_found'],
      ['/chats/chat-a2', 'chat_not_found'],
    ]) {
      const res = await get(path, token);
      expect([res.status, res.body.error.code], path).toEqual([404, code]);
    }
    // Bound to one workspace: workspace_id may be left out.
    const repos = await get('/repositories', token);
    expect(repos.body.data.map((r: { id: string }) => r.id)).toEqual(['repo-a']);
  });

  it('an unbound token sees every workspace of its owner and needs workspace_id on lists', async () => {
    const token = await mintToken('owner-a');
    const list = await get('/workspaces', token);
    expect(list.body.data.map((w: { id: string }) => w.id).sort()).toEqual(['ws-a', 'ws-a2']);
    const repos = await get('/repositories', token);
    expect([repos.status, repos.body.error.param]).toEqual([400, 'workspace_id']);
    const a2 = await get('/repositories?workspace_id=ws-a2', token);
    expect(a2.body.data).toEqual([expect.objectContaining({ id: 'repo-a2', full_name: 'acme/two' })]);
  });
});

describe('no CORS', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    // The app's order: /v1 first, then the global cors() that allows the app's own origin.
    const app = express();
    app.use('/v1', publicApiRouter({ rateLimitStore: new MemoryRateLimitStore() }));
    app.use(cors({ origin: (_o, cb) => cb(null, true) }));
    app.get('/elsewhere', (_req, res) => {
      res.json({});
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  it('sends no Access-Control header on /v1, for a request or a preflight', async () => {
    const token = await mintToken('owner-a');
    const origin = { origin: 'https://app.talyn.dev' };
    const res = await fetch(`${base}/v1/me`, { headers: { ...origin, authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(`${base}/v1/me`, {
      method: 'OPTIONS',
      headers: { ...origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    // The control: the same app does answer CORS outside /v1.
    const control = await fetch(`${base}/elsewhere`, { headers: origin });
    expect(control.headers.get('access-control-allow-origin')).not.toBeNull();
  });
});

describe('error mapping', () => {
  it.each([
    [new TaskLimitError(3, 3), 'task_limit_reached', { limit: 3, in_use: 3 }],
    [new MergeQueueLimitError(3, 2), 'merge_queue_limit_reached', { limit: 3, in_use: 2 }],
    [new LoopLimitError(3, 3), 'loop_limit_reached', { limit: 3, in_use: 3 }],
  ])('maps a plan limit to a 402 with its code and numbers', (err, code, details) => {
    const mapped = toPublicApiError(err);
    expect(mapped.status).toBe(402);
    expect(mapped.type).toBe('plan_limit_error');
    expect(mapped.code).toBe(code);
    expect(mapped.options.details).toEqual(details);
  });

  it.each([
    [new WorkbenchError('This session is still starting.', 409, 'not_ready'), 409, 'conflict_error', 'not_ready'],
    [new WorkbenchError('That repository is not connected to this workspace.', 400, ''), 400, 'invalid_request_error', 'invalid_request'],
    [new AccessError('workspace not found'), 404, 'not_found_error', 'not_found'],
  ])('maps %s', (err, status, type, code) => {
    const mapped = toPublicApiError(err);
    expect([mapped.status, mapped.type, mapped.code]).toEqual([status, type, code]);
  });

  it('never sends the message of an unknown fault', () => {
    const mapped = toPublicApiError(new Error('Failed query: select "token_hash" from "api_tokens"'));
    expect(mapped).toBeInstanceOf(PublicApiError);
    expect([mapped.status, mapped.type, mapped.code]).toEqual([500, 'api_error', 'internal_error']);
    expect(mapped.message).not.toContain('token_hash');
  });
});
