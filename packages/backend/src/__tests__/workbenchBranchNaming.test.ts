import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { pullRequests, repositories, workbenches, workspaces } from '../db/schema.js';
import { githubService } from '../services/github.js';
import type { SandboxRun } from '../services/workbenches/cheapAgent.js';
import type { SandboxExecResult } from '../services/workbenches/sandboxRuntime.js';

const emitted: Array<{ type: string; payload: unknown }> = [];

vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: (_workspaceId: string, event: { type: string; payload: unknown }) => {
    emitted.push({ type: event.type, payload: event.payload });
  },
}));

const { nameBranchBeforePullRequest, nameSessionBranch, setPrBranchNamingDeadlineForTests, BRANCH_NAMING_MAX_TURNS } = await import(
  '../services/workbenches/branchName.js'
);
const { getWorkbench, insertChat, insertWorkbench, updateChat, updateWorkbench } = await import('../services/workbenches/store.js');

const START = 'tom/look-login';
const FAR_FUTURE = new Date('2099-01-01T00:00:00Z');
const input = { message: 'look at the login page', finalMessage: 'I fixed the redirect loop after login.' };

const result = (stdout: string, exitCode = 0): SandboxExecResult => ({ exitCode, stdout, stderr: '', stdoutBytes: Buffer.from(stdout) });
const section = (label: string, value: string) => `${label} ${Buffer.from(value).toString('base64')}`;

interface BoxOptions {
  branch?: string;
  upstream?: string;
  files?: string[];
  answer?: string | (() => SandboxExecResult | Promise<SandboxExecResult>);
  probeExit?: number;
  probeHold?: Promise<void>;
  onRename?: (from: string, to: string) => void | Promise<void>;
}

/** A sandbox that answers the probe, the model call and `git branch -m`, and remembers its branch. */
function fakeBox(opts: BoxOptions = {}) {
  const box = { branch: opts.branch ?? START, renames: [] as Array<[string, string]>, prompts: [] as string[] };
  const run = vi.fn<SandboxRun>(async (_row, script) => {
    if (script.includes('rev-parse --abbrev-ref HEAD')) {
      await opts.probeHold;
      return result([
        section('BRANCH', `${box.branch}\n`),
        section('UPSTREAM', opts.upstream ?? ''),
        section('FILES', (opts.files ?? ['src/auth/redirect.ts']).map((f) => `${f}\0`).join('')),
      ].join('\n'), opts.probeExit ?? 0);
    }
    if (script.startsWith('claude ') || script.startsWith('codex ')) {
      box.prompts.push(script);
      const answer = opts.answer ?? 'fix-login-redirect';
      return typeof answer === 'string' ? result(`${answer}\n`) : answer();
    }
    const rename = /^git branch -m (\S+) (\S+)$/m.exec(script);
    if (rename) {
      await opts.onRename?.(rename[1], rename[2]);
      if (box.branch !== rename[1]) return result('', 128);
      box.branch = rename[2];
      box.renames.push([rename[1], rename[2]]);
      return result('');
    }
    throw new Error(`unexpected script: ${script}`);
  });
  return { box, run };
}

