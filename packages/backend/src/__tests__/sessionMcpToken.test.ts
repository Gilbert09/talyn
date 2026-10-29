import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireMcpToken } from '../mcp/requireMcpToken.js';
import { repositories, sessionMcpTokens, workbenches, workspaces } from '../db/schema.js';
import { createToken } from '../services/mcpToken.js';
import {
  chatWorkbenchId,
  ensureSessionMcpToken,
  MAX_SESSION_SPAWN_DEPTH,
  readSessionMcpToken,
  recordSessionSpawn,
  reserveSessionCreate,
  revokeSessionMcpToken,
  SESSION_CREATES_PER_HOUR,
  SessionSpawnRefusedError,
  validateSessionMcpToken,
  type SessionMcpBinding,
} from '../services/sessionMcpToken.js';
import { deleteWorkbenchRow, insertChat, insertWorkbench, updateWorkbench } from '../services/workbenches/store.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';

const OTHER = 'user-other';
const SESSION = { id: 'wb', workspaceId: 'ws' };
/** A window start long past: the next create opens a new window. */
const OLD_WINDOW = new Date('2000-01-01T00:00:00Z');

async function seedSession(id: string, workspaceId = 'ws', patch: Record<string, unknown> = {}) {
  await insertWorkbench({
    id, workspaceId, repositoryId: workspaceId === 'ws' ? 'repo' : 'repo-other', repoFullName: 'a/b',
    name: id, branch: id, baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
    sandboxState: 'running', sandboxId: `talyn-wb-${id}`, ...patch,
  });
}

function fakeRes() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
}

async function authenticate(token: string) {
  const req = { headers: { authorization: `Bearer ${token}` } } as Request;
  const res = fakeRes();
  const next = vi.fn();
  await requireMcpToken(req, res as unknown as Response, next);
  return { req, res, next };
}

