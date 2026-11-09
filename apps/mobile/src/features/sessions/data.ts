import { wsClient } from '@talyn/client/native';
import type { Workbench, WorkbenchBackground, WorkbenchBackgroundLogs, WorkbenchChanges, WorkbenchDiff, WorkbenchDiffScope } from '@talyn/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { boxRefusal, showBoxRefusal } from '../../lib/errors';
import { failureState, type LoadState } from '../../workflow/model';
import { needsWake } from './changes';

export interface Load<T> {
  status: LoadState; data?: T; error?: unknown; refreshing: boolean; stale: boolean;
  refresh(): Promise<void>;
  /** Replace the held data without a fetch, e.g. from a socket event. */
  set(data: T): void;
}
interface LoadInner<T> { key: string | null; status: LoadState; data?: T; error?: unknown; refreshing: boolean }

/**
 * One server read for a tab. A new `key` drops the old data; null reads
 * nothing. A failed refresh keeps the last data, and coming back online
 * reads again. Uses only the workflow runtime, so the screens stay testable
 * with the shared fixtures.
 */
export function useLoad<T>(key: string | null, load: () => Promise<T>): Load<T> {
  const offline = useNetwork() === 'offline';
  const [state, setState] = useState<LoadInner<T>>({ key, status: key ? 'loading' : 'idle', refreshing: false });
  const loader = useRef(load);
  loader.current = load;
  const current = useRef(key);
  current.current = key;
  const offlineRef = useRef(offline);
  offlineRef.current = offline;

  const run = useCallback(async () => {
    const target = current.current;
    if (!target) return;
    if (offlineRef.current) {
      setState((prev) => prev.key === target ? { ...prev, status: prev.data === undefined ? 'offline' : prev.status, refreshing: false } : prev);
      return;
    }
    setState((prev) => prev.key === target ? { ...prev, refreshing: true, status: prev.data === undefined ? 'loading' : prev.status } : prev);
    try {
      const data = await loader.current();
      if (current.current === target) setState({ key: target, status: 'ready', data, refreshing: false });
    } catch (error) {
      if (current.current === target) setState((prev) => ({ ...prev, key: target, status: failureState(error), error, refreshing: false }));
    }
  }, []);

  useEffect(() => {
    setState({ key, status: key ? 'loading' : 'idle', refreshing: false });
    void run();
  }, [key, run]);
  const wasOffline = useRef(offline);
  useEffect(() => {
    if (wasOffline.current && !offline) void run();
    wasOffline.current = offline;
  }, [offline, run]);

  const set = useCallback((data: T) => setState((prev) => ({ ...prev, status: 'ready', data })), []);
  const shown = state.key === key ? state : { key, status: key ? 'loading' as const : 'idle' as const, refreshing: false };
  return { status: shown.status, data: shown.data, error: 'error' in shown ? shown.error : undefined,
    refreshing: shown.refreshing, stale: false, refresh: run, set };
}

/** A read that wakes the box goes through the box gate. Its 402 gets the plan alert. */
function wakeRefused(error: unknown) {
  const refusal = boxRefusal(error);
  if (refusal) showBoxRefusal(refusal);
  return error;
}

const isSandboxSession = (item: Workbench | undefined) =>
  Boolean(item && (item.kind ?? 'session') === 'session' && item.runtime === 'sandbox' && !item.archivedAt && item.status !== 'archived');

/** How often the jobs list refreshes while a job runs, besides the socket events. */
const BACKGROUND_POLL_MS = 30_000;

/** The session's background jobs and wake-ups, kept current by `workbench:background` events. */
export function useBackground(item: Workbench | undefined) {
  const { workflow } = useMobileRuntime();
  const id = isSandboxSession(item) ? item!.id : null;
  const remote = useLoad<WorkbenchBackground>(id ? `background:${id}` : null, () => workflow.api.workbenches.background(id ?? ''));
  const { set, refresh } = remote;
  useEffect(() => {
    if (!id) return undefined;
    return wsClient.on<WorkbenchBackground>('workbench:background', (payload) => { if (payload?.workbenchId === id) set(payload); });
  }, [id, set]);
  const running = remote.data?.jobs.some((job) => job.status === 'running') ?? false;
  useEffect(() => {
    if (!id || !running) return undefined;
    const timer = setInterval(() => { void refresh(); }, BACKGROUND_POLL_MS);
    return () => clearInterval(timer);
  }, [id, running, refresh]);
  return remote;
}

export interface ChangesRead { changes: WorkbenchChanges | null; asleep: boolean }

/**
 * The branch's changes. A plain read takes a sleeping box's stored list and
 * never wakes it; `refresh(true)` reads the box, which wakes it, like web's
 * refresh button. A sleeping box with no stored list answers `asleep`.
 */
export function useChanges(item: Workbench, enabled: boolean) {
  const { workflow } = useMobileRuntime();
  const live = useRef(false);
  const remote = useLoad<ChangesRead>(enabled ? `changes:${item.id}` : null, async () => {
    const wake = live.current;
    live.current = false;
    try {
      return { changes: await workflow.api.workbenches.changes(item.id, wake ? { live: true } : {}), asleep: false };
    } catch (error) {
      if (!wake && needsWake(error)) return { changes: null, asleep: true };
      throw wakeRefused(error);
    }
  });
  // A new stored copy, a new diff stat, or a turn that ended means the list moved.
  const running = (item.chats ?? []).some((chat) => chat.status === 'running');
  const moved = `${item.changesEtag ?? ''}|${JSON.stringify([item.diffStat, item.uncommittedStats, item.committedStats])}|${running}`;
  const seen = useRef(moved);
  const { refresh } = remote;
  useEffect(() => {
    if (seen.current === moved) return;
    seen.current = moved;
    if (enabled) void refresh();
  }, [moved, enabled, refresh]);
  const reload = useCallback((wake = false) => { live.current = wake; return refresh(); }, [refresh]);
  return { ...remote, reload };
}

/** One file's diff. `live` wakes a sleeping box; without it a missing stored copy answers `wake`. */
export function useFileDiff(id: string, path: string | null, scope: WorkbenchDiffScope, live: boolean, revision: string) {
  const { workflow } = useMobileRuntime();
  return useLoad<{ diff: WorkbenchDiff | null; wake: boolean }>(path ? `diff:${id}:${scope}:${path}:${live}:${revision}` : null, async () => {
    try {
      return { diff: await workflow.api.workbenches.diff(id, path ?? undefined, scope, live ? { live: true } : {}), wake: false };
    } catch (error) {
      if (!live && needsWake(error)) return { diff: null, wake: true };
      throw wakeRefused(error);
    }
  });
}

/** How often an open log refreshes while its job runs. */
const LOG_POLL_MS = 5_000;
export const LOG_TAIL = 200;

/** The last lines of a job's output while it is open. A sleeping box answers `asleep` unless `live`. */
export function useJobLogs(workbenchId: string, jobId: string, open: boolean, running: boolean, live: boolean) {
  const { workflow } = useMobileRuntime();
  const remote = useLoad<WorkbenchBackgroundLogs>(open ? `logs:${workbenchId}:${jobId}:${live}` : null,
    () => workflow.api.workbenches.backgroundJobLogs(workbenchId, jobId, { tail: LOG_TAIL, ...(live ? { live: true } : {}) })
      .catch((error: unknown) => { throw live ? wakeRefused(error) : error; }));
  const { refresh } = remote;
  useEffect(() => {
    if (!open || !running) return undefined;
    const timer = setInterval(() => { void refresh(); }, LOG_POLL_MS);
    return () => clearInterval(timer);
  }, [open, running, refresh]);
  return remote;
}
