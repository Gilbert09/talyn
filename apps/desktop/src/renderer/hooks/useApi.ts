import { useEffect, useCallback } from 'react';
import { api, wsClient } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';
import type {
  AgentEvent,
  AgentStatusEvent,
  AgentOutputEvent,
  TaskStatusEvent,
  TaskOutputEvent,
  TaskUpdateEvent,
  TaskAgentStatusEvent,
  TaskEventBroadcast,
  InboxNewEvent,
  InboxUpdateEvent,
  EnvironmentStatusEvent,
  EnvironmentCreatedEvent,
  WorkspaceSettings,
} from '@fastowl/shared';

// ---------------------------------------------------------------------------
// task:event coalescing
//
// A running agent emits a `task:event` per stream-json event — during a
// turn that's dozens per second. The naive handler did an O(n) dedup +
// O(n log n) re-sort of the whole transcript AND triggered a full React
// re-render *per event*. On a long transcript that's O(n²) work plus a
// re-render storm, which is the single biggest source of the "task screen
// feels sluggish" complaint.
//
// Instead we buffer incoming events per task and flush once per frame:
// one merge, one store write, one re-render — no matter how many events
// arrived in that window. Append is the hot path (events almost always
// arrive in order), so we only re-sort when we actually detect an
// out-of-order seq.
// ---------------------------------------------------------------------------

let pendingTaskEvents = new Map<string, AgentEvent[]>();
let taskEventFlushTimer: number | null = null;

/**
 * Merge new events into a task's transcript in the store, deduping on `seq`
 * (reconnects/backfills can replay) and re-sorting only when seqs actually
 * arrive out of order. Shared by the live `task:event` flush and the
 * on-open transcript hydration (TaskTerminal). No-op if nothing changed.
 */
export function mergeTaskTranscript(taskId: string, incoming: AgentEvent[]): void {
  if (incoming.length === 0) return;
  const store = useWorkspaceStore.getState();
  const task = store.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const existing = task.transcript ?? [];
  const seen = new Set(existing.map((e) => e.seq));
  const merged = existing.slice();
  let changed = false;
  for (const ev of incoming) {
    if (seen.has(ev.seq)) continue; // reconnects can replay events
    seen.add(ev.seq);
    merged.push(ev);
    changed = true;
  }
  if (!changed) return;
  // Cheap ordered-check; only pay for a sort when seqs actually arrived
  // out of order (rare — happens across WS reconnects).
  let ordered = true;
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].seq < merged[i - 1].seq) {
      ordered = false;
      break;
    }
  }
  if (!ordered) merged.sort((a, b) => a.seq - b.seq);
  store.updateTask(taskId, { transcript: merged });
}

function flushTaskEvents() {
  taskEventFlushTimer = null;
  if (pendingTaskEvents.size === 0) return;
  // Swap the buffer for a fresh Map up front so events arriving mid-flush
  // queue cleanly for the next frame rather than being dropped. NOTE: this
  // must reassign, not `.clear()` — clearing the same Map `batch` points at
  // would empty it before we iterate and silently drop every event.
  const batch = pendingTaskEvents;
  pendingTaskEvents = new Map();

  for (const [taskId, incoming] of batch) {
    mergeTaskTranscript(taskId, incoming);
  }
}

function scheduleTaskEventFlush() {
  if (taskEventFlushTimer !== null) return;
  // ~1 frame. setTimeout (not rAF) so it still flushes when the window is
  // backgrounded — a continuous-build run shouldn't silently stall its
  // transcript just because the user tabbed away.
  taskEventFlushTimer = window.setTimeout(flushTaskEvents, 40);
}

/**
 * Hook to initialize API connection and real-time updates
 */
