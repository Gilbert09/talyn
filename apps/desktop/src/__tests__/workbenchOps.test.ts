/**
 * @jest-environment jsdom
 */
import type { Workbench, WorkbenchLocalBridge } from '@talyn/shared';
import { localOps, sandboxOps } from '../renderer/lib/workbenchOps';
import { openLocalPullRequest } from '../renderer/lib/localPullRequest';
import { getDeviceId, resetDeviceIdCache } from '../renderer/lib/workbenchBridge';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));

type Step = { argv: string[]; env?: Record<string, string> };
type Responder = (steps: Step[]) => { exitCode: number; stdout: string; stderr?: string } | undefined;

function bridgeWith(respond: Responder) {
  const exec = jest.fn(async (_path: string, steps: Step[]) => {
    const res = respond(steps) ?? { exitCode: 0, stdout: '' };
    return { stderr: '', ...res };
  });
  return { bridge: { exec, readFile: jest.fn(), scripts: { run: jest.fn() } } as unknown as WorkbenchLocalBridge, exec };
}

const has = (steps: Step[], ...words: string[]) => steps.some((s) => words.every((w) => s.argv.includes(w)));

function wb(over: Partial<Workbench> = {}): Workbench {
  return {
    id: 'wb1',
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/app',
    name: 'lisbon',
    branch: 'lisbon',
    baseBranch: 'main',
    runtime: 'local',
    agent: 'claude',
    deviceId: getDeviceId(),
    localPath: '/work/lisbon',
    sandboxId: null,
    sandboxState: 'none',
    status: 'ready',
    pullRequestId: null,
    settings: {},
    diffStat: null,
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetDeviceIdCache();
});

describe('localOps', () => {
  it.each([
    ['no bridge', null, {}, /desktop app/],
    ['another device', 'bridge', { deviceId: 'someone-else' }, /another computer/],
    ['no path', 'bridge', { localPath: null }, /no local path/],
    ['this device', 'bridge', {}, null],
  ] as const)('unavailable: %s', (_n, bridgeKind, over, expected) => {
    const { bridge } = bridgeWith(() => undefined);
    const ops = localOps(wb(over), bridgeKind ? bridge : null, null);
    if (expected) expect(ops.unavailable).toMatch(expected);
    else expect(ops.unavailable).toBeNull();
  });

  it('computes changes against the merge-base with origin, untracked files included', async () => {
    const { bridge } = bridgeWith((steps) => {
      if (has(steps, 'merge-base', 'origin/main')) return { exitCode: 0, stdout: 'abc123\n' };
      if (has(steps, '--numstat')) return { exitCode: 0, stdout: '3\t1\tsrc/a.ts\0' };
      if (has(steps, '--name-status')) return { exitCode: 0, stdout: 'M\0src/a.ts\0' };
      if (has(steps, 'ls-files', '--others')) return { exitCode: 0, stdout: 'new.txt\0' };
      if (has(steps, 'rev-parse', 'HEAD')) return { exitCode: 0, stdout: 'def456\n' };
      return undefined;
    });
    const changes = await localOps(wb(), bridge, null).changes();
    expect(changes.base).toBe('abc123');
    expect(changes.headSha).toBe('def456');
    expect(changes.files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ['new.txt', 'added', 0, 0],
      ['src/a.ts', 'modified', 3, 1],
    ]);
  });

  it('falls back to the local base branch when there is no origin ref', async () => {
    const { bridge, exec } = bridgeWith((steps) => {
      if (has(steps, 'merge-base', 'origin/main')) return { exitCode: 128, stdout: '' };
      if (has(steps, 'merge-base', 'main')) return { exitCode: 0, stdout: 'local1\n' };
      return undefined;
    });
    await localOps(wb(), bridge, null).changes();
    const diffCall = exec.mock.calls.find((c) => has(c[1], '--numstat'));
    expect(diffCall?.[1][0].argv).toContain('local1');
  });

  it('shows an untracked file as an addition when git diff has nothing', async () => {
    const { bridge } = bridgeWith((steps) => {
      if (has(steps, 'merge-base')) return { exitCode: 0, stdout: 'abc\n' };
      if (has(steps, '--no-index')) return { exitCode: 1, stdout: '+++ b/new.txt\n+hi\n' };
      if (has(steps, 'diff')) return { exitCode: 0, stdout: '' };
      return undefined;
    });
    expect(await localOps(wb(), bridge, null).diff('new.txt')).toContain('+hi');
  });

  it('restores the checkpoint taken before the given turn', async () => {
    const { bridge, exec } = bridgeWith((steps) => {
      if (has(steps, 'for-each-ref')) {
        return {
          exitCode: 0,
          stdout: 'aaa1111 refs/talyn/checkpoints/c1/1\nbbb2222 refs/talyn/checkpoints/c1/2\n',
        };
      }
      if (has(steps, '--absolute-git-dir')) return { exitCode: 0, stdout: '/work/repo/.git\n' };
      return undefined;
    });
    await localOps(wb(), bridge, null).restoreCheckpoint('c1', 2);
    const restore = exec.mock.calls.find((c) => has(c[1], 'read-tree'));
    expect(restore?.[1][0].argv).toEqual(['git', 'read-tree', 'bbb2222']);
    expect(restore?.[1][0].env).toEqual({ GIT_INDEX_FILE: '/work/repo/.git/talyn-restore-index' });
  });

  it('refuses a restore when no checkpoint exists for the turn', async () => {
    const { bridge } = bridgeWith((steps) => (has(steps, 'for-each-ref') ? { exitCode: 0, stdout: '' } : undefined));
    await expect(localOps(wb(), bridge, null).restoreCheckpoint('c1', 3)).rejects.toThrow(/No checkpoint/);
  });

  it('writes a pasted image under .context/attachments without a shell string', async () => {
    const { bridge, exec } = bridgeWith(() => undefined);
    const attachment = await localOps(wb(), bridge, null).attach({
      name: 'my shot (1).png',
      mimeType: 'image/png',
      dataBase64: 'aGVsbG8=',
    });
    expect(attachment.path).toMatch(/^\.context\/attachments\/\d+-my-shot-1-.png$/);
    const argv = exec.mock.calls[0][1][0].argv;
    expect(argv.slice(0, 2)).toEqual(['sh', '-c']);
    expect(argv.slice(-2)).toEqual(['aGVsbG8=', attachment.path]);
  });
});

