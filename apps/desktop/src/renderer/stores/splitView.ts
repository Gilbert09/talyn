import { create } from 'zustand';
import {
  addSplitPane,
  moveSplitPane,
  parseSplitPanes,
  placeSplitPane,
  removeSplitPane,
  type SplitDropPosition,
} from '@talyn/shared';
import { trackEvent } from '../lib/analytics';

/**
 * The sessions open in split view, in pane order, and the pane that has the
 * keyboard. A view decision kept on this device (like the panel layout), so
 * it survives a reload.
 *
 * Focus is the store's own, NOT `useWorkbenchStore.selectedWorkbenchId`:
 * selecting a workbench navigates to its page, which would leave split view.
 */

const STORAGE_KEY = 'talyn:split-view';

interface SplitViewState {
  panes: string[];
  focusedId: string | null;
  /** Add a session (or keep it where it is) and give it the keyboard. */
  addPane: (id: string, source: string) => void;
  /** Put a dragged session into the pane `targetId`, or beside it, and give it the keyboard. */
  placePane: (id: string, targetId: string, position: SplitDropPosition, source: string) => void;
  removePane: (id: string) => void;
  movePane: (id: string, direction: -1 | 1) => void;
  focusPane: (id: string) => void;
  /** Drop panes for sessions that are gone. */
  prunePanes: (keep: (id: string) => boolean) => void;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readPanes(): string[] {
  try {
    return parseSplitPanes(JSON.parse(storage()?.getItem(STORAGE_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

function writePanes(panes: string[]): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(panes));
  } catch {
    // Private mode or a full quota: the panes still work for this visit.
  }
}

function nextFocus(panes: string[], focusedId: string | null): string | null {
  return focusedId && panes.includes(focusedId) ? focusedId : (panes[panes.length - 1] ?? null);
}

const initialPanes = readPanes();

export const useSplitViewStore = create<SplitViewState>((set, get) => ({
  panes: initialPanes,
  focusedId: initialPanes[initialPanes.length - 1] ?? null,

  addPane: (id, source) => {
    const before = get().panes;
    const panes = addSplitPane(before, id);
    if (!before.includes(id)) trackEvent('split_view_pane_added', { workbench_id: id, source, panes: panes.length });
    set({ panes, focusedId: id });
  },

  placePane: (id, targetId, position, source) => {
    const before = get().panes;
    const panes = placeSplitPane(before, id, targetId, position);
    if (!panes.includes(id)) return;
    if (!before.includes(id)) trackEvent('split_view_pane_added', { workbench_id: id, source, panes: panes.length });
    set({ panes, focusedId: id });
  },

  removePane: (id) =>
    set((s) => {
      const panes = removeSplitPane(s.panes, id);
      return { panes, focusedId: nextFocus(panes, s.focusedId === id ? null : s.focusedId) };
    }),

  movePane: (id, direction) => set((s) => ({ panes: moveSplitPane(s.panes, id, direction) })),

  focusPane: (id) => set((s) => (s.focusedId === id || !s.panes.includes(id) ? s : { focusedId: id })),

  prunePanes: (keep) =>
    set((s) => {
      const panes = s.panes.filter(keep);
      if (panes.length === s.panes.length) return s;
      return { panes, focusedId: nextFocus(panes, s.focusedId) };
    }),
}));

useSplitViewStore.subscribe((state, previous) => {
  if (state.panes !== previous.panes) writePanes(state.panes);
});
