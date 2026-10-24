import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Workbench } from '@talyn/shared';

const api = vi.hoisted(() => ({
  workbenches: {
    sendMessage: vi.fn(),
    cancel: vi.fn(),
    action: vi.fn(),
    attachmentBlob: vi.fn(),
    uploadAttachment: vi.fn(),
    runScript: vi.fn(),
  },
}));
vi.mock('../lib/api', () => ({ api }));

import { opsFor, sandboxOps } from '../lib/workbenchOps';
import { useWorkbenchStore } from '../stores/workbenches';

function wb(over: Partial<Workbench> = {}): Workbench {
  return {
    id: 'wb1',
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/app',
    name: 'lisbon',
    branch: 'lisbon',
    baseBranch: 'main',
    runtime: 'sandbox',
    agent: 'claude',
    deviceId: null,
    localPath: null,
    sandboxId: 'sb1',
    sandboxState: 'ready',
    status: 'ready',
    pullRequestId: null,
    settings: {},
    diffStat: null,
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  } as Workbench;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sandboxOps', () => {
  it.each([
    ['ready', { status: 'ready' }, null],
    ['provisioning', { status: 'provisioning' }, 'The sandbox is starting.'],
    ['lost', { status: 'provisioning', sandboxState: 'lost', statusMessage: 'The sandbox was lost. Talyn is starting a new one.' }, 'The sandbox was lost. Talyn is starting a new one.'],
    ['error with message', { status: 'error', error: 'clone failed' }, 'clone failed'],
    ['error with status message', { status: 'error', statusMessage: 'no fleet' }, 'no fleet'],
    ['sandbox error with no message', { sandboxState: 'error' }, 'The sandbox failed to start.'],
    ['archived', { status: 'archived' }, 'This session is archived.'],
    ['archivedAt set', { archivedAt: '2026-10-14T00:00:00Z' }, 'This session is archived.'],
  ] as const)('unavailable: %s', (_n, over, expected) => {
    const ops = sandboxOps(wb(over as Partial<Workbench>));
    expect(ops.unavailable).toBe(expected);
    expect(ops.canRemoveQueued).toBe(true);
    expect(ops.canAttach).toBe(true);
  });

  it('sends to the chat and runs actions on the backend', async () => {
    api.workbenches.sendMessage.mockResolvedValue({ queued: false });
    const ops = sandboxOps(wb());
    await expect(ops.send({ id: 'c1' } as never, { text: 'hi' })).resolves.toEqual({ queued: false });
    expect(api.workbenches.sendMessage).toHaveBeenCalledWith('c1', { text: 'hi' });
    await ops.runAction('fix_checks', null);
    expect(api.workbenches.action).toHaveBeenCalledWith('wb1', 'fix_checks', undefined);
    await ops.runAction('resolve_conflicts', { id: 'c2' } as never);
    expect(api.workbenches.action).toHaveBeenCalledWith('wb1', 'resolve_conflicts', 'c2');
  });

  it('marks a script started before asking the backend to run it', async () => {
    await sandboxOps(wb()).runScript('run');
    expect(useWorkbenchStore.getState().scriptOutput.wb1?.run).toEqual({ chunks: [], total: 0, running: true, exitCode: null });
    expect(api.workbenches.runScript).toHaveBeenCalledWith('wb1', 'run');
  });

  it('uploads a pasted file as a Blob with its type', async () => {
    api.workbenches.uploadAttachment.mockResolvedValue({ name: 'a.png', mimeType: 'image/png', path: 'p' });
    await sandboxOps(wb()).attach({ name: 'a.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=' });
    const [id, blob, name] = api.workbenches.uploadAttachment.mock.calls[0];
    expect(id).toBe('wb1');
    expect(name).toBe('a.png');
    expect((blob as Blob).type).toBe('image/png');
    expect((blob as Blob).size).toBe(5);
  });
});

describe('opsFor', () => {
  it('gives a sandbox session the sandbox ops', () => {
    expect(opsFor(wb()).runtime).toBe('sandbox');
    expect(opsFor(wb()).unavailable).toBeNull();
  });

  it('refuses every call on a local session made in the desktop app', async () => {
    const ops = opsFor(wb({ runtime: 'local', localPath: '/work/lisbon' }));
    expect(ops.runtime).toBe('local');
    expect(ops.unavailable).toMatch(/desktop app/);
    expect(ops.canAttach).toBe(false);
    expect(ops.canRemoveQueued).toBe(false);
    await expect(ops.send({ id: 'c1' } as never, { text: 'hi' })).rejects.toThrow(/desktop app/);
    await expect(ops.changes()).rejects.toThrow(/desktop app/);
    await expect(ops.runScript('run')).rejects.toThrow(/desktop app/);
    expect(api.workbenches.sendMessage).not.toHaveBeenCalled();
  });
});
