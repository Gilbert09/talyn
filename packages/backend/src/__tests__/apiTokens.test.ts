import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { API_TOKEN_PREFIX, scopeAllows, type ApiScope } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { apiTokens, workspaces } from '../db/schema.js';
import {
  ApiTokenInputError,
  createApiToken,
  hashApiToken,
  listApiTokens,
  parseCreateApiTokenInput,
  revokeApiToken,
  validateApiToken,
} from '../services/apiTokens.js';
import { apiTokenRoutes } from '../routes/apiTokens.js';
import { apiErrorHandler } from '../routes/index.js';
import { wrapAsyncRoutes } from '../middleware/asyncHandler.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';

const valid = { name: 'CI', scopes: ['sessions:read'] as ApiScope[] };

describe('parseCreateApiTokenInput', () => {
  it.each([
    ['no body', undefined, 'name'],
    ['no name', { scopes: ['sessions:read'] }, 'name'],
    ['a blank name', { name: '   ', scopes: ['sessions:read'] }, 'name'],
    ['a name too long', { name: 'x'.repeat(101), scopes: ['sessions:read'] }, 'name'],
    ['no scopes', { name: 'a' }, 'scopes'],
    ['empty scopes', { name: 'a', scopes: [] }, 'scopes'],
    ['an unknown scope', { name: 'a', scopes: ['sessions:read', 'admin'] }, 'scopes'],
    ['scopes not a list', { name: 'a', scopes: 'sessions:read' }, 'scopes'],
    ['an empty binding', { ...valid, workspaceIds: [] }, 'workspaceIds'],
    ['a binding with a blank id', { ...valid, workspaceIds: [''] }, 'workspaceIds'],
    ['a binding not a list', { ...valid, workspaceIds: 'ws-a' }, 'workspaceIds'],
    ['zero days', { ...valid, expiresInDays: 0 }, 'expiresInDays'],
    ['negative days', { ...valid, expiresInDays: -1 }, 'expiresInDays'],
    ['too many days', { ...valid, expiresInDays: 366 }, 'expiresInDays'],
    ['fractional days', { ...valid, expiresInDays: 1.5 }, 'expiresInDays'],
    ['days as text', { ...valid, expiresInDays: '30' }, 'expiresInDays'],
  ])('refuses %s', (_label, body, param) => {
    try {
      parseCreateApiTokenInput(body as never);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiTokenInputError);
      expect((err as ApiTokenInputError).param).toBe(param);
    }
  });

  it.each([
    ['the default expiry', {}, 90],
    ['no expiry', { expiresInDays: null }, null],
    ['one day', { expiresInDays: 1 }, 1],
    ['the longest expiry', { expiresInDays: 365 }, 365],
  ])('accepts %s', (_label, extra, days) => {
    expect(parseCreateApiTokenInput({ ...valid, ...extra }).expiresInDays).toBe(days);
  });

  it('stores scopes once each, in register order, and trims the name', () => {
    const input = parseCreateApiTokenInput({
      name: '  Deploy bot ',
      scopes: ['sessions:write', 'workspaces:read', 'sessions:write'],
      workspaceIds: ['ws-a', 'ws-a'],
    });
    expect(input).toEqual({
      name: 'Deploy bot',
      scopes: ['workspaces:read', 'sessions:write'],
      workspaceIds: ['ws-a'],
      expiresInDays: 90,
    });
  });
});

describe('scopeAllows', () => {
  it.each([
    [['sessions:read'], 'sessions:read', true],
    [['sessions:write'], 'sessions:read', true],
    [['sessions:write'], 'sessions:write', true],
    [['sessions:read'], 'sessions:write', false],
    [['workspaces:read'], 'sessions:read', false],
    [[], 'workspaces:read', false],
  ] as const)('%j allows %s: %s', (granted, required, expected) => {
    expect(scopeAllows(granted, required)).toBe(expected);
  });
});