export function useApiConnection() {
  const {
    currentWorkspaceId,
    updateAgent,
    updateTask,
    addInboxItem,
    updateInboxItem,
    updateEnvironment,
    addEnvironment,
  } = useWorkspaceStore();

  // Connect to WebSocket on mount. `connect()` is async because it needs
  // to fetch the auth token before opening the socket.
  useEffect(() => {
    void wsClient.connect();
    return () => {
      wsClient.disconnect();
    };
  }, []);

  // Subscribe to current workspace
  useEffect(() => {
    if (currentWorkspaceId) {
      wsClient.subscribe(currentWorkspaceId);
      return () => {
        wsClient.unsubscribe(currentWorkspaceId);
      };
    }
  }, [currentWorkspaceId]);

  // Handle WebSocket events
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // Agent status updates
    unsubscribers.push(
      wsClient.on<AgentStatusEvent>('agent:status', (payload) => {
        updateAgent(payload.agentId, {
          status: payload.status,
          attention: payload.attention,
        });
      })
    );

    // Agent output updates
    unsubscribers.push(
      wsClient.on<AgentOutputEvent>('agent:output', (payload) => {
        // Get current output and append
        const store = useWorkspaceStore.getState();
        const agent = store.agents.find((a) => a.id === payload.agentId);
        if (agent) {
          const newOutput = payload.append
            ? agent.terminalOutput + payload.output
            : payload.output;
          updateAgent(payload.agentId, { terminalOutput: newOutput });
        }
      })
    );

    // Task deletions — single source of truth for dropping a task
    // from the local store. `useTaskActions.deleteTask` also calls
    // the store directly as an optimistic step, but this is the
    // authoritative signal (handles multi-client + scheduler-side
    // cleanups consistently).
    unsubscribers.push(
      wsClient.on<{ taskId: string }>('task:deleted', (payload) => {
        useWorkspaceStore.getState().removeTask(payload.taskId);
      })
    );

    // Task status updates
    unsubscribers.push(
      wsClient.on<TaskStatusEvent>('task:status', (payload) => {
        updateTask(payload.taskId, {
          status: payload.status,
          result: payload.result,
        });
      })
    );

    // Task output updates
    unsubscribers.push(
      wsClient.on<TaskOutputEvent>('task:output', (payload) => {
        const store = useWorkspaceStore.getState();
        const task = store.tasks.find((t) => t.id === payload.taskId);
        if (task) {
          const newOutput = payload.append
            ? (task.terminalOutput || '') + payload.output
            : payload.output;
          updateTask(payload.taskId, { terminalOutput: newOutput });
        }
      })
    );

    // Task agent status updates
    unsubscribers.push(
      wsClient.on<TaskAgentStatusEvent>('task:agent_status', (payload) => {
        updateTask(payload.taskId, {
          agentStatus: payload.status,
          agentAttention: payload.attention,
        });
      })
    );

    // Arbitrary task field updates — currently fires when the async
    // title refiner completes, but the shape is general.
    unsubscribers.push(
      wsClient.on<TaskUpdateEvent>('task:update', (payload) => {
        updateTask(payload.taskId, payload.updates);
      })
    );

    // Structured-renderer events (stream-json). Buffered per task and
    // flushed once per frame (see scheduleTaskEventFlush) — dedup on
    // `seq` and out-of-order resolution happen in the flush.
    unsubscribers.push(
      wsClient.on<TaskEventBroadcast>('task:event', (payload) => {
        const buf = pendingTaskEvents.get(payload.taskId);
        if (buf) buf.push(payload.event);
        else pendingTaskEvents.set(payload.taskId, [payload.event]);
        scheduleTaskEventFlush();
      })
    );

    // New inbox items
    unsubscribers.push(
      wsClient.on<InboxNewEvent>('inbox:new', (payload) => {
        addInboxItem(payload.item);
      })
    );

    // Inbox item updates (permissionInbox coalesces pending prompts
    // into one `agent_question` row and patches it as prompts resolve).
    unsubscribers.push(
      wsClient.on<InboxUpdateEvent>('inbox:update', (payload) => {
        updateInboxItem(payload.itemId, payload.updates);
      })
    );

    // Environment status updates
    unsubscribers.push(
      wsClient.on<EnvironmentStatusEvent>('environment:status', (payload) => {
        updateEnvironment(payload.environmentId, {
          status: payload.status,
          error: payload.error,
        });
      })
    );

    // New environments (e.g. PostHog Code auto-provisioned on integration
    // connect) — add to the store live so they appear without a restart.
    unsubscribers.push(
      wsClient.on<EnvironmentCreatedEvent>('environment:created', (payload) => {
        addEnvironment(payload.environment);
      })
    );

    return () => {
      unsubscribers.forEach((unsub) => unsub());
      // Drain any buffered transcript events before tearing down so a
      // teardown mid-burst doesn't drop the tail of a turn.
      if (taskEventFlushTimer !== null) {
        window.clearTimeout(taskEventFlushTimer);
        flushTaskEvents();
      }
    };
  }, [updateAgent, updateTask, addInboxItem, updateInboxItem, updateEnvironment, addEnvironment]);
}