describe('session MCP tokens', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: TEST_USER_ID });
    await seedUser(testDb.db, { id: OTHER });
    await testDb.db.insert(workspaces).values([
      { id: 'ws', ownerId: TEST_USER_ID, name: 'Mine' },
      { id: 'ws-other', ownerId: OTHER, name: 'Theirs' },
    ]);
    await testDb.db.insert(repositories).values([
      { id: 'repo', workspaceId: 'ws', name: 'a/b', url: 'https://github.com/a/b' },
      { id: 'repo-other', workspaceId: 'ws-other', name: 'a/b', url: 'https://github.com/a/b' },
    ]);
    await seedSession('wb');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await testDb.cleanup();
  });

  const rowFor = async (workbenchId: string) =>
    (await testDb.db.select().from(sessionMcpTokens).where(eq(sessionMcpTokens.workbenchId, workbenchId)))[0];

  it('mints one token per session, owned by the workspace owner, stored hashed and encrypted', async () => {
    const token = await ensureSessionMcpToken(SESSION);
    expect(token).toMatch(/^talyn_mcs_[A-Za-z0-9_-]{43}$/);
    const row = await rowFor('wb');
    expect(row.ownerId).toBe(TEST_USER_ID);
    expect(row.tokenHash).toHaveLength(64);
    expect(row.tokenHash).not.toContain(token);
    expect(JSON.stringify(row.tokenCiphertext)).not.toContain(token);
    expect(row.spawnDepth).toBe(0);
    expect(row.parentWorkbenchId).toBeNull();
    // Recoverable, which is the point: a fleetd restart asks for it again.
    expect(await readSessionMcpToken('wb')).toBe(token);
  });

  it('is idempotent, including under a race', async () => {
    const tokens = await Promise.all([1, 2, 3, 4].map(() => ensureSessionMcpToken(SESSION)));
    expect(new Set(tokens).size).toBe(1);
    expect(await testDb.db.select().from(sessionMcpTokens)).toHaveLength(1);
  });

  it('answers null for a session that never had one', async () => {
    expect(await readSessionMcpToken('wb')).toBeNull();
  });

  it('authenticates through requireMcpToken with the session bound', async () => {
    const token = await ensureSessionMcpToken(SESSION);
    const { req, next, res } = await authenticate(token);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.mcpOwnerId).toBe(TEST_USER_ID);
    expect(req.mcpSession).toEqual({ tokenId: (await rowFor('wb')).id, workbenchId: 'wb', depth: 0 });
    expect((await rowFor('wb')).lastUsedAt).toBeInstanceOf(Date);
  });

  it('leaves personal tokens on their own path, with no session bound', async () => {
    const { token } = await createToken(TEST_USER_ID);
    const { req, next } = await authenticate(token);
    expect(next).toHaveBeenCalledOnce();
    expect(req.mcpOwnerId).toBe(TEST_USER_ID);
    expect(req.mcpSession).toBeUndefined();
  });

  it.each<[string, (token: string) => Promise<string>]>([
    ['an unknown session token', async () => 'talyn_mcs_unknown'],
    ['a deleted session', async (token) => { await deleteWorkbenchRow('wb'); return token; }],
    ['an archived session', async (token) => { await updateWorkbench('wb', { archivedAt: new Date(), status: 'archived' }); return token; }],
    ['a pending archive', async (token) => {
      await updateWorkbench('wb', { archivedAt: new Date(), archivePendingAt: new Date(), status: 'archived' });
      return token;
    }],
    ['a local session', async (token) => { await updateWorkbench('wb', { runtime: 'local' }); return token; }],
    ['a revoked token', async (token) => { await revokeSessionMcpToken('wb'); return token; }],
    ['a session moved to another owner', async (token) => {
      await testDb.db.update(workspaces).set({ ownerId: OTHER }).where(eq(workspaces.id, 'ws'));
      return token;
    }],
    ['an owner outside the allow-list', async (token) => { vi.stubEnv('TALYN_ALLOWED_EMAILS', 'someone@example.test'); return token; }],
    ['a session token with a personal prefix', async (token) => token.replace('talyn_mcs_', 'talyn_mcp_')],
  ])('refuses %s', async (_name, prepare) => {
    const token = await prepare(await ensureSessionMcpToken(SESSION));
    const { next, res } = await authenticate(token);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="talyn-mcp"');
  });

  it('deletes the token with its session', async () => {
    await ensureSessionMcpToken(SESSION);
    await deleteWorkbenchRow('wb');
    expect(await testDb.db.select().from(sessionMcpTokens)).toHaveLength(0);
  });

  it('works again after a restore clears the archive', async () => {
    const token = await ensureSessionMcpToken(SESSION);
    await updateWorkbench('wb', { archivedAt: new Date(), status: 'archived' });
    expect(await validateSessionMcpToken(token)).toBeNull();
    await updateWorkbench('wb', { archivedAt: null, status: 'ready' });
    expect(await validateSessionMcpToken(token)).toMatchObject({ ownerId: TEST_USER_ID });
  });

  describe('spawn limits', () => {
    const binding = async (depth = 0): Promise<SessionMcpBinding> => {
      await ensureSessionMcpToken(SESSION);
      await testDb.db.update(sessionMcpTokens).set({ spawnDepth: depth }).where(eq(sessionMcpTokens.workbenchId, 'wb'));
      return (await validateSessionMcpToken((await readSessionMcpToken('wb'))!))!.session;
    };

    it.each([0, 1])('lets a session at depth %i start one', async (depth) => {
      await expect(reserveSessionCreate(await binding(depth))).resolves.toBeUndefined();
    });

    it.each([MAX_SESSION_SPAWN_DEPTH, MAX_SESSION_SPAWN_DEPTH + 1])('refuses a session at depth %i', async (depth) => {
      const refused = await reserveSessionCreate(await binding(depth)).catch((err) => err);
      expect(refused).toBeInstanceOf(SessionSpawnRefusedError);
      expect(refused.reason).toBe('depth');
      // A depth refusal spends no slot.
      expect((await rowFor('wb')).createsInWindow).toBe(0);
    });

    it(`allows ${SESSION_CREATES_PER_HOUR} creates an hour, then refuses`, async () => {
      const b = await binding();
      for (let i = 0; i < SESSION_CREATES_PER_HOUR; i++) await reserveSessionCreate(b);
      const refused = await reserveSessionCreate(b).catch((err) => err);
      expect(refused).toBeInstanceOf(SessionSpawnRefusedError);
      expect(refused.reason).toBe('rate');
      expect((await rowFor('wb')).createsInWindow).toBe(SESSION_CREATES_PER_HOUR);
    });

    it('allows concurrent creates only up to the cap', async () => {
      const b = await binding();
      const results = await Promise.allSettled(
        Array.from({ length: SESSION_CREATES_PER_HOUR + 3 }, () => reserveSessionCreate(b))
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(SESSION_CREATES_PER_HOUR);
    });

    it('opens a new window once the hour has passed', async () => {
      const b = await binding();
      await testDb.db.update(sessionMcpTokens)
        .set({ createsWindowStartedAt: OLD_WINDOW, createsInWindow: SESSION_CREATES_PER_HOUR })
        .where(eq(sessionMcpTokens.id, b.tokenId));
      await reserveSessionCreate(b);
      const row = await rowFor('wb');
      expect(row.createsInWindow).toBe(1);
      expect(row.createsWindowStartedAt!.getTime()).toBeGreaterThan(OLD_WINDOW.getTime());
    });

    it('counts per token: another session has its own slots', async () => {
      await seedSession('wb2');
      const first = await binding();
      for (let i = 0; i < SESSION_CREATES_PER_HOUR; i++) await reserveSessionCreate(first);
      await ensureSessionMcpToken({ id: 'wb2', workspaceId: 'ws' });
      const second = (await validateSessionMcpToken((await readSessionMcpToken('wb2'))!))!.session;
      await expect(reserveSessionCreate(second)).resolves.toBeUndefined();
    });

    it.each([0, 1])('records the parent and depth %i + 1 on the child', async (depth) => {
      const parent = await binding(depth);
      await seedSession('child');
      await recordSessionSpawn('child', parent);
      const child = await rowFor('child');
      expect(child).toMatchObject({ parentWorkbenchId: 'wb', spawnDepth: depth + 1, ownerId: TEST_USER_ID });
      // The child's own token now carries the depth the next create is checked against.
      expect((await validateSessionMcpToken((await readSessionMcpToken('child'))!))!.session.depth).toBe(depth + 1);
    });

    it('keeps the depth when provisioning minted the child token first', async () => {
      const parent = await binding(1);
      await seedSession('child');
      const minted = await ensureSessionMcpToken({ id: 'child', workspaceId: 'ws' });
      await recordSessionSpawn('child', parent);
      expect(await readSessionMcpToken('child')).toBe(minted);
      expect((await rowFor('child')).spawnDepth).toBe(2);
    });

    it('keeps the child token when the parent session is deleted', async () => {
      const parent = await binding();
      await seedSession('child');
      await recordSessionSpawn('child', parent);
      await testDb.db.delete(workbenches).where(eq(workbenches.id, 'wb'));
      expect(await rowFor('child')).toMatchObject({ parentWorkbenchId: null, spawnDepth: 1 });
    });
  });

  it('maps a chat to its session', async () => {
    await insertChat({ id: 'chat', workbenchId: 'wb', workspaceId: 'ws', title: 'Chat', agent: 'claude' });
    expect(await chatWorkbenchId('chat')).toBe('wb');
    expect(await chatWorkbenchId('missing')).toBeNull();
  });
});
