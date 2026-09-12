import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  WorkflowInput,
  WorkflowRun,
  WorkflowSuggestions,
  WorkflowWithStats,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useOnReconnect } from '../../../hooks/useOnReconnect';

/**
 * The Workflows page's data.
 *
 * Owned here rather than in a global store because this is the only screen that
 * reads it — unlike PRs and tasks, nothing else in the app renders a workflow.
 * The live `workflow:run` subscription still needs the reconnect catch-up that
 * every WS consumer needs: broadcasts are fire-and-forget to open sockets, so a
 * run that landed while the socket was down is simply lost.
 */
export interface UseWorkflows {
  /** `null` while loading — never conflated with "none", which renders differently. */
  workflows: WorkflowWithStats[] | null;
  error: string | null;
  reload: () => void;
  create: (input: WorkflowInput) => Promise<void>;
  update: (id: string, input: WorkflowInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setEnabled: (workflow: WorkflowWithStats, enabled: boolean) => Promise<void>;
  /** The newest runs seen this session, keyed by workflow — fed by the WS event. */
  liveRuns: Record<string, WorkflowRun[]>;
  /**
   * Autocomplete options for the editor. `null` until loaded — the editor treats
   * that as "no suggestions yet" and still accepts typed values, so it never
   * blocks on this.
   *
   * Starts as the cheap half: the workspace's repositories and their default
   * branches, straight from our own rows. The GitHub-backed half arrives only
   * when {@link loadGithubSuggestions} is called.
   */
  suggestions: WorkflowSuggestions | null;
  /**
   * Fetch labels, people and teams for `repos` — the repositories a workflow
   * names.
   *
   * Called when the user opens a field that needs them, not when the editor
   * opens. Reading every watched repository's labels up front was 320+ requests
   * on an 80-repo workspace, spent before anybody clicked anything.
   *
   * Idempotent per scope: asking twice for the same repositories is free.
   */
  loadGithubSuggestions: (repos: string[]) => void;
}

export function useWorkflows(): UseWorkflows {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const setEnabledWorkflowCount = useWorkspaceStore((s) => s.setEnabledWorkflowCount);
  const [workflows, setWorkflows] = useState<WorkflowWithStats[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveRuns, setLiveRuns] = useState<Record<string, WorkflowRun[]>>({});
  const [suggestions, setSuggestions] = useState<WorkflowSuggestions | null>(null);
  // Which scopes have already been asked for, so re-focusing a field costs
  // nothing. Keyed by the sorted repo list — a different scope is a different
  // question.
  const askedRef = useRef<Set<string>>(new Set());

  // Guards a response from a workspace the user has already switched away from.
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;

  const load = useCallback(() => {
    if (!workspaceId) {
      setWorkflows(null);
      return;
    }
    api.workflows
      .list(workspaceId)
      .then((rows) => {
        if (workspaceRef.current !== workspaceId) return;
        setWorkflows(rows);
        setError(null);
      })
      .catch((err: unknown) => {
        if (workspaceRef.current !== workspaceId) return;
        setWorkflows([]);
        setError(err instanceof Error ? err.message : 'Could not load workflows');
      });
  }, [workspaceId]);

  useEffect(() => {
    setWorkflows(null);
    setLiveRuns({});
    load();
  }, [load]);

  // Keep the sidebar's Workflows badge in step with this page.
  //
  // `useSystemStatus` seeds the same store value from a lean count endpoint, so
  // the badge is right for somebody who never opens this screen. While the
  // screen IS open its list is the fresher truth — including the optimistic
  // `setEnabled` toggle — so it writes through here and the badge moves with
  // the switch instead of waiting on a round trip.
  //
  // `null` is still loading, never "none": writing 0 there would blank a badge
  // that is about to come back.
  useEffect(() => {
    if (!workflows) return;
    setEnabledWorkflowCount(workflows.filter((w) => w.enabled).length);
  }, [workflows, setEnabledWorkflowCount]);

  // The cheap half, once per workspace: repositories and their default branches,
  // read from our own rows. No GitHub request, so this cannot fail in a way the
  // user would notice and costs nothing to do on mount.
  useEffect(() => {
    if (!workspaceId) {
      setSuggestions(null);
      return;
    }
    let cancelled = false;
    setSuggestions(null);
    askedRef.current = new Set();
    api.workflows
      .suggestions(workspaceId)
      .then((s) => {
        if (!cancelled) setSuggestions(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const loadGithubSuggestions = useCallback(
    (repos: string[]) => {
      if (!workspaceId) return;
      const key = [...repos].map((r) => r.toLowerCase()).sort().join(',');
      if (askedRef.current.has(key)) return;
      askedRef.current.add(key);
      api.workflows
        .suggestions(workspaceId, { repos, github: true })
        .then((next) =>
          // Merged, not replaced: a narrower scope asked for later must not drop
          // the labels a wider one already found, and the repo/branch lists are
          // the same either way.
          setSuggestions((prev) =>
            prev
              ? {
                  ...next,
                  labels: [...new Set([...prev.labels, ...next.labels])].sort(),
                  people: [
                    ...new Map(
                      [...prev.people, ...next.people].map((p) => [p.login, p])
                    ).values(),
                  ],
                  teams: [...new Set([...prev.teams, ...next.teams])].sort(),
                }
              : next
          )
        )
        .catch(() => {
          // Let it be asked again: a transient failure should not leave the
          // field permanently empty for the rest of the session.
          askedRef.current.delete(key);
        });
    },
    [workspaceId]
  );

  // A finished run changes both the history and the derived stats, and the stats
  // are aggregated server-side — so the event prepends the run locally (instant)
  // and re-lists to pick up the recomputed counters.
  useEffect(() => {
    return api.ws.on('workflow:run', (payload) => {
      const run = payload as WorkflowRun;
      if (!run?.workflowId) return;
      setLiveRuns((prev) => {
        const existing = prev[run.workflowId] ?? [];
        if (existing.some((r) => r.id === run.id)) return prev;
        return { ...prev, [run.workflowId]: [run, ...existing].slice(0, 50) };
      });
      load();
    });
  }, [load]);

  useOnReconnect(load);

  const create = useCallback(
    async (input: WorkflowInput) => {
      if (!workspaceId) return;
      const made = await api.workflows.create(workspaceId, input);
      setWorkflows((prev) => [made, ...(prev ?? [])]);
    },
    [workspaceId]
  );

  const update = useCallback(async (id: string, input: WorkflowInput) => {
    const next = await api.workflows.update(id, input);
    setWorkflows((prev) => (prev ?? []).map((w) => (w.id === id ? next : w)));
  }, []);

  const remove = useCallback(async (id: string) => {
    await api.workflows.remove(id);
    setWorkflows((prev) => (prev ?? []).filter((w) => w.id !== id));
  }, []);

  /**
   * The on/off switch. Sends the whole definition, because PATCH is a
   * whole-workflow replace — the trigger, conditions and actions validate
   * against each other, so a one-field merge could land a combination the
   * validator would refuse.
   */
  const setEnabled = useCallback(
    async (workflow: WorkflowWithStats, enabled: boolean) => {
      // Optimistic: the switch must feel like a switch. Rolled back by the
      // caller's error handling via a reload.
      setWorkflows((prev) =>
        (prev ?? []).map((w) => (w.id === workflow.id ? { ...w, enabled } : w))
      );
      try {
        const next = await api.workflows.update(workflow.id, {
          name: workflow.name,
          enabled,
          events: workflow.events,
          conditions: workflow.conditions,
          actions: workflow.actions,
          maxRunsPerPrPerHour: workflow.maxRunsPerPrPerHour,
        });
        setWorkflows((prev) => (prev ?? []).map((w) => (w.id === next.id ? next : w)));
      } catch (err) {
        load();
        throw err;
      }
    },
    [load]
  );

  return useMemo(
    () => ({
      workflows,
      error,
      reload: load,
      create,
      update,
      remove,
      setEnabled,
      liveRuns,
      suggestions,
      loadGithubSuggestions,
    }),
    [
      workflows,
      error,
      load,
      create,
      update,
      remove,
      setEnabled,
      liveRuns,
      suggestions,
      loadGithubSuggestions,
    ]
  );
}

/**
 * One workflow's run history, paged.
 *
 * Seeded from the API and topped up by the live `workflow:run` events the page
 * hook already collects, so an open history list grows as runs land instead of
 * needing a refresh.
 */
export function useWorkflowRuns(
  workflowId: string | null,
  live: WorkflowRun[] | undefined
): { runs: WorkflowRun[]; loading: boolean; error: string | null; loadMore: () => void; hasMore: boolean } {
  const [fetched, setFetched] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const PAGE = 25;

  const fetchPage = useCallback(
    (cursor: string | null) => {
      if (!workflowId) return;
      setLoading(true);
      api.workflows
        .runs(workflowId, { limit: PAGE, cursor })
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
    [workflowId]
  );

  useEffect(() => {
    setFetched([]);
    setHasMore(false);
    if (workflowId) fetchPage(null);
  }, [workflowId, fetchPage]);

  const runs = useMemo(() => {
    // De-duplicate by id: a run can arrive both ways when the WS event lands
    // between the fetch being issued and its response.
    const seen = new Set<string>();
    const out: WorkflowRun[] = [];
    for (const run of [...(live ?? []), ...fetched]) {
      if (seen.has(run.id)) continue;
      seen.add(run.id);
      out.push(run);
    }
    return out;
  }, [live, fetched]);

  const loadMore = useCallback(() => {
    const last = fetched[fetched.length - 1];
    if (last) fetchPage(last.createdAt);
  }, [fetched, fetchPage]);

  return { runs, loading, error, loadMore, hasMore };
}
