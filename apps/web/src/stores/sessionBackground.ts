import { create } from 'zustand';
import { useMemo } from 'react';
import type { Workbench, WorkbenchBackground, WorkbenchBackgroundJob, WorkbenchWakeup } from '@talyn/shared';
import { api } from '../lib/api';

interface SessionBackgroundState {
  byWorkbench: Record<string, WorkbenchBackground>;
  applyBackground: (payload: WorkbenchBackground) => void;
  clear: (id: string) => void;
}

const versions = new Map<string, number>();
const knownIds = new Set<string>();
let connectionVersion = 0;
const refreshQueue = new Set<string>();
let refreshPromise: Promise<void> | undefined;
let finishRefresh: (() => void) | undefined;
let refreshWorkers = 0;
const REFRESH_CONCURRENCY = 4;

export const useSessionBackgroundStore = create<SessionBackgroundState>((set) => ({
  byWorkbench: {},
  applyBackground: (payload) => {
    knownIds.add(payload.workbenchId);
    versions.set(payload.workbenchId, (versions.get(payload.workbenchId) ?? 0) + 1);
    set((state) => ({ byWorkbench: { ...state.byWorkbench, [payload.workbenchId]: payload } }));
  },
  clear: (id) => {
    knownIds.delete(id);
    refreshQueue.delete(id);
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

/** Stop tracking sessions that were archived, deleted, or left with the previous workspace. */
export function pruneBackground(workbenches: Record<string, Workbench>): void {
  for (const id of knownIds) {
    const workbench = workbenches[id];
    if (!workbench || workbench.archivedAt || workbench.status === 'archived') {
      useSessionBackgroundStore.getState().clear(id);
    }
  }
}

async function refreshWorker(): Promise<void> {
  while (refreshQueue.size > 0) {
    const id = refreshQueue.values().next().value!;
    refreshQueue.delete(id);
    await loadBackground(id);
  }
  refreshWorkers--;
  if (refreshWorkers === 0) {
    refreshPromise = undefined;
    finishRefresh?.();
    finishRefresh = undefined;
  }
}

/** Clear stale snapshots and share a bounded queue across reconnects. */
export function reconcileBackground(workbenches?: Record<string, Workbench>): Promise<void> {
  if (workbenches) pruneBackground(workbenches);
  connectionVersion++;
  useSessionBackgroundStore.setState({ byWorkbench: {} });
  refreshQueue.clear();
  for (const id of knownIds) refreshQueue.add(id);
  if (refreshPromise) return refreshPromise;
  const promise = new Promise<void>((resolve) => { finishRefresh = resolve; });
  refreshPromise = promise;
  refreshWorkers = REFRESH_CONCURRENCY;
  for (let i = 0; i < REFRESH_CONCURRENCY; i++) void refreshWorker();
  return promise;
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
