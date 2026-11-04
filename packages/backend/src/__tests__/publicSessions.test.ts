import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn, type ExecReply } from './helpers/fakeFleet.js';
import { callPublic, mintToken, startPublicApi, type Loose } from './helpers/publicApi.js';
import { repositories, workbenchChats, workbenches, workspaces } from '../db/schema.js';

/**
 * `/v1` sessions and chats end to end against a fake fleet: create, list,
 * get, archive, restore, retry, chats, messages, cancel, transcript pages,
 * idempotent creates and the local-runtime refusals. The services are the
 * apps' own; these tests hold the public shapes and the public rules.
 */

let creds: { claudeToken?: string; openaiKey?: string } | null = { claudeToken: 'sk-ant-oat-claude', openaiKey: 'oa-codex' };

vi.mock('../services/selfHosted/credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/selfHosted/credentials.js')>()),
  getSelfHostedCredentials: async () => creds,
  fleetAgentStatus: async () => ({
    connectedAgents: [...(creds?.claudeToken ? ['claude'] : []), ...(creds?.openaiKey ? ['codex'] : [])],
    reauthAgents: [],
  }),
}));

vi.mock('../services/cloudProviders/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/cloudProviders/registry.js')>()),
  getCloudProvider: () => ({ type: 'selfhosted' }),
}));

vi.mock('../services/repoDefaultBranch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/repoDefaultBranch.js')>()),
  reconcileDefaultBranch: async (input: { stored: string }) => input.stored || 'main',
}));