describe('openLocalPullRequest', () => {
  const input = { title: 'feat: add it', body: 'Body', base: 'main', draft: false, commitMessage: 'feat: the change' };
  const result = { workbench: wb(), pullRequest: { number: 9, url: 'u' }, existing: false };

  function gitBridge(over: { status?: string; statusExit?: number; ahead?: string; push?: { exitCode: number; stderr: string } } = {}) {
    return bridgeWith((steps) => {
      if (has(steps, 'status', '--porcelain')) {
        return { exitCode: over.statusExit ?? 0, stdout: over.status ?? '', stderr: over.statusExit ? 'fatal: not a git repository' : '' };
      }
      if (has(steps, 'rev-list', '--count')) return { exitCode: 0, stdout: over.ahead ?? '2\n' };
      if (has(steps, 'push', '-u', 'origin', 'HEAD')) return { stdout: '', ...(over.push ?? { exitCode: 0, stderr: '' }) };
      return undefined;
    });
  }

  const fakeApi = () => ({ createPullRequest: jest.fn(async () => result as never) });

  it.each([
    ['dirty: commits with the agent’s message, as one argv element', ' M a.ts\n', input, ['git', 'commit', '-m', 'feat: the change']],
    ['dirty, no message: commits with the title', '?? b.ts\n', { ...input, commitMessage: '' }, ['git', 'commit', '-m', 'feat: add it']],
    ['a message with shell syntax stays one argument', ' M a.ts\n', { ...input, commitMessage: 'fix: $(rm -rf /) `x`' }, ['git', 'commit', '-m', 'fix: $(rm -rf /) `x`']],
    ['clean: no commit', '', input, null],
  ] as const)('%s, then pushes and asks the backend to open the PR', async (_n, status, given, commitArgv) => {
    const { bridge, exec } = gitBridge({ status });
    const api = fakeApi();
    await expect(openLocalPullRequest(bridge, api, wb(), given)).resolves.toBe(result);
    const argvs = exec.mock.calls.flatMap((c) => c[1].map((s: Step) => s.argv));
    const commit = argvs.find((a) => a[1] === 'commit');
    if (commitArgv) expect(commit).toEqual(commitArgv);
    else expect(commit).toBeUndefined();
    expect(argvs).toContainEqual(['git', 'push', '-u', 'origin', 'HEAD']);
    expect(api.createPullRequest).toHaveBeenCalledWith('wb1', { ...given, pushed: true });
  });

  it('refuses when the branch has no commits ahead of the base', async () => {
    const { bridge } = gitBridge({ ahead: '0\n' });
    const api = fakeApi();
    await expect(openLocalPullRequest(bridge, api, wb(), input)).rejects.toThrow(
      'There is nothing to open a pull request for: the branch has no commits ahead of main.',
    );
    expect(api.createPullRequest).not.toHaveBeenCalled();
  });

  it('says what git said when the push is refused, and opens nothing', async () => {
    const { bridge } = gitBridge({
      push: { exitCode: 128, stderr: 'remote: Permission to acme/app.git denied to tom.\nfatal: unable to access: The requested URL returned error: 403' },
    });
    const api = fakeApi();
    const err = await openLocalPullRequest(bridge, api, wb(), input).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^GitHub refused the push\. Check that your git credentials can write to acme\/app\./);
    expect((err as Error).message).toContain('error: 403');
    expect(api.createPullRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['git status fails', { statusExit: 128 }, /^Could not read the git status\.\nfatal: not a git repository/],
  ])('stops when %s', async (_n, over, expected) => {
    const { bridge } = gitBridge(over);
    const api = fakeApi();
    await expect(openLocalPullRequest(bridge, api, wb(), input)).rejects.toThrow(expected);
    expect(api.createPullRequest).not.toHaveBeenCalled();
  });

  it('refuses a session with no local path', async () => {
    const { bridge, exec } = gitBridge();
    await expect(openLocalPullRequest(bridge, fakeApi(), wb({ localPath: null }), input)).rejects.toThrow('This session has no local path.');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('sandboxOps', () => {
  it.each([
    ['ready', { status: 'ready' }, null],
    ['provisioning', { status: 'provisioning' }, 'The sandbox is starting.'],
    ['error with message', { status: 'error', error: 'clone failed' }, 'clone failed'],
    ['error with status message', { status: 'error', statusMessage: 'no fleet' }, 'no fleet'],
    ['archived', { status: 'archived' }, 'This session is archived.'],
  ] as const)('unavailable: %s', (_n, over, expected) => {
    const ops = sandboxOps(wb({ runtime: 'sandbox', ...over } as Partial<Workbench>));
    expect(ops.unavailable).toBe(expected);
    expect(ops.canRemoveQueued).toBe(true);
  });
});
