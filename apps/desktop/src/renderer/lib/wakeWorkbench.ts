import { api } from './api';
import type { BoxNotice } from './usageBilling';
import { useBillingStore } from '../stores/billing';

// The backend also collapses wakes for 30 s. This keeps the composer from
// sending one request per key press.
const WAKE_THROTTLE_MS = 30_000;
const lastWake = new Map<string, number>();

/**
 * What the wake route answers. With usage billing a box the plan will not
 * wake answers 200 with `exhausted` or `box_limit` and the refusal's notice;
 * an older backend never sends those, so the widened type is read here and
 * not in `@talyn/client`.
 */
interface WakeAnswer {
  status: 'skipped' | 'moving' | 'resuming' | 'awake' | 'exhausted' | 'box_limit';
  code?: string;
  notice?: BoxNotice;
}

/** Record the plan's answer to a wake, so the session can say why its box sleeps. */
export function applyWakeAnswer(id: string, answer: WakeAnswer | null | undefined): void {
  if (!answer) return;
  const { setSessionRefusal } = useBillingStore.getState();
  if (answer.status === 'exhausted' || answer.status === 'box_limit') {
    setSessionRefusal(id, { status: answer.status, notice: answer.notice ?? null });
  } else {
    setSessionRefusal(id, null);
  }
}

/** Ask the backend to resume a session's sleeping box before the first turn needs it. */
export function wakeWorkbench(id: string): void {
  const now = Date.now();
  if (now - (lastWake.get(id) ?? 0) < WAKE_THROTTLE_MS) return;
  lastWake.set(id, now);
  // A failed wake costs nothing: the turn still wakes the box itself.
  Promise.resolve()
    .then(() => api.workbenches.wake(id) as Promise<WakeAnswer>)
    .then((answer) => applyWakeAnswer(id, answer))
    .catch(() => undefined);
}