const { settleArchivesForTests, sweepStrandedProvisions } = await import('../services/workbenches/lifecycle.js');
const { setWorkObjectStoreForTests } = await import('../services/workbenches/workStorage.js');
const { githubService } = await import('../services/github.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { setWorkbenchFleetClientForTests } = await import('../services/workbenches/sandboxRuntime.js');
const { getChat, getWorkbench, listChats, appendEvents } = await import('../services/workbenches/store.js');
const { FleetNotDeployedError } = await import('../services/selfHosted/credentials.js');

describe('/v1 sessions and chats', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let api: Awaited<ReturnType<typeof startPublicApi>>;
  let fleet: FakeFleet;
  let token: string;

  const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>, as = token) =>
    callPublic(api.base, method, path, { token: as, body, headers });

  function scriptedFleet(turn: (script: string) => ExecReply | Promise<ExecReply> | null = () => null): void {
    fleet.handler = async (script) => {
      const custom = await turn(script);
      if (custom) return custom;
      if (isAgentTurn(script)) return { stdout: claudeTurnLines('sess-1', 'done') };
      if (script.includes('git commit-tree')) return { stdout: `${'c'.repeat(40)}\n` };
      return { exitCode: 0, stdout: '' };
    };
  }

  async function createReadySession(extra: Record<string, unknown> = {}): Promise<Loose> {
    const res = await call('POST', '/sessions', { workspace_id: 'ws-a', repository_id: 'repo-a', agent: 'claude', ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await vi.waitFor(async () => expect((await getWorkbench(res.body.id))?.status).toBe('ready'), { timeout: 5000 });
    return res.body;
  }

  beforeEach(async () => {
    creds = { claudeToken: 'sk-ant-oat-claude', openaiKey: 'oa-codex' };
    vi.stubEnv('PUBLIC_API_ENABLED', 'true');
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    vi.stubEnv('FLEET_API_TOKEN', 'fleet-token');
    vi.stubEnv('FLEET_PINNED_ENDPOINT', '');
    vi.stubEnv('FLEET_GATEWAY_TOKEN', '');
    vi.stubEnv('FLEET_ALLOWED', 'true');
    resetFeatureFlagsForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    await testDb.db.insert(repositories).values([
      { id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main' },
      { id: 'repo-b', workspaceId: 'ws-b', name: 'other/app', url: 'https://github.com/other/app', defaultBranch: 'main' },
    ]);
    vi.spyOn(githubService, 'branchExists').mockResolvedValue(false);
    vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    // The repository size detection reads GitHub; these tests stay offline.
    vi.spyOn(githubService, 'getRefSha').mockRejectedValue(new Error('offline'));
    fleet = new FakeFleet();
    scriptedFleet();
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
    token = await mintToken('owner-a');
    api = await startPublicApi();
  });

  afterEach(async () => {
    await settleArchivesForTests();
    setWorkObjectStoreForTests(null);
    setWorkbenchFleetClientForTests(null);
    await api.close();
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
  });

  describe('creating', () => {
    it('answers 201 provisioning in the public shape, then the session becomes ready', async () => {
      const res = await call('POST', '/sessions', {
        workspace_id: 'ws-a', repository_id: 'repo-a', agent: 'claude', prompt: 'add a readme', internet_access: false,
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        object: 'session',
        workspace_id: 'ws-a',
        repository_id: 'repo-a',
        repository_full_name: 'acme/app',
        kind: 'session',
        runtime: 'sandbox',
        agent: 'claude',
        status: 'provisioning',
        base_branch: 'main',
        internet_access: false,
      });
      expect(res.body.chats).toHaveLength(1);
      expect(res.body.chats[0]).toMatchObject({ object: 'chat', queued_message_count: 1 });
      for (const key of ['sandboxId', 'sandbox_id', 'deviceId', 'device_id', 'localPath', 'settings']) expect(res.body).not.toHaveProperty(key);
      await vi.waitFor(async () => expect((await getWorkbench(res.body.id))?.status).toBe('ready'), { timeout: 5000 });
      expect((await call('GET', `/sessions/${res.body.id}`)).body.status).toBe('ready');
    });

    it.each([
      ['no repository for a session', { workspace_id: 'ws-a', agent: 'claude' }, 400, 'repository_id'],
      ['an unknown agent', { workspace_id: 'ws-a', repository_id: 'repo-a', agent: 'gpt' }, 400, 'agent'],
      ['a camelCase field', { workspaceId: 'ws-a', repository_id: 'repo-a', agent: 'claude' }, 400, 'workspaceId'],
      ['a bad name', { workspace_id: 'ws-a', repository_id: 'repo-a', agent: 'claude', name: 'Not OK' }, 400, 'name'],
      ['another owner’s workspace', { workspace_id: 'ws-b', repository_id: 'repo-b', agent: 'claude' }, 404, undefined],
      ['a repository of another workspace', { workspace_id: 'ws-a', repository_id: 'repo-b', agent: 'claude' }, 400, undefined],
    ])('refuses %s', async (_label, body, status, param) => {
      const res = await call('POST', '/sessions', body);
      expect(res.status).toBe(status);
      expect(res.body.error.request_id).toMatch(/^req_/);
      if (param) expect(res.body.error.param).toBe(param);
      expect(fleet.created).toEqual([]);
    });

    it('names an unknown field in param', async () => {
      const res = await call('POST', '/sessions', { workspaceId: 'ws-a', repository_id: 'repo-a', agent: 'claude' });
      expect(res.body.error).toMatchObject({ type: 'invalid_request_error', code: 'invalid_parameter', param: 'workspaceId' });
      expect(res.body.error.message).toBe('Unknown field: workspaceId.');
    });

    it('refuses a body that is not JSON', async () => {
      const resp = await fetch(`${api.base}/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{not json',
      });
      expect(resp.status).toBe(400);
      expect((await resp.json()).error.code).toBe('invalid_json');
    });

    it('takes the workspace from a token bound to exactly one', async () => {
      const bound = await mintToken('owner-a', { workspaceIds: ['ws-a'] });
      const res = await call('POST', '/sessions', { repository_id: 'repo-a', agent: 'claude' }, undefined, bound);
      expect(res.status).toBe(201);
      expect(res.body.workspace_id).toBe('ws-a');
      await vi.waitFor(async () => expect((await getWorkbench(res.body.id))?.status).toBe('ready'), { timeout: 5000 });
    });

    it('refuses when the fleet cannot run the agent, in the public error shape', async () => {
      creds = { openaiKey: 'oa-codex' };
      const res = await call('POST', '/sessions', { workspace_id: 'ws-a', repository_id: 'repo-a', agent: 'claude' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.body.error.type).not.toBe('api_error');
      expect(fleet.created).toEqual([]);
    });
  });

  describe('idempotency', () => {
    const body = { workspace_id: 'ws-a', repository_id: 'repo-a', agent: 'claude' };

    it('replays the first answer for the same key and body, and starts one session', async () => {
      const first = await call('POST', '/sessions', body, { 'Idempotency-Key': 'key-1' });
      const again = await call('POST', '/sessions', body, { 'Idempotency-Key': 'key-1' });
      expect(first.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(again.body.id).toBe(first.body.id);
      expect(await testDb.db.select({ id: workbenches.id }).from(workbenches)).toHaveLength(1);
      await vi.waitFor(async () => expect((await getWorkbench(first.body.id))?.status).toBe('ready'), { timeout: 5000 });
    });

    it('refuses the same key with a different body', async () => {
      await call('POST', '/sessions', body, { 'Idempotency-Key': 'key-2' });
      const res = await call('POST', '/sessions', { ...body, prompt: 'different' }, { 'Idempotency-Key': 'key-2' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'idempotency_key_reused', param: 'Idempotency-Key' });
    });

    it('keys belong to one token', async () => {
      const other = await mintToken('owner-a');
      const a = await call('POST', '/sessions', body, { 'Idempotency-Key': 'shared' });
      const b = await call('POST', '/sessions', body, { 'Idempotency-Key': 'shared' }, other);
      expect(a.body.id).not.toBe(b.body.id);
      await vi.waitFor(async () => expect((await getWorkbench(b.body.id))?.status).toBe('ready'), { timeout: 5000 });
    });

    it('releases the key when the request fails, so a retry runs', async () => {
      creds = null;
      const failed = await call('POST', '/sessions', body, { 'Idempotency-Key': 'key-3' });
      expect(failed.status).toBeGreaterThanOrEqual(400);
      creds = { claudeToken: 'sk-ant-oat-claude' };
      const retried = await call('POST', '/sessions', body, { 'Idempotency-Key': 'key-3' });
      expect(retried.status).toBe(201);
      expect(retried.headers.get('idempotent-replayed')).toBeNull();
      await vi.waitFor(async () => expect((await getWorkbench(retried.body.id))?.status).toBe('ready'), { timeout: 5000 });
    });

    it.each([['a key with a space', 'a b'], ['a key too long', 'k'.repeat(256)]])('refuses %s', async (_label, key) => {
      const res = await call('POST', '/sessions', body, { 'Idempotency-Key': key });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_idempotency_key');
    });

    it('replays a sent message instead of queueing it twice', async () => {
      const session = await createReadySession();
      const chatId = session.chats[0].id;
      let turns = 0;
      scriptedFleet((script) => {
        if (isAgentTurn(script)) turns++;
        return null;
      });
      const first = await call('POST', `/chats/${chatId}/messages`, { text: 'hello' }, { 'Idempotency-Key': 'msg-1' });
      const again = await call('POST', `/chats/${chatId}/messages`, { text: 'hello' }, { 'Idempotency-Key': 'msg-1' });
      expect(first.status).toBe(202);
      expect(again.body).toEqual(first.body);
      await vi.waitFor(async () => expect((await getChat(chatId))?.status).toBe('idle'), { timeout: 5000 });
      expect(turns).toBe(1);
    });
  });

  describe('reading', () => {
    async function insertSession(id: string, createdAt: string, extra: Partial<typeof workbenches.$inferInsert> = {}) {
      await testDb.db.insert(workbenches).values({
        id,
        workspaceId: 'ws-a',
        repositoryId: 'repo-a',
        repoFullName: 'acme/app',
        name: id,
        branch: id,
        baseBranch: 'main',
        runtime: 'sandbox',
        agent: 'claude',
        status: 'ready',
        createdAt: new Date(createdAt),
        ...extra,
      });
    }

    it('pages sessions newest first with an opaque cursor', async () => {
      await insertSession('s1', '2026-11-01T00:00:01Z');
      await insertSession('s2', '2026-11-01T00:00:02Z');
      await insertSession('s3', '2026-11-01T00:00:03Z');
      const first = await call('GET', '/sessions?workspace_id=ws-a&limit=2');
      expect(first.body.data.map((s: Loose) => s.id)).toEqual(['s3', 's2']);
      expect(first.body).toMatchObject({ object: 'list', has_more: true });
      expect(first.body.data[0]).not.toHaveProperty('chats');
      const second = await call('GET', `/sessions?workspace_id=ws-a&limit=2&cursor=${first.body.next_cursor}`);
      expect(second.body.data.map((s: Loose) => s.id)).toEqual(['s1']);
      expect(second.body).toMatchObject({ has_more: false, next_cursor: null });
    });

    it.each([
      ['the default', '', ['live', 'failed']],
      ['include_archived', '&include_archived=true', ['live', 'failed', 'old']],
      ['status=archived', '&status=archived', ['old']],
      ['status=ready,error', '&status=ready,error', ['live', 'failed']],
      ['status=error', '&status=error', ['failed']],
    ])('filters by %s', async (_label, qs, expected) => {
      await insertSession('live', '2026-11-01T00:00:03Z');
      await insertSession('failed', '2026-11-01T00:00:02Z', { status: 'error' });
      await insertSession('old', '2026-11-01T00:00:01Z', { archivedAt: new Date() });
      const res = await call('GET', `/sessions?workspace_id=ws-a${qs}`);
      expect(res.body.data.map((s: Loose) => s.id)).toEqual(expected);
    });

    it.each([
      ['an unknown status', 'status=done', 'status'],
      ['a limit over the ceiling', 'limit=500', 'limit'],
      ['a bad cursor', 'cursor=abc', 'cursor'],
      ['an unknown parameter', 'workspaceId=ws-a', 'workspaceId'],
    ])('refuses %s', async (_label, qs, param) => {
      const res = await call('GET', `/sessions?workspace_id=ws-a&${qs}`);
      expect(res.status).toBe(400);
      if (param) expect(res.body.error.param).toBe(param);
    });

    it('needs a workspace_id when the token is not bound to one workspace', async () => {
      const res = await call('GET', '/sessions');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'missing_parameter', param: 'workspace_id' });
    });

    it('reads transcript pages forward and backward', async () => {
      await insertSession('s1', '2026-11-01T00:00:01Z');
      await testDb.db.insert(workbenchChats).values({ id: 'c1', workbenchId: 's1', workspaceId: 'ws-a', title: 'Chat', agent: 'claude' });
      await appendEvents('c1', Array.from({ length: 5 }, (_, i) => ({ turn: i < 3 ? 1 : 2, event: { type: 'assistant', n: i } })));

      const page = await call('GET', '/chats/c1/events?after=1&limit=2');
      expect(page.body).toMatchObject({ object: 'list', has_more: true, first_seq: 2, last_seq: 3 });
      expect(page.body.data[0]).toMatchObject({ object: 'event', chat_id: 'c1', seq: 2, turn: 1, type: 'assistant' });
      const rest = await call('GET', '/chats/c1/events?after=3');
      expect(rest.body).toMatchObject({ has_more: false, first_seq: 4, last_seq: 5 });
      const empty = await call('GET', '/chats/c1/events?after=5');
      expect(empty.body).toMatchObject({ data: [], has_more: false, first_seq: null, last_seq: 5 });

      const latest = await call('GET', '/chats/c1/events?before=latest&limit=1');
      // Whole turns: the newest event's turn starts at seq 4.
      expect(latest.body.data.map((e: Loose) => e.seq)).toEqual([4, 5]);
      expect(latest.body).toMatchObject({ has_more: true, first_seq: 4 });
      expect((await call('GET', '/chats/c1/events?before=2&after=1')).status).toBe(400);
    });

    it('answers 404 for a chat or session the token cannot reach', async () => {
      await testDb.db.insert(workbenches).values({
        id: 'sb', workspaceId: 'ws-b', repositoryId: 'repo-b', repoFullName: 'other/app', name: 'sb', branch: 'sb',
        baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
      });
      await testDb.db.insert(workbenchChats).values({ id: 'cb', workbenchId: 'sb', workspaceId: 'ws-b', title: 'Chat', agent: 'claude' });
      for (const [method, path, code] of [
        ['GET', '/sessions/sb', 'session_not_found'],
        ['POST', '/sessions/sb/archive', 'session_not_found'],
        ['POST', '/sessions/sb/chats', 'session_not_found'],
        ['GET', '/chats/cb', 'chat_not_found'],
        ['GET', '/chats/cb/events', 'chat_not_found'],
        ['POST', '/chats/cb/messages', 'chat_not_found'],
        ['POST', '/chats/cb/cancel', 'chat_not_found'],
        ['GET', '/sessions/missing', 'session_not_found'],
      ] as const) {
        const res = await call(method, path, method === 'POST' && path.endsWith('messages') ? { text: 'x' } : method === 'POST' ? {} : undefined);
        expect([res.status, res.body.error?.code], `${method} ${path}`).toEqual([404, code]);
      }
    });
  });

  describe('lifecycle', () => {
    it('archives, then restores onto a new box', async () => {
      const session = await createReadySession();
      const archived = await call('POST', `/sessions/${session.id}/archive`);
      expect(archived.status).toBe(200);
      expect(archived.body).toMatchObject({ status: 'archived' });
      expect(archived.body.archived_at).toBeTruthy();
      await settleArchivesForTests();
      expect((await call('GET', '/sessions?workspace_id=ws-a')).body.data).toEqual([]);

      const restored = await call('POST', `/sessions/${session.id}/restore`);
      expect(restored.status).toBe(200);
      expect(restored.body).toMatchObject({ status: 'provisioning', archived_at: null });
      await vi.waitFor(async () => expect((await getWorkbench(session.id))?.status).toBe('ready'), { timeout: 5000 });
    });

    it('archiving twice answers the archived session', async () => {
      const session = await createReadySession();
      await call('POST', `/sessions/${session.id}/archive`);
      const again = await call('POST', `/sessions/${session.id}/archive`);
      expect(again.status).toBe(200);
      expect(again.body.status).toBe('archived');
    });

    it('retries a session that failed to start', async () => {
      fleet.createSandbox = async () => {
        throw new FleetNotDeployedError();
      };
      const res = await call('POST', '/sessions', { workspace_id: 'ws-a', repository_id: 'repo-a', agent: 'claude' });
      await vi.waitFor(async () => expect((await getWorkbench(res.body.id))?.status).toBe('error'), { timeout: 5000 });
      expect((await call('GET', `/sessions/${res.body.id}`)).body.status).toBe('error');
      fleet.createSandbox = FakeFleet.prototype.createSandbox;
      const retried = await call('POST', `/sessions/${res.body.id}/retry`);
      expect(retried.status).toBe(200);
      expect(retried.body.status).toBe('provisioning');
      await vi.waitFor(async () => expect((await getWorkbench(res.body.id))?.status).toBe('ready'), { timeout: 5000 });
    });

    it('retries a session stuck while it starts', async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      scriptedFleet(async (script) => {
        if (script.includes('git clone')) await held;
        return null;
      });
      const res = await call('POST', '/sessions', { workspace_id: 'ws-a', repository_id: 'repo-a', agent: 'claude' });
      await vi.waitFor(() => expect(fleet.created).toHaveLength(1));
      const retried = await call('POST', `/sessions/${res.body.id}/retry`);
      expect(retried.status).toBe(200);
      expect(retried.body.status).toBe('provisioning');
      expect(fleet.deleted).toEqual([fleet.created[0].id]);
      release();
      await vi.waitFor(async () => {
        await sweepStrandedProvisions();
        expect((await getWorkbench(res.body.id))?.status).toBe('ready');
      }, { timeout: 5000 });
    });

    it('refuses to retry a session that has not failed', async () => {
      const session = await createReadySession();
      const res = await call('POST', `/sessions/${session.id}/retry`);
      expect([res.status, res.body.error.code]).toEqual([409, 'not_failed']);
    });
  });

  describe('chats', () => {
    it('opens a chat, sends a message and reads the reply', async () => {
      const session = await createReadySession();
      const chat = await call('POST', `/sessions/${session.id}/chats`, { title: 'Second', effort: 'low' });
      expect(chat.status).toBe(201);
      expect(chat.body).toMatchObject({ object: 'chat', session_id: session.id, title: 'Second', effort: 'low', status: 'idle' });

      const sent = await call('POST', `/chats/${chat.body.id}/messages`, { text: 'hello' });
      expect(sent.status).toBe(202);
      expect(sent.body).toEqual({ object: 'message_receipt', chat_id: chat.body.id, queued: false });
      await vi.waitFor(async () => expect((await getChat(chat.body.id))?.status).toBe('idle'), { timeout: 5000 });
      const events = await call('GET', `/chats/${chat.body.id}/events`);
      expect(events.body.data.length).toBeGreaterThan(0);
      expect(events.body.data.map((e: Loose) => e.type)).toContain('result');

      const got = await call('GET', `/chats/${chat.body.id}`);
      expect(got.body).toMatchObject({ turn_count: 1, status: 'idle' });
      const withChats = await call('GET', `/sessions/${session.id}`);
      expect(withChats.body.chats.map((c: Loose) => c.id)).toContain(chat.body.id);
    });

    it('cancels a running turn', async () => {
      const session = await createReadySession();
      let release!: () => void;
      scriptedFleet((script) =>
        isAgentTurn(script) ? { stdout: claudeTurnLines('sess-1', 'ok'), hold: new Promise<void>((r) => (release = r)) } : null,
      );
      const chatId = session.chats[0].id;
      await call('POST', `/chats/${chatId}/messages`, { text: 'long job' });
      await vi.waitFor(async () => expect((await getChat(chatId))?.status).toBe('running'), { timeout: 5000 });
      const res = await call('POST', `/chats/${chatId}/cancel`);
      expect(res.status).toBe(200);
      expect(res.body.object).toBe('chat');
      release?.();
      await vi.waitFor(async () => expect((await getChat(chatId))?.status).not.toBe('running'), { timeout: 5000 });
    });

    it('refuses a message to a closed chat, and a chat on an archived session', async () => {
      const session = await createReadySession();
      const chatId = session.chats[0].id;
      await testDb.db.update(workbenchChats).set({ closedAt: new Date() });
      const res = await call('POST', `/chats/${chatId}/messages`, { text: 'x' });
      expect([res.status, res.body.error.code]).toEqual([409, 'chat_closed']);
      await call('POST', `/sessions/${session.id}/archive`);
      const chat = await call('POST', `/sessions/${session.id}/chats`, {});
      expect([chat.status, chat.body.error.code]).toEqual([409, 'archived']);
    });
  });

  describe('local sessions are read-only', () => {
    beforeEach(async () => {
      await testDb.db.insert(workbenches).values({
        id: 'local-1', workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'acme/app', name: 'local-1',
        branch: 'feature', baseBranch: 'main', runtime: 'local', agent: 'claude', status: 'ready',
        deviceId: 'device-1', localPath: '/Users/me/src/app',
      });
      await testDb.db.insert(workbenchChats).values({ id: 'local-chat', workbenchId: 'local-1', workspaceId: 'ws-a', title: 'Chat', agent: 'claude' });
    });

    it('lists and reads a local session without its device or path', async () => {
      const list = await call('GET', '/sessions?workspace_id=ws-a');
      expect(list.body.data.map((s: Loose) => s.id)).toContain('local-1');
      const got = await call('GET', '/sessions/local-1');
      expect(got.body).toMatchObject({ runtime: 'local', status: 'ready' });
      expect(JSON.stringify(got.body)).not.toContain('device-1');
      expect(JSON.stringify(got.body)).not.toContain('/Users/me');
      expect((await call('GET', '/chats/local-chat')).status).toBe(200);
      expect((await call('GET', '/chats/local-chat/events')).status).toBe(200);
    });

    it.each([
      ['POST', '/sessions/local-1/archive', undefined],
      ['POST', '/sessions/local-1/restore', undefined],
      ['POST', '/sessions/local-1/retry', undefined],
      ['POST', '/sessions/local-1/chats', {}],
      ['POST', '/chats/local-chat/messages', { text: 'x' }],
      ['POST', '/chats/local-chat/cancel', undefined],
    ])('answers 409 local_runtime for %s %s', async (method, path, body) => {
      const res = await call(method, path, body);
      expect([res.status, res.body.error.code]).toEqual([409, 'local_runtime']);
      expect((await getWorkbench('local-1'))?.archivedAt).toBeNull();
      expect(await listChats('local-1')).toHaveLength(1);
    });
  });
});
