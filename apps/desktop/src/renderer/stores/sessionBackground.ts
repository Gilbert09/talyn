import { create } from 'zustand';
import { useMemo } from 'react';
import type { WorkbenchBackground, WorkbenchBackgroundJob, WorkbenchWakeup } from '@talyn/shared';
import { api } from '../lib/api';

interface SessionBackgroundState {
  byWorkbench: Record<string, WorkbenchBackground>;
  applyBackground: (payload: WorkbenchBackground) => void;
  clear: (id: string) => void;
}

const versions = new Map<string, number>();
const knownIds = new Set<string>();
let connectionVersion = 0;

export const useSessionBackgroundStore = create<SessionBackgroundState>((set) => ({
  byWorkbench: {},
  applyBackground: (payload) => {
    knownIds.add(payload.workbenchId);
    versions.set(payload.workbenchId, (versions.get(payload.workbenchId) ?? 0) + 1);
    set((state) => ({ byWorkbench: { ...state.byWorkbench, [payload.workbenchId]: payload } }));
  },
  clear: (id) => {
    knownIds.delete(id);
    versions.set(id, (versions.get(id) ?? 0) + 1);
    set((state) => {
      const byWorkbench = { ...state.byWorkbench };
      delete byWorkbench[id];
      return { byWorkbench };
    });
  },
}));

export async function loadBackground(id: string): Promise<void> {
  knownIds.add(id);
  const version = versions.get(id) ?? 0;
  const connection = connectionVersion;
  try {
    const payload = await api.workbenches.background(id);
    if (connection === connectionVersion && (versions.get(id) ?? 0) === version) {
      useSessionBackgroundStore.getState().applyBackground(payload);
    }
  } catch {
    // A later open or reconnect retries the load.
  }
}

/** Clear stale state before refreshing sessions, including those with no open view. */
export async function reconcileBackground(): Promise<void> {
  const ids = new Set([
    ...Object.keys(useSessionBackgroundStore.getState().byWorkbench),
    ...knownIds,
  ]);
  connectionVersion++;
  useSessionBackgroundStore.setState({ byWorkbench: {} });
  await Promise.all([...ids].map(loadBackground));
}

export function useBackground(id: string): WorkbenchBackground | undefined {
  return useSessionBackgroundStore((state) => state.byWorkbench[id]);
}

const EMPTY_WAKEUPS: WorkbenchWakeup[] = [];

export function useScheduledWakeupsForChat(id: string, chatId: string): WorkbenchWakeup[] {
  const wakeups = useSessionBackgroundStore((state) => state.byWorkbench[id]?.wakeups);
  return useMemo(() => wakeups?.filter((wakeup) => wakeup.chatId === chatId && wakeup.status === 'scheduled') ?? EMPTY_WAKEUPS, [wakeups, chatId]);
}

const EMPTY_JOBS: WorkbenchBackgroundJob[] = [];

export function useRunningJobs(id: string): WorkbenchBackgroundJob[] {
  const jobs = useSessionBackgroundStore((state) => state.byWorkbench[id]?.jobs);
  return useMemo(() => jobs?.filter((job) => job.status === 'running') ?? EMPTY_JOBS, [jobs]);
}
