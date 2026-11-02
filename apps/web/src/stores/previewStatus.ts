import { create } from 'zustand';

type PortState = 'starting' | 'live';
interface PreviewStatusStore {
  ports: Record<string, PortState>;
  runStarting: Record<string, boolean>;
  setRunStarting: (id: string, starting: boolean) => void;
  set: (id: string, port: number, state: PortState | null) => void;
  clear: (id: string) => void;
}

export const previewKey = (id: string, port: number) => `${id}:${port}`;
export const usePreviewStatusStore = create<PreviewStatusStore>((set) => ({
  ports: {},
  runStarting: {},
  setRunStarting: (id, starting) => set((current) => ({
    runStarting: { ...current.runStarting, [id]: starting },
  })),
  set: (id, port, state) => set((current) => {
    const ports = { ...current.ports };
    if (state) ports[previewKey(id, port)] = state;
    else delete ports[previewKey(id, port)];
    return { ports };
  }),
  clear: (id) => set((current) => ({
    ports: Object.fromEntries(Object.entries(current.ports).filter(([key]) => !key.startsWith(`${id}:`))),
  })),
}));