/**
 * Hook to load initial data
 */
export function useInitialDataLoad() {
  const {
    currentWorkspaceId,
    setCurrentWorkspace,
    setWorkspaces,
    setEnvironments,
    setAgents,
    setTasks,
    setRepositories,
    setInboxItems,
  } = useWorkspaceStore();

  const loadData = useCallback(async () => {
    try {
      // Load workspaces and environments (global)
      let [workspaces, environments] = await Promise.all([
        api.workspaces.list(),
        api.environments.list(),
      ]);

      // If no workspaces exist, create a default one
      if (workspaces.length === 0) {
        console.log('No workspaces found, creating default workspace...');
        const defaultWorkspace = await api.workspaces.create({
          name: 'Default Workspace',
          description: 'Your first FastOwl workspace',
        });
        workspaces = [defaultWorkspace];
      }

      // Cloud-provider env markers are auto-provisioned by the backend
      // when a provider is connected (Settings → Integrations) — the
      // desktop never creates one.

      setWorkspaces(workspaces);
      setEnvironments(environments);

      // Auto-select first workspace if none selected
      let activeWorkspaceId = currentWorkspaceId;
      if (!activeWorkspaceId && workspaces.length > 0) {
        activeWorkspaceId = workspaces[0].id;
        setCurrentWorkspace(activeWorkspaceId);
        console.log('Auto-selected workspace:', workspaces[0].name);
      }

      // Load workspace-specific data
      if (activeWorkspaceId) {
        const [tasks, inboxItems, repositories] = await Promise.all([
          api.tasks.list({ workspaceId: activeWorkspaceId }),
          api.inbox.list({ workspaceId: activeWorkspaceId }),
          api.repositories.list(activeWorkspaceId).catch(() => []), // May not exist
        ]);

        setTasks(tasks);
        setInboxItems(inboxItems);
        setRepositories(repositories);
      }
    } catch (err) {
      console.error('Failed to load initial data:', err);
    }
  }, [
    currentWorkspaceId,
    setCurrentWorkspace,
    setWorkspaces,
    setEnvironments,
    setAgents,
    setTasks,
    setRepositories,
    setInboxItems,
  ]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  return { reload: loadData };
}

/**
 * Hook for agent actions
 */
export function useAgentActions() {
  const { addAgent, updateAgent, removeAgent } = useWorkspaceStore();

  const startAgent = useCallback(
    async (environmentId: string, workspaceId: string, prompt?: string) => {
      const agent = await api.agents.start({
        environmentId,
        workspaceId,
        prompt,
      });
      addAgent(agent);
      return agent;
    },
    [addAgent]
  );

  const sendInput = useCallback(async (agentId: string, input: string) => {
    await api.agents.sendInput(agentId, input);
  }, []);

  const stopAgent = useCallback(
    async (agentId: string) => {
      await api.agents.stop(agentId);
      updateAgent(agentId, { status: 'idle', attention: 'none' });
    },
    [updateAgent]
  );

  const deleteAgent = useCallback(
    async (agentId: string) => {
      await api.agents.delete(agentId);
      removeAgent(agentId);
    },
    [removeAgent]
  );

  return { startAgent, sendInput, stopAgent, deleteAgent };
}

/**
 * Hook for task actions
 */
export function useTaskActions() {
  const { addTask, updateTask, removeTask } = useWorkspaceStore();

  const createTask = useCallback(
    async (data: Parameters<typeof api.tasks.create>[0]) => {
      const task = await api.tasks.create(data);
      addTask(task);
      return task;
    },
    [addTask]
  );

  const updateTaskStatus = useCallback(
    async (taskId: string, status: string) => {
      const task = await api.tasks.update(taskId, { status: status as any });
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  const cancelTask = useCallback(
    async (taskId: string) => {
      const task = await api.tasks.update(taskId, { status: 'cancelled' as any });
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  const retryTask = useCallback(
    async (taskId: string) => {
      const task = await api.tasks.retry(taskId);
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  // Task execution control
  const startTask = useCallback(
    async (taskId: string) => {
      const task = await api.tasks.start(taskId);
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  const sendTaskInput = useCallback(async (taskId: string, input: string) => {
    await api.tasks.sendInput(taskId, input);
  }, []);

  const continueTask = useCallback(async (taskId: string, prompt: string) => {
    await api.tasks.continue(taskId, prompt);
  }, []);

  const stopTask = useCallback(
    async (taskId: string) => {
      const task = await api.tasks.stop(taskId);
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  const readyForReview = useCallback(
    async (taskId: string) => {
      const task = await api.tasks.readyForReview(taskId);
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  const approveTask = useCallback(
    async (taskId: string) => {
      const task = await api.tasks.approve(taskId);
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  const rejectTask = useCallback(
    async (taskId: string) => {
      const task = await api.tasks.reject(taskId);
      updateTask(taskId, task);
      return task;
    },
    [updateTask]
  );

  const deleteTask = useCallback(
    async (taskId: string) => {
      await api.tasks.delete(taskId);
      removeTask(taskId);
    },
    [removeTask]
  );

  return {
    createTask,
    updateTaskStatus,
    cancelTask,
    retryTask,
    startTask,
    sendTaskInput,
    continueTask,
    stopTask,
    readyForReview,
    approveTask,
    rejectTask,
    deleteTask,
  };
}

/**
 * Hook for inbox actions
 */
export function useInboxActions() {
  const { markInboxRead, markInboxActioned } = useWorkspaceStore();

  const markRead = useCallback(
    async (itemId: string) => {
      await api.inbox.markRead(itemId);
      markInboxRead(itemId);
    },
    [markInboxRead]
  );

  const markActioned = useCallback(
    async (itemId: string) => {
      await api.inbox.markActioned(itemId);
      markInboxActioned(itemId);
    },
    [markInboxActioned]
  );

  const snooze = useCallback(async (itemId: string, until: Date) => {
    await api.inbox.snooze(itemId, until.toISOString());
  }, []);

  return { markRead, markActioned, snooze };
}

/**
 * Hook for environment actions
 */
export function useEnvironmentActions() {
  const { setEnvironments } = useWorkspaceStore();

  const createEnvironment = useCallback(
    async (data: Parameters<typeof api.environments.create>[0]) => {
      const env = await api.environments.create(data);
      const envs = await api.environments.list();
      setEnvironments(envs);
      return env;
    },
    [setEnvironments]
  );

  const testConnection = useCallback(async (envId: string) => {
    return api.environments.test(envId);
  }, []);

  const deleteEnvironment = useCallback(
    async (envId: string) => {
      await api.environments.delete(envId);
      const envs = await api.environments.list();
      setEnvironments(envs);
    },
    [setEnvironments]
  );

  return { createEnvironment, testConnection, deleteEnvironment };
}

/**
 * Hook for workspace actions
 */
export function useWorkspaceActions() {
  const { setWorkspaces, currentWorkspaceId } = useWorkspaceStore();

  const createWorkspace = useCallback(
    async (data: Parameters<typeof api.workspaces.create>[0]) => {
      const workspace = await api.workspaces.create(data);
      const workspaces = await api.workspaces.list();
      setWorkspaces(workspaces);
      return workspace;
    },
    [setWorkspaces]
  );

  const updateWorkspace = useCallback(
    async (id: string, data: Parameters<typeof api.workspaces.update>[1]) => {
      const workspace = await api.workspaces.update(id, data);
      const workspaces = await api.workspaces.list();
      setWorkspaces(workspaces);
      return workspace;
    },
    [setWorkspaces]
  );

  const deleteWorkspace = useCallback(
    async (id: string) => {
      await api.workspaces.delete(id);
      const workspaces = await api.workspaces.list();
      setWorkspaces(workspaces);
    },
    [setWorkspaces]
  );

  const updateCurrentWorkspaceSettings = useCallback(
    async (settings: Partial<WorkspaceSettings>) => {
      if (!currentWorkspaceId) return null;
      // Cast is safe because backend merges partial settings with existing values
      const workspace = await api.workspaces.update(currentWorkspaceId, {
        settings: settings as WorkspaceSettings,
      });
      const workspaces = await api.workspaces.list();
      setWorkspaces(workspaces);
      return workspace;
    },
    [currentWorkspaceId, setWorkspaces]
  );

  /**
   * Re-fetch the workspace list. Callers trigger this after mutations
   * that change workspace *relations* (e.g., adding/removing a repo)
   * so derived UI like the sidebar's repo count stays in sync.
   */
  const refreshWorkspaces = useCallback(async () => {
    const workspaces = await api.workspaces.list();
    setWorkspaces(workspaces);
  }, [setWorkspaces]);

  return {
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    updateCurrentWorkspaceSettings,
    refreshWorkspaces,
  };
}
