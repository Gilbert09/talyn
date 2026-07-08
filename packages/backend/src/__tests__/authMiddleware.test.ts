import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  errors as joseErrors,
  type KeyLike,
} from 'jose';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  extractBearerToken,
  requireAuth,
  handleAccessError,
  AccessError,
  AuthError,
  requireWorkspaceAccess,
  requireEnvironmentAccess,
  requireTaskAccess,
  requireRepositoryAccess,
  assertUser,
  internalProxyHeaders,
  setJwtKeySourceForTesting,
  verifyTokenAndGetUser,
} from '../middleware/auth.js';
import { setSupabaseServiceClientForTesting } from '../services/supabase.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  tasks as tasksTable,
  repositories as repositoriesTable,
} from '../db/schema.js';

const OTHER_USER_ID = 'user-other';

describe('extractBearerToken', () => {
  it('parses a well-formed Bearer header', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('returns null for a missing header', () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('returns null for a non-Bearer scheme', () => {
    expect(extractBearerToken('Basic deadbeef')).toBeNull();
  });

  it('is case-insensitive on the scheme', () => {
    expect(extractBearerToken('bearer my-token')).toBe('my-token');
  });

  it('trims leading/trailing whitespace in the token', () => {
    expect(extractBearerToken('Bearer   spaced-token   ')).toBe('spaced-token');
  });
});

describe('handleAccessError', () => {
  function makeRes() {
    const statusCalls: number[] = [];
    const bodies: unknown[] = [];
    return {
      status(code: number) {
        statusCalls.push(code);
        return this;
      },
      json(b: unknown) {
        bodies.push(b);
        return this;
      },
      statusCalls,
      bodies,
    };
  }

  it('maps AccessError to 404 with the error message', () => {
    const res = makeRes();
    handleAccessError(new AccessError('not found'), res as unknown as express.Response);
    expect(res.statusCalls).toEqual([404]);
    expect(res.bodies[0]).toEqual({ success: false, error: 'not found' });
  });

  it('maps unknown errors to 500 with a generic message', () => {
    const res = makeRes();
    handleAccessError(new Error('boom'), res as unknown as express.Response);
    expect(res.statusCalls).toEqual([500]);
    expect(res.bodies[0]).toEqual({ success: false, error: 'Internal error' });
  });
});

describe('assertUser', () => {
  it('returns req.user when it is set', () => {
    const req = { user: { id: 'u', email: 'e' } } as unknown as express.Request;
    expect(assertUser(req)).toEqual({ id: 'u', email: 'e' });
  });

  it('throws when requireAuth has not run yet', () => {
    const req = {} as unknown as express.Request;
    expect(() => assertUser(req)).toThrow(/requireAuth/);
  });
});

describe('AuthError', () => {
  it('carries the code field alongside the message', () => {
    const err = new AuthError('unauthorized', 'bad token');
    expect(err.code).toBe('unauthorized');
    expect(err.message).toBe('bad token');
    expect(err).toBeInstanceOf(Error);
  });
});

// ---- Integration: the requireAuth middleware over a real Express server ----

async function makeProbeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.get('/probe', requireAuth, (req, res) => {
    res.json({ userId: req.user?.id });
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('requireAuth (JWT + internal-proxy)', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    const s = await makeProbeServer();
    serverUrl = s.url;
    closeServer = s.close;
  });

  afterEach(async () => {
    await closeServer();
    await cleanup();
  });

  it('401s when no headers are provided', async () => {
    expect((await fetch(`${serverUrl}/probe`)).status).toBe(401);
  });

  it('401s when the Bearer token is malformed (no Supabase round-trip needed)', async () => {
    const res = await fetch(`${serverUrl}/probe`, {
      headers: { authorization: 'Bearer ' },
    });
    // Empty token after "Bearer " → extractBearerToken returns null → 401.
    expect(res.status).toBe(401);
  });

  it('accepts valid internal-proxy headers', async () => {
    const res = await fetch(`${serverUrl}/probe`, {
      headers: internalProxyHeaders(TEST_USER_ID),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe(TEST_USER_ID);
  });

  it('401s with "malformed" header error when one internal header is missing', async () => {
    // Only the token present — no user id → checkInternalAuth returns
    // null (missing → no-op). Then the Bearer path is taken and it's
    // empty → 401 "Missing bearer token".
    const res = await fetch(`${serverUrl}/probe`, {
      headers: {
        'x-fastowl-internal-token': 'anything',
      },
    });
    expect(res.status).toBe(401);
  });

  it('401s when the internal token is wrong', async () => {
    const res = await fetch(`${serverUrl}/probe`, {
      headers: {
        'x-fastowl-internal-token': 'not-the-real-secret',
        'x-fastowl-internal-user': TEST_USER_ID,
      },
    });
    expect(res.status).toBe(401);
  });

  it('401s when the internal user id does not exist in the users table', async () => {
    const res = await fetch(`${serverUrl}/probe`, {
      headers: internalProxyHeaders('no-such-user'),
    });
    expect(res.status).toBe(401);
  });
});

// ---- Supabase JWT verification: local (ES256/JWKS) + legacy (HS256) paths ----

const TEST_SUPABASE_URL = 'https://test-project.supabase.co';
const JWT_USER_ID = 'user-from-jwt';

describe('requireAuth (Supabase JWT verification)', () => {
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;
  let privateKey: KeyLike;
  let savedSupabaseUrl: string | undefined;

  async function makeKeySource(key: KeyLike) {
    const jwk = await exportJWK(key);
    return createLocalJWKSet({
      keys: [{ ...jwk, kid: 'test-key', alg: 'ES256', use: 'sig' }],
    });
  }

  function signEs256(
    key: KeyLike,
    overrides: {
      issuer?: string;
      audience?: string;
      sub?: string;
      expired?: boolean;
    } = {}
  ) {
    const nowSec = Math.floor(Date.now() / 1000);
    return new SignJWT({
      email: 'jwt@test',
      user_metadata: { user_name: 'jwt-gh-user' },
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setIssuer(overrides.issuer ?? `${TEST_SUPABASE_URL}/auth/v1`)
      .setAudience(overrides.audience ?? 'authenticated')
      .setSubject(overrides.sub ?? JWT_USER_ID)
      .setIssuedAt(nowSec - 600)
      .setExpirationTime(overrides.expired ? nowSec - 300 : nowSec + 300)
      .sign(key);
  }

  function signHs256() {
    const nowSec = Math.floor(Date.now() / 1000);
    return new SignJWT({ email: 'legacy@test' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(`${TEST_SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setSubject(JWT_USER_ID)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 300)
      .sign(new TextEncoder().encode('legacy-shared-secret'));
  }

  function stubSupabaseGetUser(
    impl: () => Promise<{ data: { user: unknown }; error: unknown }>
  ) {
    setSupabaseServiceClientForTesting({
      auth: { getUser: impl },
    } as unknown as SupabaseClient);
  }

  beforeEach(async () => {
    savedSupabaseUrl = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = TEST_SUPABASE_URL;
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;
    const s = await makeProbeServer();
    serverUrl = s.url;
    closeServer = s.close;
    const pair = await generateKeyPair('ES256');
    privateKey = pair.privateKey;
    setJwtKeySourceForTesting(await makeKeySource(pair.publicKey));
  });

  afterEach(async () => {
    setJwtKeySourceForTesting(null);
    setSupabaseServiceClientForTesting(null);
    if (savedSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = savedSupabaseUrl;
    await closeServer();
    await cleanup();
  });

  async function probe(token: string) {
    return fetch(`${serverUrl}/probe`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('accepts a valid ES256 token with no Supabase round-trip and upserts the user', async () => {
    // No Supabase stub installed — a remote getUser call would throw.
    const res = await probe(await signEs256(privateKey));
    expect(res.status).toBe(200);
    expect((await res.json()).userId).toBe(JWT_USER_ID);
  });

  it('401s an expired token', async () => {
    const res = await probe(await signEs256(privateKey, { expired: true }));
    expect(res.status).toBe(401);
  });

  it('401s a token signed by a different key', async () => {
    const { privateKey: otherKey } = await generateKeyPair('ES256');
    const res = await probe(await signEs256(otherKey));
    expect(res.status).toBe(401);
  });

  it.each([
    ['issuer', { issuer: 'https://evil.example.com/auth/v1' }],
    ['audience', { audience: 'anon' }],
  ] as const)('401s a token with the wrong %s claim', async (_label, overrides) => {
    const res = await probe(await signEs256(privateKey, overrides));
    expect(res.status).toBe(401);
  });

  it('401s garbage that is not a JWT at all', async () => {
    const res = await probe('not-a-jwt');
    expect(res.status).toBe(401);
  });

  it('503s (never 401s) when the signing keys cannot be fetched', async () => {
    setJwtKeySourceForTesting(() => {
      throw new joseErrors.JWKSTimeout();
    });
    const res = await probe(await signEs256(privateKey));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'auth_unavailable' });
  });

  it('routes legacy HS256 tokens through Supabase and accepts a confirmed user', async () => {
    stubSupabaseGetUser(async () => ({
      data: {
        user: {
          id: JWT_USER_ID,
          email: 'legacy@test',
          user_metadata: { user_name: 'legacy-gh' },
        },
      },
      error: null,
    }));
    const res = await probe(await signHs256());
    expect(res.status).toBe(200);
    expect((await res.json()).userId).toBe(JWT_USER_ID);
  });

  it('401s an HS256 token that Supabase explicitly rejects (4xx)', async () => {
    stubSupabaseGetUser(async () => ({
      data: { user: null },
      error: { name: 'AuthApiError', status: 401, message: 'invalid JWT' },
    }));
    const res = await probe(await signHs256());
    expect(res.status).toBe(401);
  });

  it.each([
    ['a network failure', { name: 'AuthRetryableFetchError', status: 0 }],
    ['a 5xx from Supabase', { name: 'AuthApiError', status: 502 }],
    ['an error with no status', { name: 'AuthUnknownError' }],
  ])('503s when the HS256 check hits %s', async (_label, error) => {
    stubSupabaseGetUser(async () => ({ data: { user: null }, error }));
    const res = await probe(await signHs256());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'auth_unavailable' });
  });

  it('times out a hanging HS256 check as unavailable instead of stalling ~20s', async () => {
    const hsToken = await signHs256();
    vi.useFakeTimers();
    try {
      stubSupabaseGetUser(() => new Promise(() => {}));
      const pending = verifyTokenAndGetUser(hsToken);
      const assertion = expect(pending).rejects.toMatchObject({ code: 'unavailable' });
      await vi.advanceTimersByTimeAsync(5_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- Ownership helpers (exercised without the real HTTP route layer) ----

function makeReq(userId: string): express.Request {
  return { user: { id: userId, email: `${userId}@test` } } as unknown as express.Request;
}

describe('ownership helpers', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await seedUser(db, { id: OTHER_USER_ID });
    await db.insert(workspacesTable).values([
      { id: 'ws-mine', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
      { id: 'ws-theirs', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
    ]);
  });

  afterEach(async () => {
    await cleanup();
  });

  it('requireWorkspaceAccess passes for the owner and 404s otherwise', async () => {
    await expect(
      requireWorkspaceAccess(makeReq(TEST_USER_ID), 'ws-mine')
    ).resolves.toBeUndefined();
    await expect(
      requireWorkspaceAccess(makeReq(TEST_USER_ID), 'ws-theirs')
    ).rejects.toThrow(AccessError);
    await expect(
      requireWorkspaceAccess(makeReq(TEST_USER_ID), 'missing')
    ).rejects.toThrow(AccessError);
  });

  it('requireEnvironmentAccess uses the env.ownerId column directly', async () => {
    await db.insert(environmentsTable).values([
      {
        id: 'env-mine', ownerId: TEST_USER_ID, name: 'e', type: 'local',
        status: 'connected', config: {},
      },
      {
        id: 'env-theirs', ownerId: OTHER_USER_ID, name: 'e', type: 'local',
        status: 'connected', config: {},
      },
    ]);
    await expect(
      requireEnvironmentAccess(makeReq(TEST_USER_ID), 'env-mine')
    ).resolves.toBeUndefined();
    await expect(
      requireEnvironmentAccess(makeReq(TEST_USER_ID), 'env-theirs')
    ).rejects.toThrow(AccessError);
  });

  it('requireTaskAccess walks via workspaces.owner_id', async () => {
    const now = new Date();
    await db.insert(tasksTable).values([
      {
        id: 't-mine', workspaceId: 'ws-mine', type: 'code_writing',
        status: 'queued', priority: 'medium', title: 't', description: 'd',
        createdAt: now, updatedAt: now,
      },
      {
        id: 't-theirs', workspaceId: 'ws-theirs', type: 'code_writing',
        status: 'queued', priority: 'medium', title: 't', description: 'd',
        createdAt: now, updatedAt: now,
      },
    ]);
    const ws = await requireTaskAccess(makeReq(TEST_USER_ID), 't-mine');
    expect(ws).toBe('ws-mine');
    await expect(
      requireTaskAccess(makeReq(TEST_USER_ID), 't-theirs')
    ).rejects.toThrow(AccessError);
    await expect(
      requireTaskAccess(makeReq(TEST_USER_ID), 'missing')
    ).rejects.toThrow(AccessError);
  });

  it('requireRepositoryAccess honours workspace ownership', async () => {
    await db.insert(repositoriesTable).values([
      {
        id: 'rp-mine', workspaceId: 'ws-mine', name: 'a',
        url: 'https://github.com/a/b', defaultBranch: 'main',
      },
      {
        id: 'rp-theirs', workspaceId: 'ws-theirs', name: 'a',
        url: 'https://github.com/a/b', defaultBranch: 'main',
      },
    ]);

    await expect(
      requireRepositoryAccess(makeReq(TEST_USER_ID), 'rp-mine')
    ).resolves.toBe('ws-mine');
    await expect(
      requireRepositoryAccess(makeReq(TEST_USER_ID), 'rp-theirs')
    ).rejects.toThrow(AccessError);
  });
});
