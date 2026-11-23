import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeskPresenceState } from '@talyn/shared';

vi.mock('../lib/api', async () => {
  const client = await vi.importActual<typeof import('@talyn/client')>('@talyn/client');
  return { startDeskPresenceHeartbeat: client.startDeskPresenceHeartbeat, wsClient: { setDeskPresence: vi.fn() } };
});

import { browserDeskActivity, installDeskPresence } from '../lib/deskPresence';

let visibility: DocumentVisibilityState = 'visible';
function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('web desk presence', () => {
  let sent: DeskPresenceState[];
  let stop: () => void;
  const client = { setDeskPresence: (state: DeskPresenceState) => { sent.push(state); } };
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const start = () => { stop = installDeskPresence(browserDeskActivity(), client); };

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    sent = [];
  });
  afterEach(() => {
    stop?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('beats active every 30 seconds while the tab is visible and in use', async () => {
    start();
    await flush();
    expect(sent).toEqual(['active']);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      document.dispatchEvent(new Event('keydown'));
    }
    expect(sent).toEqual(['active', 'active', 'active', 'active']);
  });

  it('sends one away after three minutes without input, then nothing', async () => {
    start();
    await flush();
    await vi.advanceTimersByTimeAsync(179_999);
    expect(sent.every((state) => state === 'active')).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent.at(-1)).toBe('away');
    const count = sent.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toHaveLength(count);
  });

  it.each(['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'])('sends active at once on %s after idle', async (type) => {
    start();
    await vi.advanceTimersByTimeAsync(210_000);
    expect(sent.at(-1)).toBe('away');
    document.dispatchEvent(new Event(type));
    await flush();
    expect(sent.at(-1)).toBe('active');
  });

  it('does not send on input while already active', async () => {
    start();
    await flush();
    for (let i = 0; i < 100; i++) document.dispatchEvent(new Event('pointermove'));
    await flush();
    expect(sent).toEqual(['active']);
  });

  it('sends away at once when the tab is hidden and active when shown again', async () => {
    start();
    await flush();
    setVisibility('hidden');
    await flush();
    expect(sent).toEqual(['active', 'away']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toEqual(['active', 'away']);
    setVisibility('visible');
    await flush();
    expect(sent).toEqual(['active', 'away', 'active']);
  });

  it('reports away when it starts in a hidden tab', async () => {
    visibility = 'hidden';
    start();
    await flush();
    expect(sent).toEqual(['away']);
  });

  it('sends away on stop and removes its listeners', async () => {
    start();
    await flush();
    stop();
    expect(sent).toEqual(['active', 'away']);
    setVisibility('hidden');
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual(['active', 'away']);
  });
});
