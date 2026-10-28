import { create } from 'zustand';
import type { SlackPendingRequest } from '@talyn/shared';

/**
 * Slack requests waiting for the user to pick a repository. Loaded with
 * `GET /slack/pending` and topped up by `slack:notice` events.
 */
interface SlackPendingState {
  pending: SlackPendingRequest[];
  /** The request a "Pick repository" toast asked to focus. */
  focusId: string | null;
  setPending: (pending: SlackPendingRequest[]) => void;
  upsert: (request: SlackPendingRequest) => void;
  remove: (id: string) => void;
  focus: (id: string | null) => void;
}

export const useSlackPendingStore = create<SlackPendingState>((set) => ({
  pending: [],
  focusId: null,
  setPending: (pending) => set({ pending }),
  upsert: (request) =>
    set((s) =>
      s.pending.some((p) => p.id === request.id)
        ? { pending: s.pending.map((p) => (p.id === request.id ? request : p)) }
        : { pending: [...s.pending, request] }
    ),
  remove: (id) => set((s) => ({ pending: s.pending.filter((p) => p.id !== id) })),
  focus: (focusId) => set({ focusId }),
}));
