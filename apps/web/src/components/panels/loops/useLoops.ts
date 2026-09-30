import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cloudAgentChoices,
  loopToInput,
  type CloudAgentChoice,
  type LoopInput,
  type LoopRun,
  type LoopWithStats,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useOnReconnect } from '../../../hooks/useOnReconnect';

/**
 * The Loops page's data.
 *
 * Owned here rather than in a global store, for the reason `useWorkflows` is:
 * this is the only screen that reads a loop. The live `loop:run` subscription
 * still needs the reconnect catch-up every WS consumer needs — broadcasts are
 * fire-and-forget to open sockets, so a run that landed while the socket was
 * down is simply lost.
 */
export interface UseLoops {
  /** `null` while loading — never conflated with "none", which renders differently. */
  loops: LoopWithStats[] | null;
  error: string | null;
  reload: () => void;
  create: (input: LoopInput) => Promise<void>;
  update: (id: string, input: LoopInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setEnabled: (loop: LoopWithStats, enabled: boolean) => Promise<void>;
  runNow: (id: string) => Promise<void>;
  /** The newest runs seen this session, keyed by loop — fed by the WS event. */
  liveRuns: Record<string, LoopRun[]>;
  /** The agents this workspace can run a loop on. Empty until providers load. */
  agents: CloudAgentChoice[];
}

export function useLoops(): UseLoops {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const cloudProviders = useWorkspaceStore((s) => s.cloudProviders);
  const [loops, setLoops] = useState<LoopWithStats[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveRuns, setLiveRuns] = useState<Record<string, LoopRun[]>>({});

  // Guards a response from a workspace the user has already switched away from.
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;

  const load = useCallback(() => {
    if (!workspaceId) {
      setLoops(null);
      return;
    }
    api.loops
      .list(workspaceId)
      .then((rows) => {
        if (workspaceRef.current !== workspaceId) return;
        setLoops(rows);
        setError(null);
      })
      .catch((err: unknown) => {
        if (workspaceRef.current !== workspaceId) return;
        setLoops([]);
        setError(err instanceof Error ? err.message : 'Could not load loops');
      });
  }, [workspaceId]);

  useEffect(() => {
    setLoops(null);
    setLiveRuns({});
    load();
  }, [load]);

  /**
   * The agent menu, derived from the same function the per-PR task menu uses.
   *
   * Fleet entries are absent when the provider list has no fleet — which is
   * what `GET /cloud-providers` already answers for a workspace outside the
   * fleet flag's audience. So the fleet part of this editor sits behind the
   * fleet flag without a second check here, and the backend gates again anyway.
   */
  const agents = useMemo(() => {
    const settings = workspaces.find((w) => w.id === workspaceId)?.settings;
    return cloudAgentChoices(cloudProviders ?? [], settings);
  }, [cloudProviders, workspaces, workspaceId]);

  // A run transition changes both the history and the derived stats, and the
  // stats are aggregated server-side — so the event splices the run in locally
  // (instant) and re-lists to pick up the recomputed counters.
  useEffect(() => {
    return api.ws.on('loop:run', (payload) => {
      const run = payload as LoopRun;
      if (!run?.loopId) return;
      setLiveRuns((prev) => {
        const existing = prev[run.loopId] ?? [];
        // Replace rather than prepend when it is a transition of a run already
        // held: a loop run is broadcast on every state change, so queued →
        // running → succeeded is three events about ONE row, and prepending
        // would show the same firing three times.
        const next = existing.some((r) => r.id === run.id)
          ? existing.map((r) => (r.id === run.id ? run : r))
          : [run, ...existing].slice(0, 50);
        return { ...prev, [run.loopId]: next };
      });
      load();
    });
  }, [load]);

  useOnReconnect(load);

  const create = useCallback(
    async (input: LoopInput) => {
      if (!workspaceId) return;
      const made = await api.loops.create(workspaceId, input);
      setLoops((prev) => [made, ...(prev ?? [])]);
    },
    [workspaceId]
  );

  const update = useCallback(async (id: string, input: LoopInput) => {
    const next = await api.loops.update(id, input);
    setLoops((prev) => (prev ?? []).map((l) => (l.id === id ? next : l)));
  }, []);

  const remove = useCallback(async (id: string) => {
    await api.loops.remove(id);
    setLoops((prev) => (prev ?? []).filter((l) => l.id !== id));
  }, []);

  /**
   * The on/off switch. Sends the whole definition, because PATCH is a whole-loop
   * replace — the provider and the model validate against each other.
   */
  const setEnabled = useCallback(
    async (loop: LoopWithStats, enabled: boolean) => {
      // Optimistic: a switch must feel like a switch. Rolled back by a reload.
      setLoops((prev) => (prev ?? []).map((l) => (l.id === loop.id ? { ...l, enabled } : l)));
      try {
        const next = await api.loops.update(loop.id, { ...loopToInput(loop), enabled });
        setLoops((prev) => (prev ?? []).map((l) => (l.id === next.id ? next : l)));
      } catch (err) {
        load();
        throw err;
      }
    },
    [load]
  );

  const runNow = useCallback(
    async (id: string) => {
      const run = await api.loops.runNow(id);
      if (run) {
        setLiveRuns((prev) => ({ ...prev, [id]: [run, ...(prev[id] ?? [])].slice(0, 50) }));
      }
      load();
    },
    [load]
  );

  return useMemo(
    () => ({ loops, error, reload: load, create, update, remove, setEnabled, runNow, liveRuns, agents }),
    [loops, error, load, create, update, remove, setEnabled, runNow, liveRuns, agents]
  );
}

/**
 * One loop's run history, paged.
 *
 * Seeded from the API and topped up by the live `loop:run` events the page hook
 * already collects, so an open history grows as runs land instead of needing a
 * refresh.
 */
export function useLoopRuns(
  loopId: string | null,
  live: LoopRun[] | undefined
): {
  runs: LoopRun[];
  loading: boolean;
  error: string | null;
  loadMore: () => void;
  hasMore: boolean;
} {
  const [fetched, setFetched] = useState<LoopRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const PAGE = 25;

  const fetchPage = useCallback(
    (cursor: string | null) => {
      if (!loopId) return;
      setLoading(true);
      api.loops
        .runs(loopId, { limit: PAGE, cursor })
        .then((rows) => {
          setFetched((prev) => (cursor ? [...prev, ...rows] : rows));
          setHasMore(rows.length === PAGE);
          setError(null);
        })
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : 'Could not load this history')
        )
        .finally(() => setLoading(false));
    },
    [loopId]
  );

  useEffect(() => {
    setFetched([]);
    setHasMore(false);
    if (loopId) fetchPage(null);
  }, [loopId, fetchPage]);

  const runs = useMemo(() => {
    // The live copy wins: it is the newer state of the same row, and a run
    // fetched as `queued` may already have succeeded by the time it renders.
    const byId = new Map<string, LoopRun>();
    for (const run of fetched) byId.set(run.id, run);
    for (const run of live ?? []) byId.set(run.id, run);
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [live, fetched]);

  const loadMore = useCallback(() => {
    const last = fetched[fetched.length - 1];
    if (last) fetchPage(last.createdAt);
  }, [fetched, fetchPage]);

  return { runs, loading, error, loadMore, hasMore };
}
