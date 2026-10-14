import { useCallback, useState } from 'react';
import { DEFAULT_WORKBENCH_EFFORT, type Workbench, type WorkbenchAgent, type WorkbenchEffort, type WorkbenchRuntimeKind } from '@talyn/shared';
import { api } from '../../../lib/api';
import { createLocalWorkbench } from '../../../lib/localWorkbench';
import { opsFor } from '../../../lib/workbenchOps';
import { toast } from '../../../stores/toast';
import { useNavigationStore } from '../../../stores/navigation';
import { useWorkbenchStore } from '../../../stores/workbenches';

export interface NewWorkbenchSpec {
  workspaceId: string;
  repositoryId: string;
  repoFullName: string;
  runtime: WorkbenchRuntimeKind;
  agent: WorkbenchAgent;
  model: string;
  effort: WorkbenchEffort;
  planMode: boolean;
  /** The first message. Empty creates the workbench with nothing to do yet. */
  prompt: string;
  baseBranch?: string;
  /** An existing branch to check out instead of a new one. */
  branch?: string;
  fromPullRequestId?: string;
  /** Local only: this machine's checkout of the repository. */
  repoPath?: string | null;
}

export interface CreateWorkbenchState {
  /** Create the workbench, open it, and start its first message. Null when it failed; `error` says why. */
  create: (spec: NewWorkbenchSpec) => Promise<Workbench | null>;
  busy: boolean;
  error: string | null;
  clearError: () => void;
}

/**
 * Create a workbench and start it, for both runtimes.
 *
 * Sandbox: the backend creates the row and queues the first message on its
 * first chat; the box drains it once it boots. Local: the worktree is made on
 * this machine first, then the row, then the first message runs through the
 * local controller. Either way the app opens the new workbench at once, so
 * the provisioning progress shows there. A failure before the row exists
 * (a readiness refusal, a worktree error) stays on the caller's page.
 */
export function useCreateWorkbench(): CreateWorkbenchState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useCallback(async (spec: NewWorkbenchSpec): Promise<Workbench | null> => {
    setBusy(true);
    setError(null);
    try {
      const wb = await createWorkbench(spec);
      useWorkbenchStore.getState().upsertWorkbench(wb);
      useNavigationStore.getState().navigate({ view: 'workbench', id: wb.id });
      if (spec.runtime === 'local') void startLocalChat(wb, spec);
      return wb;
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not create the session.');
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return { create, busy, error, clearError };
}

async function createWorkbench(spec: NewWorkbenchSpec): Promise<Workbench> {
  const prompt = spec.prompt.trim();
  const baseBranch = spec.baseBranch?.trim() || undefined;
  const branch = spec.branch?.trim() || undefined;

  if (spec.runtime === 'local') {
    if (!spec.repoPath) throw new Error(`Choose the folder of your ${spec.repoFullName} checkout first.`);
    return createLocalWorkbench({
      workspaceId: spec.workspaceId,
      repositoryId: spec.repositoryId,
      repoFullName: spec.repoFullName,
      agent: spec.agent,
      model: spec.model,
      baseBranch,
      branch,
      fromPullRequestId: spec.fromPullRequestId,
      repoPath: spec.repoPath,
      takenNames: Object.values(useWorkbenchStore.getState().workbenches).map((w) => w.name),
      prompt,
    });
  }

  const wb = await api.workbenches.create({
    workspaceId: spec.workspaceId,
    repositoryId: spec.repositoryId,
    runtime: 'sandbox',
    agent: spec.agent,
    model: spec.model,
    baseBranch,
    branch,
    fromPullRequestId: spec.fromPullRequestId,
    prompt: prompt || undefined,
  });
  // The queued first message takes the chat's plan mode and effort when it
  // runs, and the box takes far longer to boot than this one request.
  const chat = wb.chats?.[0];
  if (chat && (spec.planMode || spec.effort !== DEFAULT_WORKBENCH_EFFORT)) {
    await api.workbenches
      .updateChat(chat.id, { planMode: spec.planMode, effort: spec.effort })
      .then((updated) => useWorkbenchStore.getState().upsertChat(updated))
      .catch(() => {});
  }
  return wb;
}

/** A new local workbench's first chat, and its first message when one was given. */
async function startLocalChat(wb: Workbench, spec: NewWorkbenchSpec): Promise<void> {
  const prompt = spec.prompt.trim();
  const { effort } = spec;
  try {
    // The create route already inserted the first chat; a second would be a duplicate "Chat" tab.
    let chat = wb.chats?.[0] ?? (await api.workbenches.createChat(wb.id, { model: spec.model, effort, planMode: spec.planMode }));
    if (wb.chats?.[0] && (spec.planMode || effort !== DEFAULT_WORKBENCH_EFFORT)) {
      chat = await api.workbenches.updateChat(chat.id, { planMode: spec.planMode, effort: spec.effort }).catch(() => chat);
    }
    const store = useWorkbenchStore.getState();
    store.upsertChat(chat);
    store.setChatEventsState(chat.id, { loaded: true });
    store.selectChat(wb.id, chat.id);
    if (prompt) await opsFor(wb).send(chat, { text: prompt, model: spec.model, planMode: spec.planMode, effort });
  } catch (err) {
    toast.error('The session is ready, but the first message did not start', err instanceof Error ? err.message : undefined);
  }
}
