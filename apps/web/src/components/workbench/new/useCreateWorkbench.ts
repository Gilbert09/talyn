import { useCallback, useState } from 'react';
import { DEFAULT_WORKBENCH_EFFORT, type Workbench, type WorkbenchAgent, type WorkbenchAttachment, type WorkbenchEffort } from '@talyn/shared';
import { api } from '../../../lib/api';
import { toast } from '../../../stores/toast';
import { useNavigationStore } from '../../../stores/navigation';
import { useWorkbenchStore } from '../../../stores/workbenches';

export interface NewWorkbenchSpec {
  workspaceId: string;
  repositoryId: string;
  repoFullName: string;
  agent: WorkbenchAgent;
  model: string;
  effort: WorkbenchEffort;
  planMode: boolean;
  internetAccess: boolean;
  autoCreatePr?: boolean;
  /** The first message. Empty creates the workbench with nothing to do yet. */
  prompt: string;
  attachments?: WorkbenchAttachment[];
  baseBranch?: string;
  /** An existing branch to check out instead of a new one. */
  branch?: string;
  fromPullRequestId?: string;
}

export interface CreateWorkbenchState {
  /** Create the workbench, open it, and start its first message. Null when it failed; `error` says why. */
  create: (spec: NewWorkbenchSpec) => Promise<Workbench | null>;
  busy: boolean;
  error: string | null;
  clearError: () => void;
}

/** Create a sandbox session and queue its first message. */
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
      if (spec.attachments?.length) {
        try {
          const chat = wb.chats?.[0] ?? await api.workbenches.createChat(wb.id, { model: spec.model, effort: spec.effort, planMode: spec.planMode });
          await api.workbenches.sendMessage(chat.id, {
            text: spec.prompt.trim(), attachments: spec.attachments,
            model: spec.model, effort: spec.effort, planMode: spec.planMode,
          });
        } catch (err) {
          toast.error('The session is ready, but the first message did not start', err instanceof Error ? err.message : undefined);
        }
      }
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

  const wb = await api.workbenches.create({
    workspaceId: spec.workspaceId,
    repositoryId: spec.repositoryId,
    runtime: 'sandbox',
    agent: spec.agent,
    model: spec.model,
    baseBranch,
    branch,
    fromPullRequestId: spec.fromPullRequestId,
    prompt: spec.attachments?.length ? undefined : prompt || undefined,
    internetAccess: spec.internetAccess,
    autoCreatePr: spec.autoCreatePr ?? true,
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
