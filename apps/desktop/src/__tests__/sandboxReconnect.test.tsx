/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Workbench, WorkbenchChanges, WorkbenchChat } from '@talyn/shared';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';
import {
  RECONNECT_DELAYS_MS,
  RECONNECTING_TEXT,
  isTransientSandboxError,
  readWithReconnect,
} from '../renderer/lib/sandboxReconnect';
import { ChangesTab, CHANGES_REFRESH_MS } from '../renderer/components/workbench/ChangesTab';
import { FilesTab } from '../renderer/components/workbench/FilesTab';
import { useWorkbenchStore } from '../renderer/stores/workbenches';


jest.mock('../renderer/stores/toast', () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock('../renderer/lib/fileIconUrl', () => ({ loadFileIconUrl: async () => null }));
jest.mock('../renderer/components/workbench/CodeViewer', () => ({ __esModule: true, default: () => null }));

const UNREACHABLE = 'The sandbox runners are not reachable right now. Try again shortly.';
const BUSY = 'The sandbox runners are all busy. Try again shortly.';

function coded(message: string, code?: string): Error {
  return Object.assign(new Error(message), { name: 'ApiError', status: 503, code });
}

const WB = { id: 'wb1', runtime: 'sandbox', status: 'ready', pr: null, baseBranch: 'main' } as unknown as Workbench;
const data = (): WorkbenchChanges => ({
  base: 'b',
  headSha: 'h',
  files: [{ path: 'a.ts', status: 'modified', added: 1, removed: 0, binary: false }],
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.clearAllMocks();
});

const tick = (ms: number) =>
  act(async () => {
    jest.advanceTimersByTime(ms);
  });

describe('isTransientSandboxError', () => {
  it.each<[string, unknown, boolean]>([
    ['the unreachable message', new Error(UNREACHABLE), true],
    ['the busy message', new Error(BUSY), true],
    ['fleet_unavailable', coded('Anything', 'fleet_unavailable'), true],
    ['sandbox_waking', coded('Waking', 'sandbox_waking'), true],
    ['another code', coded('Nope', 'sandbox_gone'), false],
    ['another message', new Error('Not found'), false],
    ['not an error', 'text', false],
    ['null', null, false],
  ])('%s', (_name, err, expected) => {
    expect(isTransientSandboxError(err)).toBe(expected);
  });
});

describe('readWithReconnect', () => {
  it('backs off 2, 4, 8 and 16 seconds, then gives the last error', async () => {
    jest.useFakeTimers();
    expect(RECONNECT_DELAYS_MS).toEqual([2000, 4000, 8000, 16000]);
    const read = jest.fn(async () => {
      throw new Error(UNREACHABLE);
    });
    const flags: boolean[] = [];
    const result = readWithReconnect(read, { onReconnecting: (r) => flags.push(r) });
    const settled = result.catch((e: Error) => e.message);
    for (const ms of RECONNECT_DELAYS_MS) {
      await tick(0);
      await tick(ms - 1);
      const before = read.mock.calls.length;
      await tick(1);
      expect(read.mock.calls.length).toBe(before + 1);
    }
    expect(read).toHaveBeenCalledTimes(5);
    expect(await settled).toBe(UNREACHABLE);
    expect(flags[0]).toBe(true);
    expect(flags[flags.length - 1]).toBe(false);
  });

  it('does not retry another error', async () => {
    const read = jest.fn(async () => {
      throw new Error('Not found');
    });
    await expect(readWithReconnect(read)).rejects.toThrow('Not found');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('stops quietly when cancelled', async () => {
    jest.useFakeTimers();
    let cancelled = false;
    const read = jest.fn(async () => {
      throw new Error(BUSY);
    });
    const settled = readWithReconnect(read, { isCancelled: () => cancelled }).catch((e: Error) => e.message);
    await tick(0);
    cancelled = true;
    await tick(2000);
    expect(await settled).toBe(BUSY);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('Changes panel reconnect', () => {
  const renderTab = (ops: WorkbenchOps) =>
    render(<ChangesTab workbench={WB} chat={null} ops={ops} visible turnsEnded={0} comments={[]} setComments={() => {}} />);
  // The list polls only while a turn runs.
  beforeEach(() => useWorkbenchStore.setState({ chats: { [WB.id]: [{ id: 'c1', workbenchId: WB.id, status: 'running' } as WorkbenchChat] } }));
  afterEach(() => useWorkbenchStore.setState({ chats: {} }));

  it('keeps the old list, shows the muted line and recovers', async () => {
    jest.useFakeTimers();
    const changes = jest.fn()
      .mockResolvedValueOnce(data())
      .mockRejectedValueOnce(new Error(UNREACHABLE))
      .mockResolvedValue(data());
    renderTab({ runtime: 'sandbox', unavailable: null, changes } as unknown as WorkbenchOps);
    await tick(0);
    expect(screen.getByText('a.ts')).toBeInTheDocument();
    await tick(CHANGES_REFRESH_MS);
    expect(screen.getByTestId('sandbox-reconnecting')).toHaveTextContent(RECONNECTING_TEXT);
    expect(screen.getByText('a.ts')).toBeInTheDocument();
    expect(screen.queryByText(UNREACHABLE)).not.toBeInTheDocument();
    await tick(2000);
    expect(screen.queryByTestId('sandbox-reconnecting')).not.toBeInTheDocument();
    expect(screen.queryByText(UNREACHABLE)).not.toBeInTheDocument();
    expect(screen.getByText('a.ts')).toBeInTheDocument();
  });

  it('shows the real error once the retries run out', async () => {
    jest.useFakeTimers();
    const changes = jest.fn().mockRejectedValue(coded(BUSY, 'fleet_unavailable'));
    renderTab({ runtime: 'sandbox', unavailable: null, changes } as unknown as WorkbenchOps);
    await tick(0);
    expect(screen.getByTestId('sandbox-reconnecting')).toBeInTheDocument();
    for (const ms of RECONNECT_DELAYS_MS) await tick(ms);
    expect(screen.queryByTestId('sandbox-reconnecting')).not.toBeInTheDocument();
    expect(screen.getByText(BUSY)).toBeInTheDocument();
  });

  it('shows another error at once, without the reconnect line', async () => {
    jest.useFakeTimers();
    const changes = jest.fn().mockRejectedValue(new Error('Sandbox is gone'));
    renderTab({ runtime: 'sandbox', unavailable: null, changes } as unknown as WorkbenchOps);
    await tick(0);
    expect(screen.getByText('Sandbox is gone')).toBeInTheDocument();
    expect(screen.queryByTestId('sandbox-reconnecting')).not.toBeInTheDocument();
    expect(changes).toHaveBeenCalledTimes(1);
  });
});

describe('Files panel reconnect', () => {
  it('shows the muted line, then the list', async () => {
    jest.useFakeTimers();
    const files = jest.fn().mockRejectedValueOnce(new Error(UNREACHABLE)).mockResolvedValue({ paths: ['src/app.ts'] });
    render(<FilesTab workbench={WB} ops={{ runtime: 'sandbox', unavailable: null, files } as unknown as WorkbenchOps} visible />);
    await tick(0);
    expect(screen.getByTestId('sandbox-reconnecting')).toBeInTheDocument();
    expect(screen.queryByText(UNREACHABLE)).not.toBeInTheDocument();
    await tick(2000);
    expect(screen.queryByTestId('sandbox-reconnecting')).not.toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
  });

  it('shows another error as before', async () => {
    jest.useFakeTimers();
    const files = jest.fn().mockRejectedValue(new Error('Boom'));
    render(<FilesTab workbench={WB} ops={{ runtime: 'sandbox', unavailable: null, files } as unknown as WorkbenchOps} visible />);
    await tick(0);
    expect(screen.getByText('Boom')).toBeInTheDocument();
  });
});
