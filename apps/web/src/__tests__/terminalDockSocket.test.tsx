import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workbench } from '@talyn/shared';
import { ShellTerminal } from '../components/workbench/terminal/ShellTerminal';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  input: null as ((data: string) => void) | null,
  resize: null as ((cols: number, rows: number) => void) | null,
  term: { write: vi.fn(), writeln: vi.fn(), focus: vi.fn(), onData: vi.fn(), reset: vi.fn() },
  dispose: vi.fn(),
}));
vi.mock('../lib/api', () => ({
  api: {
    workbenches: {
      terminalAuthFrame: mocks.auth,
      terminalUrl: (id: string) => `wss://example.test/workbenches/${id}/terminal`,
    },
  },
}));
vi.mock('../components/workbench/terminal/useXterm', () => ({
  useXterm: ({ onResize }: { onResize: (cols: number, rows: number) => void }) => {
    mocks.resize = onResize;
    return { ref: { current: null }, term: mocks.term };
  },
}));

class Socket {
  static OPEN = 1;
  static sockets: Socket[] = [];
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(public url: string) {
    Socket.sockets.push(this);
  }
  open() {
    this.readyState = Socket.OPEN;
    this.onopen?.();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  Socket.sockets = [];
  mocks.auth.mockResolvedValue('{"type":"auth","token":"test-token"}');
  mocks.term.onData.mockImplementation((handler: (data: string) => void) => {
    mocks.input = handler;
    return { dispose: mocks.dispose };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    render(<ShellTerminal workbench={{ id: 'wb1', runtime: 'sandbox' } as Workbench} active />);
  });
  return Socket.sockets[0];
}

describe('sandbox terminal', () => {
  it('sends authentication first, then resize and binary input', async () => {
    const socket = await mount();
    mocks.resize?.(80, 24);
    expect(socket.send).not.toHaveBeenCalled();
    socket.open();
    mocks.input?.('ls\r');
    expect(socket.url).toBe('wss://example.test/workbenches/wb1/terminal?session=main');
    expect(socket.binaryType).toBe('arraybuffer');
    expect(socket.send.mock.calls[0][0]).toBe('{"type":"auth","token":"test-token"}');
    expect(JSON.parse(socket.send.mock.calls[1][0])).toEqual({ type: 'resize', cols: 80, rows: 24 });
    expect(socket.send.mock.calls[2][0]).toEqual(new TextEncoder().encode('ls\r'));
    const output = new Uint8Array([65, 66]).buffer;
    socket.onmessage?.({ data: output });
    expect(mocks.term.write).toHaveBeenCalledWith(new Uint8Array(output));
  });

  it('reconnects after a temporary disconnect and stops on unmount', async () => {
    const socket = await mount();
    socket.open();
    socket.onclose?.({ code: 1006, reason: '' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(Socket.sockets).toHaveLength(2);
    cleanup();
    expect(Socket.sockets[1].close).toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15000);
    expect(Socket.sockets).toHaveLength(2);
  });

  it.each([4401, 4403, 4404])('does not retry a fatal close (%s)', async (code) => {
    const socket = await mount();
    socket.onclose?.({ code, reason: 'Unavailable' });
    await vi.advanceTimersByTimeAsync(15000);
    expect(Socket.sockets).toHaveLength(1);
    expect(mocks.term.writeln).toHaveBeenCalledWith(expect.stringContaining('Unavailable'));
  });

  it('does not connect without authentication', async () => {
    mocks.auth.mockResolvedValue(null);
    await mount();
    expect(Socket.sockets).toHaveLength(0);
  });
});
