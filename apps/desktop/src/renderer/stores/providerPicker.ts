import { create } from 'zustand';

/** A connected cloud provider the user can pick to run a task with. */
export interface ProviderChoice {
  type: string;
  displayName: string;
}

interface ProviderPickerState {
  request: { providers: ProviderChoice[]; resolve: (type: string | null) => void } | null;
  /** Open the picker; resolves with the chosen provider type, or null if cancelled. */
  open: (providers: ProviderChoice[]) => Promise<string | null>;
  /** The modal calls this with the user's choice (or null on cancel/dismiss). */
  choose: (type: string | null) => void;
}

export const useProviderPicker = create<ProviderPickerState>((set, get) => ({
  request: null,
  open: (providers) =>
    new Promise<string | null>((resolve) => set({ request: { providers, resolve } })),
  choose: (type) => {
    get().request?.resolve(type);
    set({ request: null });
  },
}));

/** Imperative helper for non-component callers (e.g. the GitHub actions hook). */
export function pickCloudProvider(providers: ProviderChoice[]): Promise<string | null> {
  return useProviderPicker.getState().open(providers);
}
