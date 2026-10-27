import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getChanges, getPatch, refreshDiffStat } from '../services/workbenches/changes.js';
import { emitWorkbenchUpdated } from '../services/workbenches/emit.js';
import { runCapture, fleetClientFor } from '../services/workbenches/sandboxRuntime.js';
import { updateWorkbench, type WorkbenchRow } from '../services/workbenches/store.js';

vi.mock('../services/workbenches/sandboxRuntime.js', () => ({
  runCapture: vi.fn(), fleetClientFor: vi.fn(), repoDirFor: () => '/work/repo', MERGE_BASE_DEEPEN_BY: 100,
}));
vi.mock('../services/workbenches/store.js', () => ({ updateWorkbench: vi.fn() }));
vi.mock('../services/workbenches/emit.js', () => ({ emitWorkbenchUpdated: vi.fn() }));
vi.mock('../services/workbenches/prLink.js', () => ({ publicWorkbench: async (row: WorkbenchRow) => row }));
vi.mock('../services/workbenches/recovery.js', () => ({ withLostRecovery: (_row: unknown, fn: () => unknown) => fn() }));

const row = { id: 'w1', workspaceId: 'ws1', runtime: 'sandbox', sandboxId: 's1', baseBranch: 'main', diffStat: null } as WorkbenchRow;
const empty = { files: 0, added: 0, removed: 0 };
const sections = {
  MB: 'base', HEAD: 'head\n',
  NUMSTAT: '8\t3\tboth.ts\0-\t-\timage.png\0', NAMES: 'M\0both.ts\0A\0image.png\0',
  UNCOMMITTED_NUMSTAT: '2\t1\tboth.ts\0', UNCOMMITTED_NAMES: 'M\0both.ts\0',
  COMMITTED_NUMSTAT: '10\t4\tboth.ts\0-\t-\timage.png\0', COMMITTED_NAMES: 'M\0both.ts\0A\0image.png\0',
  UNTRACKED: 'new.txt\0', COUNTS: 'new.txt\t3\n',
};

function reply(values: Record<string, string> = sections, exitCode = 0) {
  const stdout = Object.entries(values).map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`).join('\n');
  vi.mocked(runCapture).mockResolvedValue({ stdout, stdoutBytes: Buffer.from(stdout), stderr: 'failure', exitCode });
}

beforeEach(() => {
  vi.clearAllMocks();
  reply();
  vi.mocked(updateWorkbench).mockImplementation(async (_id, patch) => ({ ...row, ...patch }) as WorkbenchRow);
});

describe('split changes', () => {
  it('returns both scopes and the old combined list in one exec', async () => {
    const result = await getChanges(row);
    expect(result.base).toBe('base');
    expect(result.headSha).toBe('head');
    expect(result.files.find((f) => f.path === 'both.ts')).toMatchObject({ added: 8, removed: 3 });
    expect(result.uncommitted).toEqual([
      { path: 'both.ts', status: 'modified', added: 2, removed: 1, binary: false },
      { path: 'new.txt', status: 'added', added: 3, removed: 0, binary: false },
    ]);
    expect(result.committed).toEqual([
      { path: 'both.ts', status: 'modified', added: 10, removed: 4, binary: false },
      { path: 'image.png', status: 'added', added: 0, removed: 0, binary: true },
    ]);
    expect(result.uncommittedStats).toEqual({ files: 2, added: 5, removed: 1 });
    expect(result.committedStats).toEqual({ files: 2, added: 10, removed: 4 });
    expect(runCapture).toHaveBeenCalledTimes(1);
    expect(fleetClientFor).not.toHaveBeenCalled();
    const script = vi.mocked(runCapture).mock.calls[0][1];
    expect(script).toContain('--find-renames "$head" --');
    expect(script).toContain('--find-renames "$mb" "$head" --');
    expect(script).toContain('git ls-files --others --exclude-standard -z');
  });

  it.each(['UNCOMMITTED', 'COMMITTED'] as const)('allows an empty %s group', async (scope) => {
    reply({ ...sections, [`${scope}_NUMSTAT`]: '', [`${scope}_NAMES`]: '', UNTRACKED: '', COUNTS: '' });
    const result = await getChanges(row);
    expect(scope === 'UNCOMMITTED' ? result.uncommittedStats : result.committedStats).toEqual(empty);
  });

  it('preserves rename and delete statuses in each scope', async () => {
    const numstat = '0\t0\t\0old.ts\0new.ts\0' + '0\t2\tdeleted.ts\0';
    const names = 'R100\0old.ts\0new.ts\0D\0deleted.ts\0';
    reply({ ...sections, UNCOMMITTED_NUMSTAT: numstat, UNCOMMITTED_NAMES: names, COMMITTED_NUMSTAT: numstat, COMMITTED_NAMES: names, UNTRACKED: '' });
    const result = await getChanges(row);
    expect(result.uncommitted).toEqual(result.committed);
    expect(result.uncommitted).toEqual([
      { path: 'deleted.ts', status: 'deleted', added: 0, removed: 2, binary: false },
      { path: 'new.ts', oldPath: 'old.ts', status: 'renamed', added: 0, removed: 0, binary: false },
    ]);
  });

  it('does not return empty changes after an exec failure', async () => {
    reply({}, 128);
    await expect(getChanges(row)).rejects.toThrow('git diff failed');
  });

  it('stores and broadcasts uncommitted totals under the legacy name', async () => {
    const result = await refreshDiffStat(row);
    expect(result.diffStat).toEqual({
      files: 2, added: 5, removed: 1,
      uncommittedStats: { files: 2, added: 5, removed: 1 },
      committedStats: { files: 2, added: 10, removed: 4 },
    });
    expect(emitWorkbenchUpdated).toHaveBeenCalledWith(result);
    vi.mocked(updateWorkbench).mockClear();
    vi.mocked(emitWorkbenchUpdated).mockClear();
    await refreshDiffStat(result);
    expect(updateWorkbench).not.toHaveBeenCalled();
    expect(emitWorkbenchUpdated).not.toHaveBeenCalled();
    reply({ ...sections, COMMITTED_NUMSTAT: '11\t4\tboth.ts\0' });
    await refreshDiffStat(result);
    expect(updateWorkbench).toHaveBeenCalledTimes(1);
  });

  it('clears the legacy totals when only committed changes remain', async () => {
    reply({ ...sections, UNCOMMITTED_NUMSTAT: '', UNCOMMITTED_NAMES: '', UNTRACKED: '' });
    expect((await refreshDiffStat(row)).diffStat).toMatchObject({ ...empty, uncommittedStats: empty });
  });
});

describe('scoped patches', () => {
  it.each(['uncommitted', 'committed'] as const)('requests the %s comparison', async (scope) => {
    await getPatch(row, 'both.ts', scope);
    const script = vi.mocked(runCapture).mock.calls[0][1];
    expect(script).toContain(`--find-renames ${scope === 'uncommitted' ? 'HEAD' : '"$mb" HEAD'} -- both.ts`);
    expect(script.includes('--no-index')).toBe(scope === 'uncommitted');
    expect(fleetClientFor).not.toHaveBeenCalled();
  });
});
