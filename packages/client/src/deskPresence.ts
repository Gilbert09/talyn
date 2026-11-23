import { DESK_PRESENCE_BEAT_MS, type DeskPresenceState } from '@talyn/shared';

/**
 * Where a front end reads whether the person is using the computer. The
 * desktop reads system idle and screen lock; the web reads tab visibility and
 * input in the page.
 */
export interface DeskActivitySource {
  /** The state now. */
  read(): DeskPresenceState | Promise<DeskPresenceState>;
  /**
   * Call `onChange` when the state may have changed at once: a lock, an
   * unlock, a sleep, a wake, the first input after idle, a tab shown or hidden.
   * Returns the unsubscribe.
   */
  subscribe(onChange: () => void): () => void;
}

export interface DeskPresenceTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimers: DeskPresenceTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Report desk presence until the returned stop is called.
 *
 * While the source reads `active`, `active` goes out at once and then every
 * beat, which keeps the server's one-minute record alive. When it reads `away`,
 * one `away` goes out and then nothing until it is active again. A change
 * event sends only a different state, so input events cannot flood the socket.
 * Stop sends `away` when the last report was `active`.
 */
export function startDeskPresenceHeartbeat(
  source: DeskActivitySource,
  send: (state: DeskPresenceState) => void,
  options: { beatMs?: number; timers?: DeskPresenceTimers } = {},
): () => void {
  const timers = options.timers ?? defaultTimers;
  let stopped = false;
  let last: DeskPresenceState | null = null;

  const check = async (beat: boolean) => {
    let state: DeskPresenceState;
    try {
      state = await source.read();
    } catch {
      // No reading means no claim to be at the desk; the phone gets the alert.
      state = 'away';
    }
    if (stopped) return;
    if (state === last && !(beat && state === 'active')) return;
    last = state;
    send(state);
  };

  const timer = timers.setInterval(() => { void check(true); }, options.beatMs ?? DESK_PRESENCE_BEAT_MS);
  const unsubscribe = source.subscribe(() => { void check(false); });
  void check(true);

  return () => {
    if (stopped) return;
    stopped = true;
    timers.clearInterval(timer);
    unsubscribe();
    if (last === 'active') send('away');
  };
}
