/** @jest-environment node */
import type { GitStep, WorkbenchExecResult } from '@talyn/shared';
import { renameWorktreeBranch, type GitRunner } from '../branchRename';
import * as environment from '../environment';
import { suggestWorkbenchBranchName, type TitleRunner } from '../title';

interface Worktree {
  head?: string;
  headExit?: number;
  upstream?: string;
  renameExit?: number;
}

/** A worktree that answers the HEAD probe, the upstream probe and `git branch -m`. */
function fakeGit(tree: Worktree = {}) {
  const calls: string[][] = [];
  const run = jest.fn<Promise<WorkbenchExecResult>, Parameters<GitRunner>>(async (_cwd: string, steps: GitStep[]) => {
    const argv = steps[0].argv;
    calls.push(argv);
    if (argv.includes('@{u}')) {
      return tree.upstream ? { exitCode: 0, stdout: `${tree.upstream}\n`, stderr: '' } : { exitCode: 128, stdout: '', stderr: 'no upstream' };
    }
    if (argv.includes('--abbrev-ref')) return { exitCode: tree.headExit ?? 0, stdout: `${tree.head ?? 'tom/look-login'}\n`, stderr: '' };
    if (argv[1] === 'branch') return { exitCode: tree.renameExit ?? 0, stdout: '', stderr: '' };
    throw new Error(`unexpected git call: ${argv.join(' ')}`);
  });
  return { run, calls };
}

const input = { path: '/work/look-login', from: 'tom/look-login', to: 'tom/fix-login-redirect' };
const renames = (calls: string[][]) => calls.filter((argv) => argv[1] === 'branch');

describe('renameWorktreeBranch', () => {
  it('renames the current branch of the worktree when it has no upstream', async () => {
    const { run, calls } = fakeGit();
    expect(await renameWorktreeBranch(input, run)).toEqual({ ok: true });
    expect(renames(calls)).toEqual([['git', 'branch', '-m', 'tom/look-login', 'tom/fix-login-redirect']]);
    expect(run.mock.calls.every(([cwd]) => cwd === '/work/look-login')).toBe(true);
  });

  it.each([
    ['another branch is checked out', { head: 'main' }, 'not_current'],
    ['HEAD is detached', { head: 'HEAD' }, 'not_current'],
    ['the branch has an upstream', { upstream: 'origin/tom/look-login' }, 'has_upstream'],
    ['git cannot read HEAD', { headExit: 128 }, 'probe_failed'],
    ['git refuses the rename', { renameExit: 128 }, 'rename_failed'],
  ])('refuses when %s', async (_name, tree, reason) => {
    const { run, calls } = fakeGit(tree as Worktree);
    expect(await renameWorktreeBranch(input, run)).toEqual({ ok: false, reason });
    if (reason !== 'rename_failed') expect(renames(calls)).toEqual([]);
  });

  it.each([
    ['an invalid target', { ...input, to: 'bad name' }, 'invalid_name'],
    ['an option for a source', { ...input, from: '-D' }, 'invalid_name'],
    ['the same name', { ...input, to: input.from }, 'same_name'],
  ])('refuses %s without running git', async (_name, args, reason) => {
    const { run } = fakeGit();
    expect(await renameWorktreeBranch(args, run)).toEqual({ ok: false, reason });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('suggestWorkbenchBranchName', () => {
  beforeEach(() => {
    jest.spyOn(environment, 'processEnv').mockResolvedValue({ ...process.env });
  });
  afterEach(() => jest.restoreAllMocks());

  const runner =
    (result: Partial<Awaited<ReturnType<TitleRunner>>>): TitleRunner =>
    async () => ({ exitCode: 0, stdout: '', timedOut: false, ...result });
  const work = { message: 'look at the login page', changedFiles: ['src/auth/redirect.ts'], finalMessage: 'I fixed the redirect loop.' };

  it('asks the cheap model with the request, the files and the summary, and returns the raw answer', async () => {
    const run = jest.fn(runner({ stdout: 'fix-login-redirect\n' }));
    expect(await suggestWorkbenchBranchName({ agent: 'claude', ...work }, run, 1000)).toBe('fix-login-redirect');
    const [argv, timeoutMs] = run.mock.calls[0];
    expect(argv.slice(0, 6)).toEqual(['claude', '-p', '--output-format', 'text', '--model', 'haiku']);
    const prompt = argv[argv.length - 1];
    expect(prompt).toContain('look at the login page');
    expect(prompt).toContain('src/auth/redirect.ts');
    expect(prompt).toContain('I fixed the redirect loop.');
    expect(timeoutMs).toBe(1000);
  });

  it.each([
    ['a timeout', runner({ timedOut: true, exitCode: null, stdout: 'fix-lo' })],
    ['a non-zero exit', runner({ exitCode: 1, stdout: 'fix-login' })],
    ['empty output', runner({ stdout: '  \n' })],
    ['an essay', runner({ stdout: 'x'.repeat(500) })],
    ['a runner that throws', async () => { throw new Error('spawn ENOENT'); }],
  ])('answers null on %s', async (_name, run) => {
    expect(await suggestWorkbenchBranchName({ agent: 'claude', ...work }, run as TitleRunner)).toBeNull();
  });

  it('asks nothing for an unknown agent', async () => {
    const run = jest.fn(runner({ stdout: 'x' }));
    expect(await suggestWorkbenchBranchName({ agent: 'gemini' as 'claude', ...work }, run)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
