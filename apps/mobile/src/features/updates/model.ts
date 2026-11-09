/** The shortest gap between two update checks that the app starts on its own, after it returns to the foreground. */
export const FOREGROUND_CHECK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * `off`: this build does not run updates (development client, or updates not enabled in the binary).
 * `ready`: an update is downloaded. It applies on the next cold start, or at once when the person restarts.
 */
export type UpdatePhase = 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'failed';
export type UpdateTrigger = 'launch' | 'foreground' | 'manual';

export interface UpdateState {
  phase: UpdatePhase;
  /** When the last check started. A failed check counts, so an offline phone does not check on every foreground. */
  lastCheckedAt: number | null;
  error: string | null;
  /** The downloaded update. `updateId` is null for a rollback to the embedded update. */
  ready: { updateId: string | null } | null;
  /** The person closed the "Update ready" banner. About still offers the restart. */
  dismissed: boolean;
}

export type UpdateEvent =
  | { type: 'check'; at: number }
  | { type: 'current' }
  | { type: 'download' }
  | { type: 'downloaded'; updateId: string | null }
  | { type: 'failed'; message: string }
  | { type: 'dismiss' };

export function initialUpdateState(enabled: boolean): UpdateState {
  return { phase: enabled ? 'idle' : 'off', lastCheckedAt: null, error: null, ready: null, dismissed: false };
}

export function reduceUpdate(state: UpdateState, event: UpdateEvent): UpdateState {
  if (state.phase === 'off') return state;
  switch (event.type) {
    case 'check': return { ...state, phase: 'checking', lastCheckedAt: event.at, error: null };
    case 'download': return { ...state, phase: 'downloading' };
    // A downloaded update stays ready until the app restarts, even if a later check finds nothing newer.
    case 'current': return { ...state, phase: state.ready ? 'ready' : 'current' };
    case 'downloaded': return { ...state, phase: 'ready', ready: { updateId: event.updateId }, error: null, dismissed: false };
    case 'failed': return { ...state, phase: state.ready ? 'ready' : 'failed', error: event.message };
    case 'dismiss': return { ...state, dismissed: true };
  }
}

/** Whether a trigger starts a check now. Automatic checks never run while one is in progress or an update is waiting. */
export function shouldCheck(state: UpdateState, trigger: UpdateTrigger, now: number, interval = FOREGROUND_CHECK_INTERVAL_MS): boolean {
  if (state.phase === 'off' || state.phase === 'checking' || state.phase === 'downloading') return false;
  if (trigger === 'manual') return true;
  if (state.phase === 'ready') return false;
  if (trigger === 'launch') return state.lastCheckedAt === null;
  return state.lastCheckedAt === null || now - state.lastCheckedAt >= interval;
}

export function showsReadyBanner(state: UpdateState): boolean {
  return state.phase === 'ready' && !state.dismissed;
}

/** The status line under "Check for updates" in About. Errors are shown here and nowhere else. */
export function updateStatusLabel(state: UpdateState): string {
  switch (state.phase) {
    case 'off': return 'This build does not receive updates';
    case 'idle': return 'Updates install when Talyn restarts';
    case 'checking': return 'Checking for updates';
    case 'downloading': return 'Downloading the update';
    case 'ready': return state.ready?.updateId === null ? 'Restart to return to the built-in version' : 'Update ready. Restart to apply it';
    case 'current': return 'Talyn is up to date';
    case 'failed': return `Could not check for updates. ${state.error ?? 'Try again later.'}`;
  }
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.trim() || 'Try again later.';
}
