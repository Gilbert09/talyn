/**
 * @jest-environment jsdom
 */
import type { Workbench, WorkbenchLocalBridge } from '@talyn/shared';
import { localOps, sandboxOps } from '../renderer/lib/workbenchOps';
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

describe('sandboxOps', () => {
  it.each([
    ['ready', { status: 'ready' }, null],
    ['provisioning', { status: 'provisioning' }, 'The sandbox is starting.'],
    ['error with message', { status: 'error', error: 'clone failed' }, 'clone failed'],
    ['error with status message', { status: 'error', statusMessage: 'no fleet' }, 'no fleet'],
    ['archived', { status: 'archived' }, 'This workbench is archived.'],
  ] as const)('unavailable: %s', (_n, over, expected) => {
    const ops = sandboxOps(wb({ runtime: 'sandbox', ...over } as Partial<Workbench>));
    expect(ops.unavailable).toBe(expected);
    expect(ops.canRemoveQueued).toBe(true);
  });
});
