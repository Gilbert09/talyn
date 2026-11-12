import { EventEmitter } from 'events';
import type { DeskPresenceState } from '@talyn/shared';

import type { DeskPresenceBridge } from '../renderer/lib/deskPresence';

const mockHandlers = new Map<string, (event: unknown) => unknown>();
const mockPower = Object.assign(new EventEmitter(), {
  getSystemIdleState: jest.fn((): string => 'active'),
  getSystemIdleTime: jest.fn(() => 0),
});

jest.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown) => unknown) => mockHandlers.set(channel, handler) },
  powerMonitor: mockPower,
}));
jest.mock('../renderer/lib/api', () => ({ wsClient: { setDeskPresence: jest.fn() } }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { deskStateFrom, registerDeskPresence } = require('../main/deskPresence') as typeof import('../main/deskPresence');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { installDeskPresence } = require('../renderer/lib/deskPresence') as typeof import('../renderer/lib/deskPresence');
const handlers = mockHandlers;
const power = mockPower;

describe('deskStateFrom', () => {
  it.each([
    ['active', 999, false, false, 'active'],
    ['idle', 0, false, false, 'away'],
    ['locked', 0, false, false, 'away'],
    ['active', 0, true, false, 'away'],
    ['active', 0, false, true, 'away'],
    ['unknown', 179, false, false, 'active'],
    ['unknown', 180, false, false, 'away'],
    ['unknown', 0, true, false, 'away'],
  ] as const)('idle state %s, %i s idle, locked %s, asleep %s reads %s', (idleState, seconds, locked, suspended, expected) => {
    expect(deskStateFrom({ idleState, idleSeconds: () => seconds, locked, suspended })).toBe(expected);
  });
});

describe('registerDeskPresence', () => {
  const webContents = { send: jest.fn(), mainFrame: {} };
  const window = { isDestroyed: () => false, webContents };
  const ask = () => handlers.get('desk-presence:get')!({ sender: webContents, senderFrame: webContents.mainFrame });

  beforeAll(() => registerDeskPresence(() => window as never));
  beforeEach(() => {
    webContents.send.mockClear();
    power.getSystemIdleState.mockReturnValue('active');
  });

  it('asks Electron with a three minute threshold', () => {
    expect(ask()).toBe('active');
    expect(power.getSystemIdleState).toHaveBeenCalledWith(180);
  });

  it.each([['lock-screen', 'unlock-screen'], ['suspend', 'resume']])('reads away after %s and active after %s, and tells the renderer', (off, on) => {
    power.emit(off);
    expect(ask()).toBe('away');
    power.emit(on);
    expect(ask()).toBe('active');
    expect(webContents.send.mock.calls).toEqual([['desk-presence:changed'], ['desk-presence:changed']]);
  });

  it('answers away to another frame', () => {
    expect(handlers.get('desk-presence:get')!({ sender: webContents, senderFrame: {} })).toBe('away');
    expect(handlers.get('desk-presence:get')!({ sender: {}, senderFrame: webContents.mainFrame })).toBe('away');
  });

  it('answers away when Electron cannot read idle', () => {
    power.getSystemIdleState.mockImplementation(() => { throw new Error('unsupported'); });
    expect(ask()).toBe('away');
  });
});

describe('installDeskPresence', () => {
  let state: DeskPresenceState;
  let notify: (() => void) | null;
  let sent: DeskPresenceState[];
  const bridge: DeskPresenceBridge = {
    getState: async () => state,
    onChange: (callback) => {
      notify = callback;
      return () => { notify = null; };
    },
  };
  const client = { setDeskPresence: (value: DeskPresenceState) => { sent.push(value); } };
  const flush = async () => { await jest.advanceTimersByTimeAsync(0); };

  beforeEach(() => {
    jest.useFakeTimers();
    state = 'active';
    notify = null;
    sent = [];
  });
  afterEach(() => jest.useRealTimers());

  it('beats active every 30 seconds while the computer is in use', async () => {
    const stop = installDeskPresence(bridge, client);
    await flush();
    expect(sent).toEqual(['active']);
    await jest.advanceTimersByTimeAsync(90_000);
    expect(sent).toEqual(['active', 'active', 'active', 'active']);
    stop();
  });

  it('sends one away when idle reaches three minutes, then nothing', async () => {
    const stop = installDeskPresence(bridge, client);
    await flush();
    state = 'away';
    await jest.advanceTimersByTimeAsync(30_000);
    expect(sent).toEqual(['active', 'away']);
    await jest.advanceTimersByTimeAsync(600_000);
    expect(sent).toEqual(['active', 'away']);
    stop();
  });

  it('sends away at once on lock and active at once on unlock', async () => {
    const stop = installDeskPresence(bridge, client);
    await flush();
    state = 'away';
    notify!();
    await flush();
    expect(sent).toEqual(['active', 'away']);
    state = 'active';
    notify!();
    await flush();
    expect(sent).toEqual(['active', 'away', 'active']);
    stop();
  });

  it('sends away on stop and unsubscribes', async () => {
    const stop = installDeskPresence(bridge, client);
    await flush();
    stop();
    expect(sent).toEqual(['active', 'away']);
    expect(notify).toBeNull();
  });

  it('does nothing without a bridge', () => {
    const stop = installDeskPresence(undefined, client);
    expect(sent).toEqual([]);
    stop();
  });
});
