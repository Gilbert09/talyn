/** @jest-environment jsdom */
import type { Terminal } from '@xterm/xterm';
import { connectSandbox, TERMINAL_CONNECT_HINT } from '../renderer/components/workbench/terminal/ShellTerminal';

jest.mock('../renderer/lib/api', () => ({ api: { workbenches: {
  terminalUrl: (id: string) => `ws://test/${id}/terminal`,
  terminalAuthFrame: async () => '{"type":"auth","token":"test"}',
} } }));
jest.mock('../renderer/components/workbench/terminal/useXterm', () => ({ useXterm: () => ({}) }));

const OriginalWebSocket = globalThis.WebSocket;
afterEach(() => { globalThis.WebSocket = OriginalWebSocket; jest.useRealTimers(); });

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

function fakeTerminal() {
  let input: ((data: string) => void) | null = null;
  const terminal = { reset: jest.fn(), write: jest.fn(), writeln: jest.fn(),
    onData: (handler: (data: string) => void) => { input = handler; return { dispose: jest.fn() }; } };
  return { terminal, type: (data: string) => input?.(data) };
}

beforeEach(() => {
  sockets.length = 0;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
});

describe('on demand, as the dock mounts it', () => {
  it('connects nothing until a person asks, and says how', async () => {
    jest.useFakeTimers();
    const { terminal } = fakeTerminal();
    const { dispose } = connectSandbox(terminal as unknown as Terminal, 'wb', { current: null }, { current: null }, { onDemand: true });
    await Promise.resolve();
    jest.advanceTimersByTime(15000);
    expect(sockets).toHaveLength(0);
    expect(terminal.writeln).toHaveBeenCalledWith(TERMINAL_CONNECT_HINT);
    dispose();
  });

  it('connects once on start, however often it is asked', async () => {
    const { terminal } = fakeTerminal();
    const { start, dispose } = connectSandbox(terminal as unknown as Terminal, 'wb', { current: null }, { current: null }, { onDemand: true });
    start();
    start();
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
    dispose();
  });

  it('connects on the first key and sends it after authentication', async () => {
    const { terminal, type } = fakeTerminal();
    const { dispose } = connectSandbox(terminal as unknown as Terminal, 'wb', { current: { cols: 80, rows: 24 } }, { current: null }, { onDemand: true });
    type('l');
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
    sockets[0].onopen?.();
    expect(sockets[0].send.mock.calls.map(([frame]) => frame)).toEqual([
      '{"type":"auth","token":"test"}',
      JSON.stringify({ type: 'resize', cols: 80, rows: 24 }),
      new TextEncoder().encode('l'),
    ]);
    dispose();
  });

  it('never connects after dispose', async () => {
    const { terminal } = fakeTerminal();
    const { start, dispose } = connectSandbox(terminal as unknown as Terminal, 'wb', { current: null }, { current: null }, { onDemand: true });
    dispose();
    start();
    await Promise.resolve();
    expect(sockets).toHaveLength(0);
  });
});

it('reconnects with the same terminal id and clears replayed output without an error', async () => {
  jest.useFakeTimers();
  const { terminal } = fakeTerminal();
  const { dispose } = connectSandbox(terminal as unknown as Terminal, 'wb', { current: null }, { current: null });
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
