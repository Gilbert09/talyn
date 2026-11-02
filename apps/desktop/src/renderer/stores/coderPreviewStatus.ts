import { create } from 'zustand';
import type { CoderPreviewState, CoderStep } from '../../workbenchBridgeTypes';

export interface CoderPreviewStatus {
  state: CoderPreviewState | null;
  busy: boolean;
  step: CoderStep | null;
  detail: string | null;
  error: string | null;
  refreshError: string | null;
}

export const emptyCoderPreviewStatus: CoderPreviewStatus = {
  state: null, busy: false, step: null, detail: null, error: null, refreshError: null,
};

interface CoderPreviewStatusStore {
  sessions: Record<string, CoderPreviewStatus>;
  update: (id: string, patch: Partial<CoderPreviewStatus>) => void;
}

export const useCoderPreviewStatusStore = create<CoderPreviewStatusStore>((set) => ({
  sessions: {},
  update: (id, patch) => set((current) => ({
    sessions: { ...current.sessions, [id]: { ...emptyCoderPreviewStatus, ...current.sessions[id], ...patch } },
  })),
}));
