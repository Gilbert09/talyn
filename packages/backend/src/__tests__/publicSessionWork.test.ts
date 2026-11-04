import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiScope, WorkbenchChanges } from '@talyn/shared';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn, type ExecReply } from './helpers/fakeFleet.js';
import { callPublic, mintToken, startPublicApi, type Loose } from './helpers/publicApi.js';
import {
  repositories,
  workbenchChats,
  workbenchCheckpoints,
  workbenchPreviewHosts,
  workbenchScriptRuns,
  workbenches,
  workspaces,
} from '../db/schema.js';

/**
 * `/v1` session work and chat extras end to end against a fake fleet:
 * changes (stored copy and live), diff, files, scripts, previews, the pull
 * request actions, threads, timing, resize, readiness, and the chat queue,
 * rename, close and checkpoints. Also the public rules: 404 out of reach,
 * scopes, workspace binding, idempotent replays and read-only local sessions.
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

// Starting a script runs a durable exec, and opening a PR runs git and GitHub. Both
// services have their own suites; here they pass through unless a test stubs them.
vi.mock('../services/workbenches/scripts.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../services/workbenches/scripts.js')>();
  return { ...mod, startScript: vi.fn(mod.startScript), stopScript: vi.fn(mod.stopScript) };
});
vi.mock('../services/workbenches/pullRequest.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../services/workbenches/pullRequest.js')>();
  return { ...mod, createWorkbenchPullRequest: vi.fn(mod.createWorkbenchPullRequest) };
});

const { settleArchivesForTests } = await import('../services/workbenches/lifecycle.js');
const { memoryWorkObjectStore, setWorkObjectStoreForTests } = await import('../services/workbenches/workStorage.js');
const { changesSnapshotKey, resetChangesSnapshotsForTests } = await import('../services/workbenches/changesSnapshot.js');
const { githubService } = await import('../services/github.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { setWorkbenchFleetClientForTests } = await import('../services/workbenches/sandboxRuntime.js');
const { resetSandboxStatusCacheForTests } = await import('../services/workbenches/sandboxStatus.js');
const { resetChangesStoreForTests } = await import('../services/workbenches/changesStore.js');
const { resetChangesStoredForTests } = await import('../services/workbenches/changesStored.js');
const { storeChangesCopy } = await import('./helpers/storedChanges.js');
const { getChat, getWorkbench, updateWorkbench } = await import('../services/workbenches/store.js');
const { startScript, stopScript } = await import('../services/workbenches/scripts.js');
const { createWorkbenchPullRequest } = await import('../services/workbenches/pullRequest.js');
const { listScriptRunsQuery, listThreadSessionsQuery, queuedMessagesQuery } = await import('../services/public/workQueries.js');

const ALL: ApiScope[] = ['sessions:write', 'repositories:read', 'workspaces:read'];
const b64 = (text: string) => Buffer.from(text).toString('base64');

/** What `getChanges` reads: one framed section per git command. */
function changesReply(path: string, added: number): ExecReply {
  return {
    stdout: [
      `MB ${b64('a'.repeat(40))}`,
      `HEAD ${b64('b'.repeat(40))}`,
      `NUMSTAT ${b64(`${added}\t0\t${path}\0`)}`,
      `NAMES ${b64(`M\0${path}\0`)}`,
      `UNCOMMITTED_NUMSTAT ${b64(`${added}\t0\t${path}\0`)}`,
      `UNCOMMITTED_NAMES ${b64(`M\0${path}\0`)}`,
      `COMMITTED_NUMSTAT ${b64('')}`,
      `COMMITTED_NAMES ${b64('')}`,
      `UNTRACKED ${b64('')}`,
      `COUNTS ${b64('')}`,
    ].join('\n'),
  };
}

const isChangesRead = (script: string) => script.includes('--numstat');

