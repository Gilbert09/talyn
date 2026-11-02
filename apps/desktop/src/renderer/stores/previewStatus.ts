import { create } from 'zustand';

/** `starting`: the run script is coming up and the port does not answer yet. `live`: it answers. */
export type PreviewPortState = 'starting' | 'live';

interface PreviewStatusState {
  /** Keyed `${workbenchId}:${port}`. */
  ports: Record<string, PreviewPortState>;
  runStarting: Record<string, boolean>;
  setRunStarting: (workbenchId: string, starting: boolean) => void;
  set: (workbenchId: string, port: number, state: PreviewPortState | null) => void;
  clearWorkbench: (workbenchId: string) => void;
}

export const previewKey = (workbenchId: string, port: number) => `${workbenchId}:${port}`;

export const usePreviewStatusStore = create<PreviewStatusState>((set) => ({
  ports: {},
  runStarting: {},
  setRunStarting: (workbenchId, starting) => set((s) => ({
    runStarting: { ...s.runStarting, [workbenchId]: starting },
  })),
  set: (workbenchId, port, state) =>
    set((s) => {
      const key = previewKey(workbenchId, port);
      if ((s.ports[key] ?? null) === state) return s;
      const ports = { ...s.ports };
      if (state) ports[key] = state;
      else delete ports[key];
      return { ports };
    }),
  clearWorkbench: (workbenchId) =>
    set((s) => {
      const keys = Object.keys(s.ports).filter((k) => k.startsWith(`${workbenchId}:`));
      if (keys.length === 0) return s;
      const ports = { ...s.ports };
      for (const k of keys) delete ports[k];
      return { ports };
    }),
}));
