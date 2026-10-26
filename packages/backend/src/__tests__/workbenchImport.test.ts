import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { gzipSync } from 'zlib';
import { WORKBENCH_IMPORT_MAX_BYTES, type WorkbenchImportHeader } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn } from './helpers/fakeFleet.js';
import { repositories, workspaces } from '../db/schema.js';

/**
 * `POST /workbenches/:id/import`, end to end against a fake fleet: the gate,
 * the preconditions, the box script, the stored transcript, and the next turn
 * resuming the imported conversation.
 */

vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: () => undefined,
}));

vi.mock('../services/selfHosted/credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/selfHosted/credentials.js')>()),
  getSelfHostedCredentials: async () => ({ claudeToken: 'sk-ant-oat-claude', openaiKey: 'oa-codex' }),
  fleetAgentStatus: async () => ({ connectedAgents: ['claude', 'codex'], reauthAgents: [] }),
}));

vi.mock('../services/cloudProviders/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/cloudProviders/registry.js')>()),
  getCloudProvider: () => ({ type: 'selfhosted' }),
}));

vi.mock('../services/repoDefaultBranch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/repoDefaultBranch.js')>()),
  reconcileDefaultBranch: async (input: { stored: string }) => input.stored || 'main',
}));

const { workbenchRoutes } = await import('../routes/workbenches.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');
const { githubService } = await import('../services/github.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { setWorkbenchFleetClientForTests } = await import('../services/workbenches/sandboxRuntime.js');
const { getChat, getWorkbench, listChats, listEvents, updateChat, updateWorkbench } = await import('../services/workbenches/store.js');
const { boxSessionPath, importScript, parseImportBody } = await import('../services/workbenches/claudeImport.js');

const SESSION = '4f1c2b9e-1111-4222-8333-944455556666';
const BASE = 'b'.repeat(40);

const SESSION_LINES = [
  { type: 'user', uuid: 'u1', parentUuid: null, sessionId: SESSION, cwd: '/Users/x/dev/app', message: { role: 'user', content: 'Fix the bug' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: SESSION, message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/Users/x/dev/app/a.ts' } }] } },
  { type: 'user', uuid: 'r1', parentUuid: 'a1', sessionId: SESSION, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'code' }] } },
  { type: 'assistant', uuid: 'a2', parentUuid: 'r1', sessionId: SESSION, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] } },
  { type: 'user', uuid: 'u2', parentUuid: 'a2', sessionId: SESSION, message: { role: 'user', content: 'Thanks, now test it' } },
  { type: 'assistant', uuid: 'a3', parentUuid: 'u2', sessionId: SESSION, message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'Tested.' }] } },
]
  .map((l) => JSON.stringify(l))
  .join('\n');

