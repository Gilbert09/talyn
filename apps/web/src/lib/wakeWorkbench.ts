import { create } from 'zustand';
import { api } from './api';
import { boxRefusalFromPayload, type BoxRefusalNotice } from './usageBilling';

// The backend also collapses wakes for 30 s. This keeps the composer from
// sending one request per key press.
const WAKE_THROTTLE_MS = 30_000;
const lastWake = new Map<string, number>();

interface WakeRefusalState {
  /** Sessions whose box the plan would not wake, by id, with the refusal. */
  refusals: Record<string, BoxRefusalNotice>;
  setRefusal: (id: string, notice: BoxRefusalNotice | null) => void;
}

/**
 * A wake the plan refused answers 200 with `{ status: 'exhausted' | 'box_limit',
 * code, notice }` (usage billing). The session shows it beside the composer.
 * An older backend never sends those statuses, so nothing is ever stored.
 */
export const useWakeRefusalStore = create<WakeRefusalState>((set) => ({
  refusals: {},
  setRefusal: (id, notice) =>
    set((s) => {
      if (!notice) {
        if (!(id in s.refusals)) return s;
        const { [id]: _gone, ...rest } = s.refusals;
        return { refusals: rest };
      }
      return { refusals: { ...s.refusals, [id]: notice } };
    }),
}));

/** The refusal in a wake answer, or null when the box woke (or there was nothing to wake). */
export function wakeRefusal(answer: unknown): BoxRefusalNotice | null {
  if (!answer || typeof answer !== 'object') return null;
  const status = (answer as { status?: unknown }).status;
  if (status !== 'exhausted' && status !== 'box_limit') return null;
  return boxRefusalFromPayload(answer);
}

/** Ask the backend to resume a session's sleeping box before the first turn needs it. */
export function wakeWorkbench(id: string): void {
  const now = Date.now();
  if (now - (lastWake.get(id) ?? 0) < WAKE_THROTTLE_MS) return;
  lastWake.set(id, now);
  // A failed wake costs nothing: the turn still wakes the box itself.
  Promise.resolve()
    .then(() => api.workbenches.wake(id))
    .then((answer) => useWakeRefusalStore.getState().setRefusal(id, wakeRefusal(answer)))
    .catch(() => undefined);
}
