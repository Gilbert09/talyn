import { afterEach, describe, expect, it, vi } from 'vitest';
import { initWorkbenches, stopWorkbenches } from '../services/workbenches/lifecycle.js';
import { initWorkbenchMaintenance } from '../services/workbenches/maintenance.js';
import { resetWorkbenchDrainForTests } from '../services/workbenches/ownership.js';
import { backfillCredentialArchives } from '../services/workbenches/store.js';

vi.mock('../services/workbenches/maintenance.js', () => ({
  initWorkbenchMaintenance: vi.fn(), stopWorkbenchMaintenance: vi.fn(),
}));
vi.mock('../services/workbenches/store.js', async (original) => ({
  ...(await original<typeof import('../services/workbenches/store.js')>()),
  backfillCredentialArchives: vi.fn(async () => 0), provisioningWorkbenchIds: vi.fn(async () => []),
}));
vi.mock('../services/workbenches/turns.js', async (original) => ({
  ...(await original<typeof import('../services/workbenches/turns.js')>()), sweepOrphanedTurns: vi.fn(async () => 0),
}));
vi.mock('../services/workbenches/scripts.js', async (original) => ({
  ...(await original<typeof import('../services/workbenches/scripts.js')>()), sweepScripts: vi.fn(async () => undefined),
}));
vi.mock('../services/workbenches/agentBackups.js', async (original) => ({
  ...(await original<typeof import('../services/workbenches/agentBackups.js')>()), sweepAgentBackups: vi.fn(async () => undefined),
}));
vi.mock('../services/workbenches/move.js', async (original) => ({
  ...(await original<typeof import('../services/workbenches/move.js')>()), sweepAbandonedMoves: vi.fn(async () => 0),
}));

afterEach(() => {
  stopWorkbenches();
  resetWorkbenchDrainForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('archive credential repair at boot', () => {
  it('repairs archives once before starting the sandbox reaper', async () => {
    vi.useFakeTimers();
    let finishRepair!: (count: number) => void;
    vi.mocked(backfillCredentialArchives).mockReturnValueOnce(new Promise((resolve) => { finishRepair = resolve; }));
    initWorkbenches(1);
    initWorkbenches(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(backfillCredentialArchives).toHaveBeenCalledTimes(1);
    expect(initWorkbenchMaintenance).not.toHaveBeenCalled();
    finishRepair(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(initWorkbenchMaintenance).toHaveBeenCalledTimes(1);
    initWorkbenches(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(backfillCredentialArchives).toHaveBeenCalledTimes(1);
  });
});
