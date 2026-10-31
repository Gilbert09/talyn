import { api } from './api';

// The backend also collapses wakes for 30 s. This keeps the composer from
// sending one request per key press.
const WAKE_THROTTLE_MS = 30_000;
const lastWake = new Map<string, number>();

/** Ask the backend to resume a session's sleeping box before the first turn needs it. */
export function wakeWorkbench(id: string): void {
  const now = Date.now();
  if (now - (lastWake.get(id) ?? 0) < WAKE_THROTTLE_MS) return;
  lastWake.set(id, now);
  // A failed wake costs nothing: the turn still wakes the box itself.
  Promise.resolve().then(() => api.workbenches.wake(id)).catch(() => undefined);
}