function importBody(
  header: Partial<WorkbenchImportHeader> = {},
  parts: { session?: Buffer; patch?: Buffer } = {},
): Buffer {
  const session = parts.session ?? gzipSync(SESSION_LINES);
  const patch = parts.patch ?? gzipSync('diff --git a/a.ts b/a.ts\n');
  const full: WorkbenchImportHeader = {
    agent: 'claude',
    sessionId: SESSION,
    cwd: '/Users/x/dev/app/src',
    root: '/Users/x/dev/app',
    base: BASE,
    sessionBytes: session.length,
    patchBytes: patch.length,
    ...header,
  };
  return Buffer.concat([Buffer.from(`${JSON.stringify(full)}\n`), session, patch]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

describe('workbench import', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base: string;
  let fleet: FakeFleet;
  let importReply: { exitCode: number; stderr?: string };

  async function call(method: string, path: string, body?: unknown, user = 'owner-a') {
    const resp = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: resp.status, body: (await resp.json()) as { success: boolean; data?: Loose; error?: string; code?: string } };
  }

  async function upload(id: string, body: Buffer, opts: { user?: string; type?: string } = {}) {
    const resp = await fetch(`${base}/workbenches/${id}/import`, {
      method: 'POST',
      headers: { 'x-user': opts.user ?? 'owner-a', 'content-type': opts.type ?? 'application/octet-stream' },
      body,
    });
    return { status: resp.status, body: (await resp.json()) as { success: boolean; data?: Loose; error?: string; code?: string } };
  }

  async function createSandbox(agent: 'claude' | 'codex' = 'claude'): Promise<Loose> {
    const res = await call('POST', '/workbenches', { workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent });
    expect(res.status).toBe(200);
    await vi.waitFor(async () => expect((await getWorkbench(res.body.data.id))?.status).toBe('ready'), { timeout: 5000 });
    return res.body.data;
  }

  const importScripts = () => fleet.execs.filter((e) => e.script.includes('git checkout --quiet -B'));

  beforeEach(async () => {
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
    ]);
    vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    importReply = { exitCode: 0 };
    fleet = new FakeFleet();
    fleet.handler = (script) => {
      if (script.includes('git checkout --quiet -B')) return importReply;
      if (isAgentTurn(script)) return { stdout: claudeTurnLines(SESSION, 'carried on') };
      if (script.includes('git commit-tree')) return { stdout: `${'c'.repeat(40)}\n` };
      return { exitCode: 0, stdout: '' };
    };
    setWorkbenchFleetClientForTests(async () => fleet.asClient());

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const id = req.headers['x-user'] as string;
      req.user = { id, email: `${id}@example.test`, isAdmin: false };
      next();
    });
    app.use('/workbenches', wrapAsyncRoutes(workbenchRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    setWorkbenchFleetClientForTests(null);
    await new Promise((resolve) => server.close(resolve));
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
  });

  it('copies the files into the box, stores the transcript and resumes the conversation on the next turn', async () => {
    const wb = await createSandbox();
    const body = importBody();
    const parsed = parseImportBody(body);
    const res = await upload(wb.id, body);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ turns: 2, events: 7 });
    expect(res.body.data.chat).toMatchObject({
      agentSessionId: SESSION,
      status: 'idle',
      title: 'Fix the bug',
      importedFrom: { agent: 'claude', cwd: '/Users/x/dev/app/src', root: '/Users/x/dev/app' },
    });

    // The gz files travel as base64 in the exec env, before the import script runs.
    const written = fleet.execs.filter((e) => e.script.includes('base64 -d'));
    const env = written.flatMap((e) => Object.entries(e.req.env ?? {}).filter(([k]) => k.startsWith('TALYN_F')).map(([, v]) => v));
    expect(env).toEqual([parsed.session.toString('base64'), parsed.patch.toString('base64')]);
    expect(written[0].script).toContain('rm -rf -- "$HOME"/.talyn/import');
    const [script] = importScripts();
    expect(script.script).toContain(`git checkout --quiet -B ${wb.branch} ${BASE} || exit 11`);
    expect(script.script).toContain(`"$HOME"/.claude/projects/-work-app/${SESSION}.jsonl`);
    expect(script.req.cwd).toBe('/work/app');

    const chat = (await listChats(wb.id))[0];
    expect(chat).toMatchObject({ turnCount: 2, agentSessionId: SESSION, status: 'idle' });
    const page = await listEvents(chat.id, 0, 100);
    const events = (page as Loose).events ?? page;
    expect(events.map((e: Loose) => `${e.turn}:${e.event.type}`)).toEqual([
      '1:user', '1:assistant', '1:user', '1:assistant', '2:user', '2:assistant', '2:system',
    ]);
    expect(events.at(-1).event).toMatchObject({
      subtype: 'talyn_imported',
      text: 'Imported from a Claude Code conversation in /Users/x/dev/app/src.',
    });

    await call('POST', `/workbenches/chats/${chat.id}/messages`, { text: 'carry on' });
    await vi.waitFor(async () => expect((await getChat(chat.id))?.turnCount).toBe(3));
    await vi.waitFor(async () => expect((await getChat(chat.id))?.status).toBe('idle'), { timeout: 5000 });
    const turn = fleet.execs.find((e) => isAgentTurn(e.script))!;
    expect(turn.script).toContain(`--resume ${SESSION}`);
    expect(turn.script).not.toContain('--fork-session');
    expect(turn.script).toContain('Paths under /Users/x/dev/app are now under /work/app.');

    // The session is no longer fresh.
    expect((await upload(wb.id, importBody())).body.code).toBe('not_fresh');
  });

  it('accepts a conversation with no changes', async () => {
    const wb = await createSandbox();
    const res = await upload(wb.id, importBody({}, { patch: Buffer.alloc(0) }));
    expect(res.status).toBe(200);
    expect(fleet.execs.flatMap((e) => Object.keys(e.req.env ?? {}).filter((k) => k.startsWith('TALYN_F')))).toHaveLength(1);
  });

  it.each([
    [10, 'fetch', 'Could not fetch the base commit'],
    [11, 'checkout', 'Could not check out the base commit'],
    [12, 'apply', 'Could not apply your changes'],
    [13, 'session', 'Could not save the conversation in the sandbox'],
  ])('exit %s fails at %s, names it, and leaves the chat fresh', async (exitCode, step, text) => {
    const wb = await createSandbox();
    importReply = { exitCode, stderr: 'error: patch failed: a.ts:1' };
    const res = await upload(wb.id, importBody());
    expect(res.status).toBe(502);
    expect(res.body.code).toBe(`import_failed_${step}`);
    expect(res.body.error).toContain(text);
    expect(res.body.error).toContain('patch failed');
    const chat = (await listChats(wb.id))[0];
    expect(chat).toMatchObject({ turnCount: 0, agentSessionId: null, status: 'idle', importedFrom: null });
    const page = await listEvents(chat.id, 0, 100);
    expect((page as Loose).events ?? page).toHaveLength(0);
  });

  describe('refusals', () => {
    it('hides another workspace', async () => {
      const wb = await createSandbox();
      expect((await upload(wb.id, importBody(), { user: 'owner-b' })).status).toBe(404);
    });

    it('enforces the workbenches flag', async () => {
      const wb = await createSandbox();
      vi.stubEnv('WORKBENCHES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      const res = await upload(wb.id, importBody());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('workbenches_unavailable');
    });

    it('refuses a local session', async () => {
      const res = await call('POST', '/workbenches', {
        workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'local', agent: 'claude', deviceId: 'dev-1', localPath: '/tmp/wt',
      });
      expect((await upload(res.body.data.id, importBody())).body.code).toBe('local_runtime');
    });

    it('refuses a sandbox that is not ready', async () => {
      const wb = await createSandbox();
      await updateWorkbench(wb.id, { status: 'provisioning' });
      expect((await upload(wb.id, importBody())).body.code).toBe('not_ready');
    });

    it('refuses a session whose chat has run a turn', async () => {
      const wb = await createSandbox();
      await updateChat((await listChats(wb.id))[0].id, { turnCount: 1 });
      const res = await upload(wb.id, importBody());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('not_fresh');
    });

    it('refuses a Codex session', async () => {
      const wb = await createSandbox('codex');
      expect((await upload(wb.id, importBody())).body.code).toBe('wrong_agent');
    });

    it('refuses a body that is not octet-stream', async () => {
      const wb = await createSandbox();
      expect((await upload(wb.id, importBody(), { type: 'text/plain' })).status).toBe(415);
    });

    it('refuses an upload over the limit with a readable 413 and runs nothing', async () => {
      const wb = await createSandbox();
      const before = fleet.execs.length;
      const res = await upload(wb.id, Buffer.alloc(WORKBENCH_IMPORT_MAX_BYTES + 1));
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('import_too_large');
      expect(res.body.error).toBe('The conversation and your changes are larger than 24 MB, the most one import can take.');
      expect(fleet.execs.length).toBe(before);
    });

    it.each([
      ['a bad session id', { sessionId: '../etc/passwd' }, 'sessionId must be a UUID'],
      ['a short sha', { base: 'abc123' }, '40-character commit SHA'],
      ['an upper-case sha', { base: 'B'.repeat(40) }, '40-character commit SHA'],
      ['a Codex conversation', { agent: 'codex' as 'claude' }, 'Only Claude Code'],
      ['a relative-free empty cwd', { cwd: '' }, 'folder paths'],
      ['a cwd with a newline', { cwd: '/a\nb' }, 'folder paths'],
      ['sizes that do not add up', { patchBytes: 3 }, 'not the size its header says'],
      ['an empty conversation', { sessionBytes: 0 }, 'byte counts'],
    ])('rejects %s with 400', async (_label, header, message) => {
      const wb = await createSandbox();
      const res = await upload(wb.id, importBody(header));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('bad_import');
      expect(res.body.error).toContain(message);
      expect(importScripts()).toHaveLength(0);
      expect((await listChats(wb.id))[0].status).toBe('idle');
    });
  });
});

