import { afterEach, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { connectSandbox } from '../components/workbench/terminal/ShellTerminal';

vi.mock('../lib/api', () => ({ api: { workbenches: {
  terminalUrl: (id: string) => `ws://test/${id}/terminal`,
  terminalAuthFrame: async () => '{"type":"auth","token":"test"}',
} } }));
vi.mock('../components/workbench/terminal/useXterm', () => ({ useXterm: () => ({}) }));

const OriginalWebSocket = globalThis.WebSocket;
afterEach(() => { globalThis.WebSocket = OriginalWebSocket; vi.useRealTimers(); });

it('reconnects with the same terminal id and clears replayed output without an error', async () => {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    binaryType = '';
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    send = vi.fn();
    close = vi.fn();
    constructor(readonly url: string) { sockets.push(this); }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const terminal = { reset: vi.fn(), write: vi.fn(), writeln: vi.fn(),
    onData: () => ({ dispose: vi.fn() }) };
  const dispose = connectSandbox(terminal as unknown as Terminal, 'wb', { current: null }, { current: null });
  await Promise.resolve();
  sockets[0].onopen?.();
  sockets[0].onmessage?.({ data: 'first screen' });
  sockets[0].onclose?.({ code: 1012, reason: 'deploy' });
  vi.advanceTimersByTime(1000);
  await Promise.resolve();
  expect(sockets).toHaveLength(2);
  expect(sockets[1].url).toBe(sockets[0].url);
  expect(sockets[1].url).toContain('session=main');
  sockets[1].onopen?.();
  sockets[1].onmessage?.({ data: 'saved history' });
  expect(terminal.reset).toHaveBeenCalledTimes(2);
  expect(terminal.writeln).not.toHaveBeenCalled();
  dispose();
});