describe('nameSessionBranch', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let onGithub: Set<string>;

  beforeEach(async () => {
    emitted.length = 0;
    onGithub = new Set();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A', settings: { sessionBranchPrefix: 'tom/' } });
    await testDb.db.insert(repositories).values({ id: 'repo-a', workspaceId: 'ws-a', name: 'o/r', url: 'https://github.com/o/r' });
    await insertWorkbench({
      id: 'wb-1', workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'o/r', name: 'look-login',
      branch: START, allocatedBranch: true, baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
      sandboxId: 'talyn-wb-wb-1',
    });
    await insertChat({ id: 'chat-1', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Chat', agent: 'claude', turnCount: 1 });
    vi.spyOn(githubService, 'branchExists').mockImplementation(async (_ws, _owner, _repo, branch) => onGithub.has(branch));
  });

  afterEach(async () => {
    setPrBranchNamingDeadlineForTests(null);
    vi.restoreAllMocks();
    await testDb.cleanup();
  });

  const row = async () => (await getWorkbench('wb-1'))!;
  const namedAt = async () =>
    (await testDb.db.select({ at: workbenches.branchNamedAt }).from(workbenches).where(eq(workbenches.id, 'wb-1')))[0].at;
  const otherSession = (id: string, branch: string) => insertWorkbench({
    id, workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'o/r', name: id, branch, allocatedBranch: true,
    baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
  });
  const linkPr = async () => {
    await testDb.db.insert(pullRequests).values({
      id: 'pr-1', workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'o', repo: 'r', number: 1, state: 'open',
      lastSummary: { headBranch: START, headSha: 'abc' },
    });
    await updateWorkbench('wb-1', { pullRequestId: 'pr-1' });
  };

  it('renames the box branch, then the row, and broadcasts the update', async () => {
    const { box, run } = fakeBox({ files: ['src/auth/redirect.ts', 'src/auth/redirect.test.ts'] });
    expect(await nameSessionBranch('wb-1', input, { run })).toEqual({ outcome: 'renamed', branch: 'tom/fix-login-redirect' });
    expect(box.renames).toEqual([[START, 'tom/fix-login-redirect']]);
    expect((await row()).branch).toBe('tom/fix-login-redirect');
    expect(await namedAt()).not.toBeNull();
    const event = emitted.find((e) => e.type === 'workbench:updated');
    expect((event?.payload as { workbench: { branch: string } }).workbench.branch).toBe('tom/fix-login-redirect');
    const prompt = box.prompts[0];
    expect(prompt.startsWith('claude -p --output-format text --model haiku')).toBe(true);
    expect(prompt).toContain('look at the login page');
    expect(prompt).toContain('src/auth/redirect.test.ts');
    expect(prompt).toContain('I fixed the redirect loop after login.');
  });

  it('uses no prefix when the workspace has none, and asks codex for a codex session', async () => {
    await testDb.db.update(workspaces).set({ settings: {} }).where(eq(workspaces.id, 'ws-a'));
    await updateWorkbench('wb-1', { agent: 'codex' });
    const { box, run } = fakeBox();
    expect(await nameSessionBranch('wb-1', input, { run })).toEqual({ outcome: 'renamed', branch: 'fix-login-redirect' });
    expect(box.prompts[0].startsWith('codex exec --ephemeral')).toBe(true);
  });

  it('takes the next free suffix when the name is used elsewhere', async () => {
    await otherSession('wb-2', 'tom/fix-login-redirect');
    onGithub.add('tom/fix-login-redirect-2');
    const { run } = fakeBox();
    expect(await nameSessionBranch('wb-1', input, { run })).toEqual({ outcome: 'renamed', branch: 'tom/fix-login-redirect-3' });
  });

  type Setup = () => Promise<unknown>;
  it.each<[string, Setup, BoxOptions?]>([
    ['a branch the person chose', () => updateWorkbench('wb-1', { allocatedBranch: false })],
    ['a linked PR', linkPr],
    ['a pushed head', () => updateWorkbench('wb-1', { pushedHeadShas: ['abc'] })],
    ['a local session', () => updateWorkbench('wb-1', { runtime: 'local' })],
    ['an archived session', () => updateWorkbench('wb-1', { archivedAt: FAR_FUTURE })],
    ['a pending archive', () => updateWorkbench('wb-1', { archivedAt: FAR_FUTURE, archivePendingAt: FAR_FUTURE })],
    ['a moving session', () => updateWorkbench('wb-1', { status: 'moving' })],
    ['a branch already on GitHub', async () => onGithub.add(START)],
    ['a box on another branch', async () => undefined, { branch: 'tom/other' }],
    ['a branch with an upstream', async () => undefined, { upstream: 'origin/tom/look-login' }],
    ['a probe that fails', async () => undefined, { probeExit: 1 }],
    ['a model that fails', async () => undefined, { answer: () => result('Usage limit reached', 1) }],
    ['a model that answers prose', async () => undefined, { answer: 'Here is a title\nfor the branch' }],
    ['a model that answers garbage', async () => undefined, { answer: '!!!' }],
    ['a model that keeps the slug', async () => undefined, { answer: 'look-login' }],
    ['a model that keeps the slug with a prefix', async () => undefined, { answer: 'feature/look-login' }],
  ])('keeps the name for %s, and decides once', async (_label, setup, box) => {
    await setup();
    const before = (await row()).branch;
    const { box: state, run } = fakeBox(box);
    expect((await nameSessionBranch('wb-1', input, { run })).outcome).toBe('kept');
    expect((await row()).branch).toBe(before);
    expect(state.renames).toEqual([]);
    expect(await namedAt()).not.toBeNull();
    expect(emitted.filter((e) => e.type === 'workbench:updated')).toEqual([]);
  });

  it('keeps the name when GitHub cannot say whether the branch exists', async () => {
    vi.spyOn(githubService, 'branchExists').mockRejectedValue(new Error('GitHub 502'));
    const { run } = fakeBox();
    expect(await nameSessionBranch('wb-1', input, { run })).toEqual({ outcome: 'kept', reason: 'github_error' });
    expect(run).not.toHaveBeenCalled();
    expect(await namedAt()).not.toBeNull();
  });

  it('treats a suffixed branch as the same name', async () => {
    await updateWorkbench('wb-1', { branch: 'tom/fix-login-redirect-2' });
    const { run } = fakeBox({ branch: 'tom/fix-login-redirect-2' });
    expect(await nameSessionBranch('wb-1', input, { run })).toEqual({ outcome: 'kept', reason: 'same_name' });
  });

  it('picks again once when another session takes the name first', async () => {
    const { box, run } = fakeBox({
      onRename: async (from, to) => {
        if (from === START && to === 'tom/fix-login-redirect') await otherSession('wb-2', 'tom/fix-login-redirect');
      },
    });
    expect(await nameSessionBranch('wb-1', input, { run })).toEqual({ outcome: 'renamed', branch: 'tom/fix-login-redirect-2' });
    expect(box.renames).toEqual([[START, 'tom/fix-login-redirect'], ['tom/fix-login-redirect', 'tom/fix-login-redirect-2']]);
    expect(box.branch).toBe('tom/fix-login-redirect-2');
    expect((await row()).branch).toBe('tom/fix-login-redirect-2');
  });

  it('renames the box back when the second pick is taken too', async () => {
    const { box, run } = fakeBox({
      onRename: async (_from, to) => {
        if (to === 'tom/fix-login-redirect') await otherSession('wb-2', to);
        if (to === 'tom/fix-login-redirect-2') await otherSession('wb-3', to);
      },
    });
    expect(await nameSessionBranch('wb-1', input, { run })).toEqual({ outcome: 'kept', reason: 'name_taken' });
    expect(box.branch).toBe(START);
    expect((await row()).branch).toBe(START);
    expect(await namedAt()).not.toBeNull();
  });

  it('renames the box back when the row changed under it', async () => {
    const { box, run } = fakeBox({
      onRename: async (from) => { if (from === START) await linkPr(); },
    });
    expect(await nameSessionBranch('wb-1', input, { run })).toEqual({ outcome: 'kept', reason: 'row_changed' });
    expect(box.renames).toEqual([[START, 'tom/fix-login-redirect'], ['tom/fix-login-redirect', START]]);
    expect((await row()).branch).toBe(START);
    expect(emitted.filter((e) => e.type === 'workbench:updated')).toEqual([]);
  });

  it('keeps the row when the box rename fails', async () => {
    const { box, run } = fakeBox({ onRename: () => { box.branch = 'tom/elsewhere'; } });
    expect(await nameSessionBranch('wb-1', input, { run })).toEqual({ outcome: 'kept', reason: 'rename_failed' });
    expect((await row()).branch).toBe(START);
  });

  describe('a running turn', () => {
    it('waits without deciding, then names the branch at the next turn end', async () => {
      await insertChat({ id: 'chat-2', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Two', agent: 'claude', status: 'running', turnCount: 1 });
      const { run } = fakeBox();
      expect(await nameSessionBranch('wb-1', input, { run })).toEqual({ outcome: 'not_now', reason: 'turn_running' });
      expect(run).not.toHaveBeenCalled();
      expect(await namedAt()).toBeNull();
      await updateChat('chat-2', { status: 'idle' });
      expect((await nameSessionBranch('wb-1', input, { run })).outcome).toBe('renamed');
    });

    it('gives the claim back when a turn starts while the model answers', async () => {
      const { box, run } = fakeBox({
        answer: async () => {
          await insertChat({ id: 'chat-2', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Two', agent: 'claude', status: 'running', turnCount: 1 });
          return result('fix-login-redirect\n');
        },
      });
      expect(await nameSessionBranch('wb-1', input, { run })).toEqual({ outcome: 'not_now', reason: 'turn_running' });
      expect(box.renames).toEqual([]);
      expect(await namedAt()).toBeNull();
      expect((await row()).branch).toBe(START);
    });

    it(`stops trying once the session is past turn ${BRANCH_NAMING_MAX_TURNS}`, async () => {
      await updateChat('chat-1', { turnCount: BRANCH_NAMING_MAX_TURNS });
      await insertChat({ id: 'chat-2', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Two', agent: 'claude', status: 'running', turnCount: 1 });
      const { run } = fakeBox();
      expect(await nameSessionBranch('wb-1', input, { run })).toEqual({ outcome: 'kept', reason: 'too_many_turns' });
      expect(run).not.toHaveBeenCalled();
      expect(await namedAt()).not.toBeNull();
    });

    it(`decides when a turn starts mid-way at turn ${BRANCH_NAMING_MAX_TURNS}`, async () => {
      await updateChat('chat-1', { turnCount: BRANCH_NAMING_MAX_TURNS });
      const { box, run } = fakeBox({
        answer: async () => {
          await updateChat('chat-1', { status: 'running' });
          return result('fix-login-redirect\n');
        },
      });
      expect(await nameSessionBranch('wb-1', input, { run })).toEqual({ outcome: 'kept', reason: 'turn_running' });
      expect(box.renames).toEqual([]);
      expect(await namedAt()).not.toBeNull();
    });
  });

  it.each([1, 2, BRANCH_NAMING_MAX_TURNS])('tries at session turn %i', async (turns) => {
    await updateChat('chat-1', { turnCount: turns });
    const { run } = fakeBox();
    expect((await nameSessionBranch('wb-1', input, { run })).outcome).toBe('renamed');
  });

  it('counts turns across every chat of the session', async () => {
    await updateChat('chat-1', { turnCount: 2 });
    await insertChat({ id: 'chat-2', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Two', agent: 'claude', turnCount: 2 });
    const { run } = fakeBox();
    expect(await nameSessionBranch('wb-1', input, { run })).toEqual({ outcome: 'kept', reason: 'too_many_turns' });
  });

  it('runs once per session', async () => {
    const { box, run } = fakeBox();
    expect((await nameSessionBranch('wb-1', input, { run })).outcome).toBe('renamed');
    const calls = run.mock.calls.length;
    expect(await nameSessionBranch('wb-1', { ...input, finalMessage: 'other' }, { run })).toEqual({ outcome: 'not_now', reason: 'decided' });
    expect(run.mock.calls.length).toBe(calls);
    expect(box.renames).toHaveLength(1);
  });

  it('runs once when two turn ends ask at the same moment', async () => {
    const { box, run } = fakeBox();
    const [a, b] = await Promise.all([nameSessionBranch('wb-1', input, { run }), nameSessionBranch('wb-1', input, { run })]);
    expect([a.outcome, b.outcome].sort()).toEqual(['not_now', 'renamed']);
    expect(box.renames).toHaveLength(1);
  });

  describe('the chat whose turn is naming it', () => {
    beforeEach(() => updateChat('chat-1', { status: 'running' }));

    it('is not counted as busy', async () => {
      const { run } = fakeBox();
      expect((await nameSessionBranch('wb-1', { ...input, chatId: 'chat-1' }, { run })).outcome).toBe('renamed');
    });

    it('is busy for every other caller', async () => {
      const { run } = fakeBox();
      expect(await nameSessionBranch('wb-1', input, { run })).toEqual({ outcome: 'not_now', reason: 'turn_running' });
      expect(await nameSessionBranch('wb-1', { ...input, chatId: 'chat-other' }, { run })).toEqual({ outcome: 'not_now', reason: 'turn_running' });
      expect(await namedAt()).toBeNull();
    });

    it('does not hide a second running chat', async () => {
      await insertChat({ id: 'chat-2', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Two', agent: 'claude', status: 'running', turnCount: 1 });
      const { run } = fakeBox();
      expect(await nameSessionBranch('wb-1', { ...input, chatId: 'chat-1' }, { run })).toEqual({ outcome: 'not_now', reason: 'turn_running' });
    });
  });

  describe('a PR title as the suggestion', () => {
    it('names the branch from the title without asking a model', async () => {
      const { box, run } = fakeBox();
      const named = await nameSessionBranch('wb-1', { ...input, suggestion: 'fix(stripe): Fix webhook retry when Stripe returns 409' }, { run });
      expect(named).toEqual({ outcome: 'renamed', branch: 'tom/fix-webhook-retry-stripe-returns-409' });
      expect(box.prompts).toEqual([]);
    });

    it('keeps the name for a title with no usable words', async () => {
      const { box, run } = fakeBox();
      expect(await nameSessionBranch('wb-1', { ...input, suggestion: 'feat: 修复' }, { run })).toEqual({ outcome: 'kept', reason: 'no_suggestion' });
      expect(box.prompts).toEqual([]);
      expect(box.renames).toEqual([]);
    });
  });

  describe('nameBranchBeforePullRequest', () => {
    const titled = { ...input, suggestion: 'Fix the login redirect' };

    it('keeps the name when the deadline passes before the rename starts, and never renames later', async () => {
      setPrBranchNamingDeadlineForTests(20);
      let release!: () => void;
      const { box, run } = fakeBox({ probeHold: new Promise<void>((resolve) => { release = resolve; }) });
      expect(await nameBranchBeforePullRequest('wb-1', titled, { run })).toEqual({ outcome: 'kept', reason: 'timed_out' });
      release();
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(box.renames).toEqual([]);
      expect((await row()).branch).toBe(START);
      expect(await namedAt()).not.toBeNull();
    });

    it('waits for a rename that has already started', async () => {
      setPrBranchNamingDeadlineForTests(20);
      const { box, run } = fakeBox({ onRename: () => new Promise((resolve) => setTimeout(resolve, 100)) });
      expect(await nameBranchBeforePullRequest('wb-1', titled, { run })).toEqual({ outcome: 'renamed', branch: 'tom/fix-login-redirect' });
      expect(box.branch).toBe('tom/fix-login-redirect');
      expect((await row()).branch).toBe('tom/fix-login-redirect');
    });

    it('returns at once when the attempt was already decided', async () => {
      const { run } = fakeBox();
      expect((await nameSessionBranch('wb-1', titled, { run })).outcome).toBe('renamed');
      run.mockClear();
      expect(await nameBranchBeforePullRequest('wb-1', titled, { run })).toEqual({ outcome: 'not_now', reason: 'decided' });
      expect(run).not.toHaveBeenCalled();
    });
  });

  it('starts a new session undecided', async () => {
    expect(await namedAt()).toBeNull();
  });
});