describe('api tokens', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-a2', ownerId: 'owner-a', name: 'A2' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
  });

  afterEach(async () => {
    await testDb.cleanup();
    vi.unstubAllEnvs();
  });

  it('returns the plaintext once and stores only its hash and a display prefix', async () => {
    const { token, apiToken } = await createApiToken('owner-a', parseCreateApiTokenInput(valid));
    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBeGreaterThan(API_TOKEN_PREFIX.length + 40);
    expect(apiToken.tokenPrefix).toBe(token.slice(0, API_TOKEN_PREFIX.length + 6));
    const [row] = await testDb.db.select().from(apiTokens).where(eq(apiTokens.id, apiToken.id));
    expect(row.tokenHash).toBe(hashApiToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(apiToken)).not.toContain(row.tokenHash);
  });

  it('sets the expiry from the days, or none', async () => {
    const now = new Date('2026-11-01T00:00:00.000Z');
    const a = await createApiToken('owner-a', parseCreateApiTokenInput({ ...valid, expiresInDays: 30 }), { now });
    expect(a.apiToken.expiresAt).toBe('2026-12-01T00:00:00.000Z');
    const b = await createApiToken('owner-a', parseCreateApiTokenInput({ ...valid, expiresInDays: null }), { now });
    expect(b.apiToken.expiresAt).toBeNull();
  });

  it.each([
    ["another owner's workspace", ['ws-b']],
    ['an unknown workspace', ['ws-missing']],
    ['one good and one foreign workspace', ['ws-a', 'ws-b']],
  ])('refuses a binding to %s', async (_label, workspaceIds) => {
    await expect(createApiToken('owner-a', parseCreateApiTokenInput({ ...valid, workspaceIds }))).rejects.toBeInstanceOf(
      ApiTokenInputError,
    );
    expect(await listApiTokens('owner-a')).toEqual([]);
  });

  it("lists only the owner's live tokens, newest first", async () => {
    const first = await createApiToken('owner-a', parseCreateApiTokenInput({ ...valid, name: 'first' }), {
      now: new Date('2026-11-01T00:00:00Z'),
    });
    await createApiToken('owner-a', parseCreateApiTokenInput({ ...valid, name: 'second', workspaceIds: ['ws-a'] }), {
      now: new Date('2026-11-02T00:00:00Z'),
    });
    await createApiToken('owner-b', parseCreateApiTokenInput({ ...valid, name: 'other' }));
    const revoked = await createApiToken('owner-a', parseCreateApiTokenInput({ ...valid, name: 'gone' }));
    await revokeApiToken('owner-a', revoked.apiToken.id);

    const list = await listApiTokens('owner-a');
    expect(list.map((t) => t.name)).toEqual(['second', 'first']);
    expect(list[0].workspaceIds).toEqual(['ws-a']);
    expect(list[1].id).toBe(first.apiToken.id);
    expect(Object.keys(list[0]).sort()).toEqual(
      ['createdAt', 'expiresAt', 'id', 'lastUsedAt', 'name', 'scopes', 'tokenPrefix', 'workspaceIds'].sort(),
    );
  });

  it("revokes only the owner's own live token", async () => {
    const { apiToken } = await createApiToken('owner-a', parseCreateApiTokenInput(valid));
    expect(await revokeApiToken('owner-b', apiToken.id)).toBe(false);
    expect(await revokeApiToken('owner-a', apiToken.id)).toBe(true);
    expect(await revokeApiToken('owner-a', apiToken.id)).toBe(false);
  });

  describe('validateApiToken', () => {
    it('resolves a live token to its owner, scopes and binding', async () => {
      const { token, apiToken } = await createApiToken(
        'owner-a',
        parseCreateApiTokenInput({ ...valid, scopes: ['sessions:write'], workspaceIds: ['ws-a'] }),
      );
      const result = await validateApiToken(`  ${token}  `);
      expect(result).toEqual({
        ok: true,
        principal: expect.objectContaining({
          tokenId: apiToken.id,
          ownerId: 'owner-a',
          email: 'owner-a@example.test',
          scopes: ['sessions:write'],
          workspaceIds: ['ws-a'],
        }),
      });
    });

    it.each([
      ['a Supabase JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig'],
      ['an MCP token', 'talyn_mcp_abcdef'],
      ['a session token', 'talyn_mcs_abcdef'],
      ['the bare prefix', API_TOKEN_PREFIX],
      ['an unknown token', `${API_TOKEN_PREFIX}notarealtoken`],
    ])('refuses %s as invalid_token', async (_label, raw) => {
      expect(await validateApiToken(raw)).toEqual({ ok: false, reason: 'invalid_token' });
    });

    it('refuses a revoked token', async () => {
      const { token, apiToken } = await createApiToken('owner-a', parseCreateApiTokenInput(valid));
      await revokeApiToken('owner-a', apiToken.id);
      expect(await validateApiToken(token)).toEqual({ ok: false, reason: 'token_revoked' });
    });

    it('refuses an expired token, at the instant it expires', async () => {
      const now = new Date('2026-11-01T00:00:00.000Z');
      const { token } = await createApiToken('owner-a', parseCreateApiTokenInput({ ...valid, expiresInDays: 1 }), { now });
      expect((await validateApiToken(token, new Date('2026-11-01T23:59:59.999Z'))).ok).toBe(true);
      expect(await validateApiToken(token, new Date('2026-11-02T00:00:00.000Z'))).toEqual({ ok: false, reason: 'token_expired' });
    });

    it('accepts a token with no expiry years later', async () => {
      const { token } = await createApiToken('owner-a', parseCreateApiTokenInput({ ...valid, expiresInDays: null }));
      expect((await validateApiToken(token, new Date('2036-01-01T00:00:00Z'))).ok).toBe(true);
    });

    it('refuses an owner outside the deployment allow-list', async () => {
      const { token } = await createApiToken('owner-a', parseCreateApiTokenInput(valid));
      vi.stubEnv('TALYN_ALLOWED_EMAILS', 'someone@else.test');
      expect(await validateApiToken(token)).toEqual({ ok: false, reason: 'account_not_allowed' });
      vi.stubEnv('TALYN_ALLOWED_EMAILS', 'OWNER-A@example.test');
      expect((await validateApiToken(token)).ok).toBe(true);
    });

    it('stamps last_used_at at most once a minute', async () => {
      const { token, apiToken } = await createApiToken('owner-a', parseCreateApiTokenInput(valid));
      const stamp = async () =>
        (await testDb.db.select({ at: apiTokens.lastUsedAt }).from(apiTokens).where(eq(apiTokens.id, apiToken.id)))[0].at;
      const t0 = new Date('2026-11-02T10:00:00.000Z');
      await validateApiToken(token, t0);
      expect(await stamp()).toEqual(t0);
      await validateApiToken(token, new Date(t0.getTime() + 30_000));
      expect(await stamp()).toEqual(t0);
      const t2 = new Date(t0.getTime() + 61_000);
      await validateApiToken(token, t2);
      expect(await stamp()).toEqual(t2);
    });
  });

  describe('management routes', () => {
    let server: Server;
    let base: string;

    beforeEach(async () => {
      vi.stubEnv('PUBLIC_API_ENABLED', 'true');
      resetFeatureFlagsForTests();
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const id = req.headers['x-user'] as string;
        req.user = { id, email: `${id}@example.test`, isAdmin: false };
        next();
      });
      app.use('/api-tokens', wrapAsyncRoutes(apiTokenRoutes()));
      app.use(apiErrorHandler);
      server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise((resolve) => server.close(resolve));
      resetFeatureFlagsForTests();
    });

    async function call(method: string, path: string, body?: unknown, user = 'owner-a') {
      const resp = await fetch(`${base}${path}`, {
        method,
        headers: { 'x-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: resp.status, body: await resp.json() };
    }

    it('mints, lists and revokes', async () => {
      const created = await call('POST', '/api-tokens', { name: 'CI', scopes: ['sessions:write'], workspaceIds: ['ws-a'] });
      expect(created.status).toBe(201);
      expect(created.body.data.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
      expect(created.body.data.apiToken).toMatchObject({ name: 'CI', scopes: ['sessions:write'], workspaceIds: ['ws-a'] });

      const list = await call('GET', '/api-tokens');
      expect(list.body.data).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toContain(created.body.data.token);

      expect((await call('DELETE', `/api-tokens/${created.body.data.apiToken.id}`, undefined, 'owner-b')).status).toBe(404);
      expect((await call('DELETE', `/api-tokens/${created.body.data.apiToken.id}`)).status).toBe(200);
      expect((await call('GET', '/api-tokens')).body.data).toEqual([]);
    });

    it('answers 400 with a code for a bad request', async () => {
      const res = await call('POST', '/api-tokens', { name: 'CI', scopes: ['nope'] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_token_request');
    });

    it('refuses to mint when the flag is off, and still lists and revokes', async () => {
      const { apiToken } = await createApiToken('owner-a', parseCreateApiTokenInput(valid));
      vi.stubEnv('PUBLIC_API_ENABLED', 'false');
      resetFeatureFlagsForTests();
      const res = await call('POST', '/api-tokens', valid);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('public_api_unavailable');
      expect((await call('GET', '/api-tokens')).body.data).toHaveLength(1);
      expect((await call('DELETE', `/api-tokens/${apiToken.id}`)).status).toBe(200);
    });
  });
});