describe('parseImportBody', () => {
  it.each([
    ['no header line', Buffer.from('{}'), 'no header line'],
    ['a header that is not JSON', Buffer.from('nope\n'), 'not JSON'],
    ['parts that are not gzip', importBody({}, { session: Buffer.from('plain'), patch: Buffer.alloc(0) }), 'gzip'],
    ['a patch that is not gzip', importBody({}, { patch: Buffer.from('plain') }), 'gzip'],
  ])('rejects %s', (_label, body, message) => {
    expect(() => parseImportBody(body)).toThrow(message);
  });

  it('splits the parts by the header sizes', () => {
    const session = gzipSync('s');
    const patch = gzipSync('p');
    const out = parseImportBody(importBody({}, { session, patch }));
    expect(out.session.equals(session)).toBe(true);
    expect(out.patch.equals(patch)).toBe(true);
    expect(out.header).toMatchObject({ sessionId: SESSION, base: BASE, root: '/Users/x/dev/app' });
  });
});

describe('importScript', () => {
  const script = importScript({ base: BASE, branch: "tom/it's", repoDir: '/work/my_app', sessionId: SESSION });

  it('runs the steps in order with their own exit codes', () => {
    const order = ['git cat-file -e', 'git fetch --quiet origin', 'git checkout --quiet -B', 'git apply --binary', 'mkdir -p', 'gunzip -c "$imp/session.jsonl.gz"', 'mv -f'];
    const at = order.map((needle) => script.indexOf(needle));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const code of [10, 11, 12, 13]) expect(script).toContain(`exit ${code}`);
    expect(script).toContain('trap \'rm -rf -- "$imp"\' EXIT');
  });

  it('quotes the branch and writes the conversation under the repo folder slug', () => {
    expect(script).toContain(`git checkout --quiet -B 'tom/it'\\''s' ${BASE} || exit 11`);
    expect(script).toContain(`mv -f "$HOME"/.claude/projects/-work-my-app/${SESSION}.jsonl.talyn-tmp "$HOME"/.claude/projects/-work-my-app/${SESSION}.jsonl`);
    expect(boxSessionPath('/work/app', SESSION)).toBe(`~/.claude/projects/-work-app/${SESSION}.jsonl`);
  });

  it('skips an empty patch and never fetches when the commit is there', () => {
    expect(script).toContain('if [ -s "$imp/changes.patch" ]');
    expect(script).toMatch(/if ! git cat-file -e '[0-9a-f]{40}\^\{commit\}' 2>\/dev\/null; then\n {2}git fetch/);
  });
});
