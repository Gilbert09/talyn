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

export const useSessionBackgroundStore = create<SessionBackgroundState>((set) => ({
  byWorkbench: {},
  applyBackground: (payload) => {
    versions.set(payload.workbenchId, (versions.get(payload.workbenchId) ?? 0) + 1);
    set((state) => ({ byWorkbench: { ...state.byWorkbench, [payload.workbenchId]: payload } }));
  },
  clear: (id) => {
    versions.set(id, (versions.get(id) ?? 0) + 1);
    set((state) => {
      const byWorkbench = { ...state.byWorkbench };
      delete byWorkbench[id];
      return { byWorkbench };
    });
  },
}));

export async function loadBackground(id: string): Promise<void> {
  const version = versions.get(id) ?? 0;
  try {
    const payload = await api.workbenches.background(id);
    if ((versions.get(id) ?? 0) === version) useSessionBackgroundStore.getState().applyBackground(payload);
  } catch {
    // A later open or reconnect retries the load.
  }
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
