/** @jest-environment jsdom */
import type { Terminal } from '@xterm/xterm';
import { connectSandbox } from '../renderer/components/workbench/terminal/ShellTerminal';

jest.mock('../renderer/lib/api', () => ({ api: { workbenches: {
  terminalUrl: (id: string) => `ws://test/${id}/terminal`,
  terminalAuthFrame: async () => '{"type":"auth","token":"test"}',
} } }));
jest.mock('../renderer/components/workbench/terminal/useXterm', () => ({ useXterm: () => ({}) }));

const OriginalWebSocket = globalThis.WebSocket;
afterEach(() => { globalThis.WebSocket = OriginalWebSocket; jest.useRealTimers(); });

it('reconnects with the same terminal id and clears replayed output without an error', async () => {
  jest.useFakeTimers();
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    binaryType = '';
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    send = jest.fn();
    close = jest.fn();
    constructor(readonly url: string) { sockets.push(this); }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const terminal = { reset: jest.fn(), write: jest.fn(), writeln: jest.fn(),
    onData: () => ({ dispose: jest.fn() }) };
  const dispose = connectSandbox(terminal as unknown as Terminal, 'wb', { current: null }, { current: null });
  await Promise.resolve();
  sockets[0].onopen?.();
  sockets[0].onmessage?.({ data: 'first screen' });
  sockets[0].onclose?.({ code: 1012, reason: 'deploy' });
  jest.advanceTimersByTime(1000);
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