describe('/v1 session work', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let api: Awaited<ReturnType<typeof startPublicApi>>;
  let fleet: FakeFleet;
  let token: string;
  let store: ReturnType<typeof memoryWorkObjectStore>;

  const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>, as = token) =>
    callPublic(api.base, method, path, { token: as, body, headers });

  function scriptedFleet(turn: (script: string) => ExecReply | Promise<ExecReply> | null = () => null): void {
    fleet.handler = async (script) => {
      const custom = await turn(script);
      if (custom) return custom;
      if (isChangesRead(script)) return changesReply('src/a.ts', 2);
      if (isAgentTurn(script)) return { stdout: claudeTurnLines('sess-1', 'done') };
      if (script.includes('git commit-tree')) return { stdout: `${'c'.repeat(40)}\n` };
      return { exitCode: 0, stdout: '' };
    };
  }

  async function createReadySession(extra: Record<string, unknown> = {}): Promise<Loose> {
    const res = await call('POST', '/sessions', { workspace_id: 'ws-a', repository_id: 'repo-a', agent: 'claude', ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await vi.waitFor(async () => expect((await getWorkbench(res.body.id))?.status).toBe('ready'), { timeout: 5000 });
    await vi.waitFor(async () => expect((await getChat(res.body.chats[0].id))?.status).not.toBe('running'), { timeout: 5000 });
    return res.body;
  }

  async function insertSession(id: string, extra: Partial<typeof workbenches.$inferInsert> = {}) {
    await testDb.db.insert(workbenches).values({
      id, workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'acme/app', name: id, branch: id, baseBranch: 'main',
      runtime: 'sandbox', agent: 'claude', status: 'ready', ...extra,
    });
  }

  beforeEach(async () => {
    creds = { claudeToken: 'sk-ant-oat-claude', openaiKey: 'oa-codex' };
    vi.stubEnv('PUBLIC_API_ENABLED', 'true');
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    vi.stubEnv('FLEET_API_TOKEN', 'fleet-token');
    vi.stubEnv('FLEET_PINNED_ENDPOINT', '');
    vi.stubEnv('FLEET_GATEWAY_TOKEN', '');
    vi.stubEnv('FLEET_ALLOWED', 'true');
    vi.stubEnv('PREVIEW_BASE_DOMAIN', '');
    resetFeatureFlagsForTests();
    resetChangesSnapshotsForTests();
    resetSandboxStatusCacheForTests();
    store = memoryWorkObjectStore();
    setWorkObjectStoreForTests(store);
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-a2', ownerId: 'owner-a', name: 'A2' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    await testDb.db.insert(repositories).values([
      {
        id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main',
        settings: { preview: { ports: [{ port: 3000, label: 'web', primary: true }] } },
      },
      { id: 'repo-b', workspaceId: 'ws-b', name: 'other/app', url: 'https://github.com/other/app', defaultBranch: 'main' },
    ]);
    vi.spyOn(githubService, 'branchExists').mockResolvedValue(false);
    vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    vi.spyOn(githubService, 'getRefSha').mockRejectedValue(new Error('offline'));
    fleet = new FakeFleet();
    scriptedFleet();
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
    token = await mintToken('owner-a', { scopes: ALL });
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
    // Clear, not reset: a reset drops the pass-through to the real service.
    vi.mocked(startScript).mockClear();
    vi.mocked(stopScript).mockClear();
    vi.mocked(createWorkbenchPullRequest).mockClear();
    resetFeatureFlagsForTests();
  });

  describe('changes', () => {
    it('reads a running sandbox live, in the public shape', async () => {
      const session = await createReadySession();
      const res = await call('GET', `/sessions/${session.id}/changes`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        object: 'session_changes',
        session_id: session.id,
        files: [{ path: 'src/a.ts', old_path: null, status: 'modified', added: 2, removed: 0, binary: false }],
        uncommitted: [{ path: 'src/a.ts', old_path: null, status: 'modified', added: 2, removed: 0, binary: false }],
        committed: [],
        uncommitted_stat: { added: 2, removed: 0, files: 1 },
        committed_stat: { added: 0, removed: 0, files: 0 },
        base_sha: 'a'.repeat(40),
        head_sha: 'b'.repeat(40),
        snapshot_at: null,
      });
    });

    describe('a sleeping sandbox', () => {
      let session: Loose;
      const stored: WorkbenchChanges = {
        files: [{ path: 'src/old.ts', status: 'added', added: 5, removed: 0, binary: false }],
        uncommitted: [],
        committed: [{ path: 'src/old.ts', status: 'added', added: 5, removed: 0, binary: false }],
        uncommittedStats: { added: 0, removed: 0, files: 0 },
        committedStats: { added: 5, removed: 0, files: 1 },
        base: 'a'.repeat(40),
        headSha: 'c'.repeat(40),
      };

      beforeEach(async () => {
        session = await createReadySession();
        // Production never writes the sleep into the row: only the fleet knows.
        fleet.sandboxStatus = 'suspended';
        resetSandboxStatusCacheForTests();
        store.objects.set(
          changesSnapshotKey({ workspaceId: 'ws-a', id: session.id }),
          Buffer.from(JSON.stringify({ version: 1, takenAt: '2026-11-01T10:00:00.000Z', changes: stored })),
        );
      });

      it('answers from the stored copy and never touches the sandbox', async () => {
        const before = fleet.scripts.length;
        const res = await call('GET', `/sessions/${session.id}/changes`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          snapshot_at: '2026-11-01T10:00:00.000Z',
          head_sha: 'c'.repeat(40),
          files: [{ path: 'src/old.ts', status: 'added', added: 5 }],
        });
        expect(fleet.scripts.length).toBe(before);
      });

      it('wakes the sandbox for live=true', async () => {
        const res = await call('GET', `/sessions/${session.id}/changes?live=true`);
        expect(res.body).toMatchObject({ snapshot_at: null, files: [{ path: 'src/a.ts' }] });
      });

      it('refuses with snapshot_unavailable when nothing is stored, without waking the sandbox', async () => {
        store.objects.clear();
        const before = fleet.scripts.length;
        const res = await call('GET', `/sessions/${session.id}/changes`);
        expect([res.status, res.body.error.code]).toEqual([409, 'snapshot_unavailable']);
        expect(fleet.scripts.length).toBe(before);
      });
    });

    it('answers a thread with no changes', async () => {
      await insertSession('t1', { kind: 'thread', repositoryId: null, repoFullName: '', branch: '', baseBranch: '' });
      const res = await call('GET', '/sessions/t1/changes');
      expect(res.body).toMatchObject({ files: [], base_sha: null, head_sha: null });
    });
  });

  describe('diff and files', () => {
    let session: Loose;
    beforeEach(async () => {
      session = await createReadySession();
      scriptedFleet((script) => {
        if (script.includes('git diff --no-color')) return { stdout: 'diff --git a/src/a.ts b/src/a.ts\n+hello\n' };
        if (script.includes('git ls-files --cached')) return { stdout: 'README.md\0src/a.ts\0' };
        if (script.includes('missing.ts')) return { exitCode: 3 };
        if (script.includes('cat ')) return { stdout: 'export const a = 1;\n' };
        return null;
      });
    });

    it('reads the whole diff and one file’s diff', async () => {
      const whole = await call('GET', `/sessions/${session.id}/diff`);
      expect(whole.body).toEqual({
        object: 'diff', session_id: session.id, path: null, scope: 'combined', patch: 'diff --git a/src/a.ts b/src/a.ts\n+hello\n',
        source: 'live', snapshot_at: null,
      });
      const one = await call('GET', `/sessions/${session.id}/diff?path=src/a.ts&scope=uncommitted`);
      expect(one.body).toMatchObject({ path: 'src/a.ts', scope: 'uncommitted' });
      expect(fleet.scripts.at(-1)).toContain('-- src/a.ts');
    });

    it.each([
      ['a path outside the repository', '/diff?path=../etc/passwd', 400, 'bad_path'],
      ['an unknown scope', '/diff?scope=everything', 400, 'invalid_parameter'],
      ['no path for a file read', '/files/content', 400, 'invalid_parameter'],
      ['a file that does not exist', '/files/content?path=missing.ts', 404, 'file_not_found'],
    ])('refuses %s', async (_label, suffix, status, code) => {
      const res = await call('GET', `/sessions/${session.id}${suffix}`);
      expect([res.status, res.body.error.code]).toEqual([status, code]);
    });

    it('lists files and reads one', async () => {
      const list = await call('GET', `/sessions/${session.id}/files`);
      expect(list.body).toEqual({ object: 'file_list', session_id: session.id, paths: ['README.md', 'src/a.ts'], source: 'live', snapshot_at: null });
      const file = await call('GET', `/sessions/${session.id}/files/content?path=src/a.ts`);
      expect(file.body).toEqual({
        object: 'file_content', session_id: session.id, path: 'src/a.ts', encoding: 'utf8', content: 'export const a = 1;\n',
        source: 'live', snapshot_at: null,
      });
    });

    describe('of a sleeping sandbox', () => {
      const MB = 'a'.repeat(40);
      const PATCH = 'diff --git a/src/a.ts b/src/a.ts\n+stored\n';
      beforeEach(async () => {
        const row = (await getWorkbench(session.id))!;
        const file = { path: 'src/a.ts', status: 'modified' as const, added: 1, removed: 0, binary: false };
        await storeChangesCopy(store, { workspaceId: 'ws-a', id: session.id, sandboxId: row.sandboxId! }, {
          changes: { files: [file], uncommitted: [file], committed: [], base: MB, headSha: 'b'.repeat(40) },
          patch: PATCH, patchUncommitted: PATCH, patchCommitted: '',
          files: ['README.md', 'src/a.ts'],
          contents: { 'src/a.ts': 'stored\n' },
        });
        fleet.sandboxStatus = 'suspended';
        resetSandboxStatusCacheForTests();
        resetChangesStoreForTests();
        resetChangesStoredForTests();
      });

      it.each([
        ['the diff', '/diff', { object: 'diff', patch: PATCH, source: 'stored', snapshot_at: '2026-11-01T10:00:00.000Z' }],
        ['the file list', '/files', { object: 'file_list', paths: ['README.md', 'src/a.ts'], source: 'stored', snapshot_at: '2026-11-01T10:00:00.000Z' }],
        ['a changed file', '/files/content?path=src/a.ts', { object: 'file_content', content: 'stored\n', source: 'stored' }],
      ])('answers %s from the stored copy and never touches the sandbox', async (_name, suffix, body) => {
        const before = { scripts: fleet.scripts.length, resumes: fleet.resumes };
        const res = await call('GET', `/sessions/${session.id}${suffix}`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject(body);
        expect({ scripts: fleet.scripts.length, resumes: fleet.resumes }).toEqual(before);
      });

      it('reads a file the session did not change from GitHub', async () => {
        vi.spyOn(githubService, 'getFileContent').mockResolvedValue({ content: '# read me\n', size: 10, bytes: Buffer.from('# read me\n') });
        const res = await call('GET', `/sessions/${session.id}/files/content?path=README.md`);
        expect(res.body).toMatchObject({ content: '# read me\n', source: 'github', encoding: 'utf8' });
      });

      it.each(['/diff?live=true', '/files?live=true', '/files/content?path=src/a.ts&live=true'])('reads the sandbox for %s', async (suffix) => {
        const before = fleet.scripts.length;
        const res = await call('GET', `/sessions/${session.id}${suffix}`);
        expect(res.status).toBe(200);
        expect(res.body.source).toBe('live');
        expect(fleet.scripts.length).toBe(before + 1);
      });

      it.each(['/diff', '/files', '/files/content?path=src/a.ts'])('refuses %s with snapshot_unavailable when nothing is stored', async (suffix) => {
        store.objects.clear();
        resetChangesStoreForTests();
        resetChangesStoredForTests();
        const before = fleet.scripts.length;
        const res = await call('GET', `/sessions/${session.id}${suffix}`);
        expect([res.status, res.body.error.code]).toEqual([409, 'snapshot_unavailable']);
        expect(fleet.scripts.length).toBe(before);
      });
    });

    it('refuses a sandbox read on an archived session', async () => {
      await updateWorkbench(session.id, { archivedAt: new Date() });
      const res = await call('GET', `/sessions/${session.id}/files`);
      expect([res.status, res.body.error.code]).toEqual([409, 'not_ready']);
    });
  });

  describe('scripts', () => {
    let session: Loose;
    beforeEach(async () => {
      session = await createReadySession();
    });

    async function insertRun(name: string, running: boolean, exitCode: number | null, output = '') {
      await testDb.db.insert(workbenchScriptRuns).values({
        id: `${session.id}:${name}`, workbenchId: session.id, workspaceId: 'ws-a', sandboxId: 'sb', name, generation: 'g', owner: 'o',
        output, running, exitCode,
      });
    }

    it('lists the scripts that ran without waking the sandbox', async () => {
      await insertRun('setup', false, 0);
      await insertRun('web', true, null);
      const before = fleet.scripts.length;
      const res = await call('GET', `/sessions/${session.id}/scripts`);
      expect(res.body).toEqual({
        object: 'list',
        has_more: false,
        next_cursor: null,
        data: [
          { object: 'script', session_id: session.id, name: 'setup', kind: 'setup', command: null, default: null, status: 'exited', exit_code: 0 },
          { object: 'script', session_id: session.id, name: 'web', kind: 'run', command: null, default: null, status: 'running', exit_code: null },
        ],
      });
      expect(fleet.scripts.length).toBe(before);
    });

    it('lists every defined script with live=true', async () => {
      await insertRun('setup', false, 1);
      const toml = '[scripts]\nsetup = "npm ci"\n\n[scripts.run.web]\ncommand = "npm run dev"\ndefault = true\n';
      scriptedFleet((script) => (script.includes('.talyn/settings.toml') ? { stdout: `TALYN ${b64(toml)}` } : null));
      const res = await call('GET', `/sessions/${session.id}/scripts?live=true`);
      expect(res.body.data).toEqual([
        expect.objectContaining({ name: 'setup', kind: 'setup', command: 'npm ci', status: 'exited', exit_code: 1 }),
        expect.objectContaining({ name: 'web', kind: 'run', command: 'npm run dev', default: true, status: 'not_started' }),
      ]);
    });

    it('starts and stops a script and answers its state', async () => {
      vi.mocked(startScript).mockImplementationOnce(async (_row, name) => {
        await insertRun(name, true, null);
        return { done: Promise.resolve(0) };
      });
      vi.mocked(stopScript).mockImplementationOnce(async (_row, name) => {
        await testDb.db.update(workbenchScriptRuns).set({ running: false }).where(eq(workbenchScriptRuns.name, name));
      });
      const started = await call('POST', `/sessions/${session.id}/scripts/web/start`, undefined, { 'Idempotency-Key': 'start-1' });
      expect(started.status).toBe(200);
      expect(started.body).toMatchObject({ object: 'script', name: 'web', status: 'running' });
      const replay = await call('POST', `/sessions/${session.id}/scripts/web/start`, undefined, { 'Idempotency-Key': 'start-1' });
      expect(replay.headers.get('idempotent-replayed')).toBe('true');
      expect(startScript).toHaveBeenCalledTimes(1);
      const stopped = await call('POST', `/sessions/${session.id}/scripts/web/stop`);
      expect(stopped.body).toMatchObject({ status: 'exited', exit_code: null });
    });

    it('refuses a script the config does not define', async () => {
      const res = await call('POST', `/sessions/${session.id}/scripts/deploy/start`);
      expect([res.status, res.body.error.code]).toEqual([404, 'script_not_found']);
    });

    it('reads the stored output, and an empty one for a script that has not run', async () => {
      await insertRun('web', false, 2, 'listening on 3000\nboom\n');
      const res = await call('GET', `/sessions/${session.id}/scripts/web/output`);
      expect(res.body).toEqual({
        object: 'script_output', session_id: session.id, name: 'web', status: 'exited', exit_code: 2, output: 'listening on 3000\nboom\n',
      });
      const none = await call('GET', `/sessions/${session.id}/scripts/setup/output`);
      expect(none.body).toMatchObject({ status: 'not_started', output: '' });
    });

    it('never selects the output to list the scripts', () => {
      expect(listScriptRunsQuery('s').toSQL().sql).not.toContain('"output"');
    });
  });

  describe('previews', () => {
    let session: Loose;
    beforeEach(async () => {
      session = await createReadySession();
    });

    it('lists the configured ports and the ports with a hosted link', async () => {
      vi.stubEnv('PREVIEW_BASE_DOMAIN', 'preview.talyn.test');
      await testDb.db.insert(workbenchPreviewHosts).values([
        { id: 'a'.repeat(32), workbenchId: session.id, port: 3000 },
        { id: 'b'.repeat(32), workbenchId: session.id, port: 8080 },
      ]);
      const res = await call('GET', `/sessions/${session.id}/previews`);
      expect(res.body.data).toEqual([
        { object: 'preview', session_id: session.id, port: 3000, label: 'web', primary: true, origin: `https://${'a'.repeat(32)}-3000.preview.talyn.test` },
        { object: 'preview', session_id: session.id, port: 8080, label: null, primary: false, origin: `https://${'b'.repeat(32)}-8080.preview.talyn.test` },
      ]);
    });

    it('makes a one-time link, and replays it for the same key', async () => {
      vi.stubEnv('PREVIEW_BASE_DOMAIN', 'preview.talyn.test');
      const res = await call('POST', `/sessions/${session.id}/previews`, { port: 3000 }, { 'Idempotency-Key': 'pv-1' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ object: 'preview_link', session_id: session.id, port: 3000, expires_at: expect.any(String) });
      expect(res.body.url).toMatch(/^https:\/\/[0-9a-f]{32}-3000\.preview\.talyn\.test\/__talyn\/auth\?ticket=/);
      const again = await call('POST', `/sessions/${session.id}/previews`, { port: 3000 }, { 'Idempotency-Key': 'pv-1' });
      expect(again.body.url).toBe(res.body.url);
    });

    it.each([
      ['no preview domain', '', { port: 3000 }, 404, 'preview_links_unavailable'],
      ['a privileged port', 'preview.talyn.test', { port: 80 }, 400, 'invalid_parameter'],
    ])('refuses a link with %s', async (_label, domain, body, status, code) => {
      vi.stubEnv('PREVIEW_BASE_DOMAIN', domain);
      const res = await call('POST', `/sessions/${session.id}/previews`, body);
      expect([res.status, res.body.error.code]).toEqual([status, code]);
    });
  });

  describe('pull request actions', () => {
    let session: Loose;
    beforeEach(async () => {
      session = await createReadySession();
    });

    it('opens a pull request and answers a receipt with the session', async () => {
      vi.mocked(createWorkbenchPullRequest).mockResolvedValueOnce({
        workbench: {} as never,
        pullRequest: { number: 42, url: 'https://github.com/acme/app/pull/42' },
        existing: false,
      });
      const res = await call('POST', `/sessions/${session.id}/pull_request`, { title: 'Add a readme', draft: true, commit_message: 'docs' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        object: 'pull_request_receipt', session_id: session.id, number: 42, existing: false, session: { object: 'session', id: session.id },
      });
      expect(vi.mocked(createWorkbenchPullRequest).mock.calls[0][1]).toEqual({ title: 'Add a readme', draft: true, commitMessage: 'docs' });
    });

    it('answers 200 when the branch already had a pull request', async () => {
      vi.mocked(createWorkbenchPullRequest).mockResolvedValueOnce({
        workbench: {} as never, pullRequest: { number: 7, url: 'u' }, existing: true,
      });
      const res = await call('POST', `/sessions/${session.id}/pull_request`, { title: 'x' });
      expect([res.status, res.body.existing]).toEqual([200, true]);
    });

    it('refuses a pull request with no title', async () => {
      const res = await call('POST', `/sessions/${session.id}/pull_request`, {});
      expect([res.status, res.body.error.param]).toEqual([400, 'title']);
    });

    it('sends the fix-checks prompt to the chat', async () => {
      const res = await call('POST', `/sessions/${session.id}/fix_checks`, {});
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ object: 'action_receipt', session_id: session.id, action: 'fix_checks', chat_id: session.chats[0].id });
      await vi.waitFor(async () => expect((await getChat(session.chats[0].id))?.turnCount).toBe(1), { timeout: 5000 });
    });

    it('refuses a chat of another session', async () => {
      const res = await call('POST', `/sessions/${session.id}/resolve_conflicts`, { chat_id: 'not-mine' });
      expect(res.status).toBe(404);
    });

    it('refuses to merge with no pull request', async () => {
      const res = await call('POST', `/sessions/${session.id}/merge`);
      expect([res.status, res.body.error.code]).toEqual([409, 'no_pull_request']);
    });
  });

  describe('threads', () => {
    it('lists a thread’s sessions, newest first and paged', async () => {
      await insertSession('thread-1', { kind: 'thread', repositoryId: null, repoFullName: '', branch: '', baseBranch: '' });
      await insertSession('c1', { threadId: 'thread-1', createdAt: new Date('2026-11-01T00:00:01Z') });
      await insertSession('c2', { threadId: 'thread-1', createdAt: new Date('2026-11-01T00:00:02Z'), archivedAt: new Date() });
      const first = await call('GET', '/sessions/thread-1/sessions?limit=1');
      expect(first.body.data.map((s: Loose) => s.id)).toEqual(['c2']);
      const second = await call('GET', `/sessions/thread-1/sessions?limit=1&cursor=${first.body.next_cursor}`);
      expect(second.body).toMatchObject({ has_more: false, data: [{ id: 'c1', thread_id: 'thread-1' }] });
      const notThread = await call('GET', '/sessions/c1/sessions');
      expect([notThread.status, notThread.body.error.code]).toEqual([409, 'not_thread']);
    });

    it('does not read the settings blob to list a thread', () => {
      expect(listThreadSessionsQuery('t', null, 10).toSQL().sql).not.toMatch(/"settings"\s*(,|from)/);
    });

    it('continues a session as a thread', async () => {
      const session = await createReadySession();
      const res = await call('POST', `/sessions/${session.id}/thread`, { prompt: 'plan the next steps' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ object: 'session', kind: 'thread', repository_id: null });
      await vi.waitFor(async () => expect((await getWorkbench(res.body.id))?.status).toBe('ready'), { timeout: 5000 });
      expect((await getWorkbench(session.id))?.threadId).toBe(res.body.id);
    });
  });

  describe('timing, resize and readiness', () => {
    it('answers an empty timing summary', async () => {
      await insertSession('s1');
      const res = await call('GET', '/sessions/s1/timing');
      expect(res.body).toEqual({
        object: 'session_timing', session_id: 's1', turns: 0, wall_ms: 0, tool_ms: 0, model_ms: 0, calls: 0, categories: {}, slowest: [], recent_turns: [],
      });
    });

    it('answers unchanged for the size the sandbox has', async () => {
      const session = await createReadySession();
      fleet.getSandbox = async (id: string) => ({ sandbox: { id, status: 'running', memMib: 4096 }, terminal: false }) as never;
      const res = await call('POST', `/sessions/${session.id}/resize`, { size: 'standard' });
      expect(res.body).toEqual({
        object: 'resize_receipt', session_id: session.id, outcome: 'unchanged', size: 'standard', remembered_for_repository: false, continued: false,
      });
    });

    it.each([
      ['an unknown size', 's1', { size: 'huge' }, 400, 'invalid_parameter'],
      ['a thread', 't1', { size: 'large' }, 409, 'thread_resize'],
    ])('refuses to resize %s', async (_label, id, body, status, code) => {
      await insertSession('s1');
      await insertSession('t1', { kind: 'thread', repositoryId: null, repoFullName: '', branch: '', baseBranch: '' });
      const res = await call('POST', `/sessions/${id}/resize`, body);
      expect([res.status, res.body.error.code]).toEqual([status, code]);
    });

    it('says whether sessions can start, even with sessions off for the account', async () => {
      const ok = await call('GET', '/workspaces/ws-a/readiness');
      expect(ok.body).toMatchObject({ object: 'session_readiness', workspace_id: 'ws-a', ok: true, agents: { claude: { ok: true, reason: null } } });
      creds = { openaiKey: 'oa-codex' };
      vi.stubEnv('WORKBENCHES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      const off = await call('GET', '/workspaces/ws-a/readiness');
      expect(off.body.ok).toBe(false);
      expect(off.body.reasons.map((r: Loose) => r.code)).toContain('flag_off');
      expect(off.body.agents.claude).toMatchObject({ ok: false, reason: { code: 'agent_not_connected' } });
      expect((await call('GET', '/workspaces/ws-b/readiness')).status).toBe(404);
    });
  });

  describe('chats', () => {
    beforeEach(async () => {
      await insertSession('s1');
      await testDb.db.insert(workbenchChats).values({
        id: 'c1', workbenchId: 's1', workspaceId: 'ws-a', title: 'Chat', agent: 'claude',
        queuedMessages: [
          { id: 'q1', text: 'first', queuedAt: '2026-11-01T00:00:00.000Z', attachments: [{ name: 'a.png', mediaType: 'image/png', data: 'QUJD' }] },
          { id: 'q2', text: 'second', queuedAt: '2026-11-01T00:00:01.000Z', planMode: true, origin: 'talyn' },
        ] as never,
      });
    });

    it('renames a chat and changes its settings', async () => {
      const res = await call('PATCH', '/chats/c1', { title: '  Review  ', model: 'claude-opus-5', effort: 'high', plan_mode: true });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ object: 'chat', title: 'Review', model: 'claude-opus-5', effort: 'high', plan_mode: true });
      const cleared = await call('PATCH', '/chats/c1', { model: null, effort: null });
      expect(cleared.body).toMatchObject({ model: null, effort: null, title: 'Review' });
    });

    it.each([
      ['an empty title', { title: '   ' }, 'title'],
      ['an unknown effort', { effort: 'max-plus' }, 'effort'],
      ['a camelCase field', { planMode: true }, 'planMode'],
    ])('refuses %s', async (_label, body, param) => {
      const res = await call('PATCH', '/chats/c1', body);
      expect([res.status, res.body.error.param]).toEqual([400, param]);
    });

    it('lists the queue without the attachments, removes one, then clears it', async () => {
      const list = await call('GET', '/chats/c1/queue');
      expect(list.body.data).toEqual([
        { object: 'queued_message', id: 'q1', chat_id: 'c1', text: 'first', model: null, effort: null, plan_mode: null, attachment_count: 1, origin: 'user', queued_at: '2026-11-01T00:00:00.000Z' },
        { object: 'queued_message', id: 'q2', chat_id: 'c1', text: 'second', model: null, effort: null, plan_mode: true, attachment_count: 0, origin: 'talyn', queued_at: '2026-11-01T00:00:01.000Z' },
      ]);
      expect(JSON.stringify(list.body)).not.toContain('QUJD');
      const removed = await call('DELETE', '/chats/c1/queue/q1');
      expect(removed.body.queued_message_count).toBe(1);
      const missing = await call('DELETE', '/chats/c1/queue/q1');
      expect([missing.status, missing.body.error.code]).toEqual([404, 'queued_message_not_found']);
      const cleared = await call('DELETE', '/chats/c1/queue');
      expect(cleared.body.queued_message_count).toBe(0);
    });

    it('builds the queue in SQL and never selects the attachments', () => {
      const sql = queuedMessagesQuery('c1').toSQL().sql;
      expect(sql).toContain("jsonb_array_length(e.value -> 'attachments')");
      expect(sql).not.toContain("'attachments', ");
    });

    it('closes a chat, and closing again changes nothing', async () => {
      const res = await call('POST', '/chats/c1/close');
      expect(res.status).toBe(200);
      expect(res.body.closed_at).toBeTruthy();
      expect(res.body.queued_message_count).toBe(0);
      const again = await call('POST', '/chats/c1/close');
      expect(again.body.closed_at).toBe(res.body.closed_at);
    });

    it('lists checkpoints and refuses one that does not exist', async () => {
      await testDb.db.insert(workbenchCheckpoints).values({ chatId: 'c1', turn: 1, ref: 'refs/talyn/checkpoints/c1/1', sha: 'd'.repeat(40) });
      const list = await call('GET', '/chats/c1/checkpoints');
      expect(list.body.data).toEqual([{ object: 'checkpoint', chat_id: 'c1', turn: 1, sha: 'd'.repeat(40), created_at: expect.any(String) }]);
      const res = await call('POST', '/chats/c1/checkpoints/9/restore');
      expect([res.status, res.body.error.code]).toEqual([404, 'checkpoint_not_found']);
    });
  });

  describe('access', () => {
    beforeEach(async () => {
      await testDb.db.insert(workbenches).values({
        id: 'sb', workspaceId: 'ws-b', repositoryId: 'repo-b', repoFullName: 'other/app', name: 'sb', branch: 'sb',
        baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
      });
      await testDb.db.insert(workbenchChats).values({ id: 'cb', workbenchId: 'sb', workspaceId: 'ws-b', title: 'Chat', agent: 'claude' });
    });

    it.each([
      ['GET', '/sessions/sb/changes', undefined, 'session_not_found'],
      ['GET', '/sessions/sb/diff', undefined, 'session_not_found'],
      ['GET', '/sessions/sb/files', undefined, 'session_not_found'],
      ['GET', '/sessions/sb/files/content?path=a', undefined, 'session_not_found'],
      ['GET', '/sessions/sb/scripts', undefined, 'session_not_found'],
      ['POST', '/sessions/sb/scripts/run/start', undefined, 'session_not_found'],
      ['GET', '/sessions/sb/scripts/run/output', undefined, 'session_not_found'],
      ['GET', '/sessions/sb/previews', undefined, 'session_not_found'],
      ['POST', '/sessions/sb/pull_request', { title: 'x' }, 'session_not_found'],
      ['POST', '/sessions/sb/fix_checks', {}, 'session_not_found'],
      ['POST', '/sessions/sb/merge', undefined, 'session_not_found'],
      ['GET', '/sessions/sb/sessions', undefined, 'session_not_found'],
      ['POST', '/sessions/sb/thread', {}, 'session_not_found'],
      ['GET', '/sessions/sb/timing', undefined, 'session_not_found'],
      ['POST', '/sessions/sb/resize', { size: 'large' }, 'session_not_found'],
      ['PATCH', '/chats/cb', { title: 'x' }, 'chat_not_found'],
      ['POST', '/chats/cb/close', undefined, 'chat_not_found'],
      ['GET', '/chats/cb/queue', undefined, 'chat_not_found'],
      ['DELETE', '/chats/cb/queue', undefined, 'chat_not_found'],
      ['GET', '/chats/cb/checkpoints', undefined, 'chat_not_found'],
      ['POST', '/chats/cb/checkpoints/1/restore', undefined, 'chat_not_found'],
    ] as const)('answers 404 for %s %s', async (method, path, body, code) => {
      const res = await call(method, path, body);
      expect([res.status, res.body.error.code]).toEqual([404, code]);
    });

    it('needs sessions:write to change and sessions:read to read', async () => {
      await insertSession('s1');
      const reader = await mintToken('owner-a', { scopes: ['sessions:read'] });
      expect((await call('GET', '/sessions/s1/timing', undefined, undefined, reader)).status).toBe(200);
      for (const [method, path, body] of [
        ['POST', '/sessions/s1/merge', undefined],
        ['POST', '/sessions/s1/resize', { size: 'large' }],
        ['PATCH', '/chats/x', { title: 'x' }],
      ] as const) {
        const res = await call(method, path, body, undefined, reader);
        expect([res.status, res.body.error.code], path).toEqual([403, 'insufficient_scope']);
      }
      const none = await mintToken('owner-a', { scopes: ['workspaces:read'] });
      expect((await call('GET', '/sessions/s1/timing', undefined, undefined, none)).status).toBe(403);
    });

    it('keeps a workspace-bound token to its workspace', async () => {
      await insertSession('s1');
      const bound = await mintToken('owner-a', { scopes: ALL, workspaceIds: ['ws-a2'] });
      expect((await call('GET', '/sessions/s1/timing', undefined, undefined, bound)).status).toBe(404);
      expect((await call('GET', '/workspaces/ws-a/readiness', undefined, undefined, bound)).status).toBe(404);
    });
  });

  describe('local sessions are read-only', () => {
    beforeEach(async () => {
      await insertSession('local-1', { runtime: 'local', deviceId: 'device-1', localPath: '/Users/me/src/app' });
      await testDb.db.insert(workbenchChats).values({ id: 'local-chat', workbenchId: 'local-1', workspaceId: 'ws-a', title: 'Chat', agent: 'claude' });
    });

    it.each([
      ['POST', '/sessions/local-1/scripts/run/start', undefined],
      ['POST', '/sessions/local-1/scripts/run/stop', undefined],
      ['POST', '/sessions/local-1/previews', { port: 3000 }],
      ['POST', '/sessions/local-1/pull_request', { title: 'x' }],
      ['POST', '/sessions/local-1/fix_checks', {}],
      ['POST', '/sessions/local-1/resolve_conflicts', {}],
      ['POST', '/sessions/local-1/merge', undefined],
      ['POST', '/sessions/local-1/thread', {}],
      ['POST', '/sessions/local-1/resize', { size: 'large' }],
      ['PATCH', '/chats/local-chat', { title: 'x' }],
      ['POST', '/chats/local-chat/close', undefined],
      ['DELETE', '/chats/local-chat/queue', undefined],
      ['POST', '/chats/local-chat/checkpoints/1/restore', undefined],
      ['GET', '/sessions/local-1/changes', undefined],
      ['GET', '/sessions/local-1/files', undefined],
    ] as const)('answers 409 local_runtime for %s %s', async (method, path, body) => {
      const res = await call(method, path, body);
      expect([res.status, res.body.error.code]).toEqual([409, 'local_runtime']);
      expect((await getChat('local-chat'))?.closedAt).toBeNull();
    });

    it('reads what Talyn stores about a local session', async () => {
      expect((await call('GET', '/sessions/local-1/scripts')).status).toBe(200);
      expect((await call('GET', '/sessions/local-1/timing')).status).toBe(200);
      expect((await call('GET', '/chats/local-chat/queue')).status).toBe(200);
    });
  });
});
