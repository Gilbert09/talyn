import { useCallback, useState } from 'react';
import { DEFAULT_WORKBENCH_EFFORT, type Workbench, type WorkbenchAgent, type WorkbenchAttachment, type WorkbenchEffort } from '@talyn/shared';
import { api } from '../../../lib/api';
import { toast } from '../../../stores/toast';
import { useNavigationStore } from '../../../stores/navigation';
import { useWorkbenchStore } from '../../../stores/workbenches';
import { maybeHandleBillingLimit } from '../../../stores/billing';
import { trackEvent } from '../../../lib/analytics';
import { captureWorkbenchFailure } from '../../../lib/workbenchAnalytics';

export interface NewWorkbenchSpec {
  workspaceId: string;
  kind?: 'session' | 'thread';
  repositoryId?: string;
  repoFullName?: string;
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
      trackEvent('session_created', { kind: wb.kind ?? 'session', runtime: wb.runtime, repository_id: wb.repositoryId, size: wb.settings.sandboxSize ?? wb.settings.boxSize ?? 'default' });
      if (spec.prompt.trim() && !spec.attachments?.length) {
        trackEvent('session_message_sent', { queued: true, plan_mode: spec.planMode, model_id: spec.model, attachments_count: 0 });
      }
      const store = useWorkbenchStore.getState();
      store.upsertWorkbench(wb);
      // The session opens with the prompt already in its chat, not an empty
      // one: the prompt's own event comes only when the sandbox starts the turn.
      // A prompt without images went with the create request, so it is already sent.
      const firstChat = wb.chats?.[0];
      const pending = firstChat && spec.prompt.trim()
        ? { chatId: firstChat.id, id: store.addOutgoingMessage(firstChat.id, { text: spec.prompt.trim(), attachments: spec.attachments, settled: !spec.attachments?.length }) }
        : null;
      useNavigationStore.getState().navigate({ view: 'workbench', id: wb.id });
      if (spec.attachments?.length) {
        try {
          const chat = firstChat ?? await api.workbenches.createChat(wb.id, { model: spec.model, effort: spec.effort, planMode: spec.planMode });
          const sent = await api.workbenches.sendMessage(chat.id, {
            text: spec.prompt.trim(), attachments: spec.attachments,
            model: spec.model, effort: spec.effort, planMode: spec.planMode,
          });
          if (pending) useWorkbenchStore.getState().settleOutgoingMessage(pending.chatId, pending.id);
          trackEvent('session_message_sent', { queued: sent.queued, plan_mode: spec.planMode, model_id: spec.model, attachments_count: spec.attachments.length });
        } catch (err) {
          if (pending) useWorkbenchStore.getState().removeOutgoingMessages(pending.chatId, [pending.id]);
          captureWorkbenchFailure('send_first_message', err, wb.id);
          if (maybeHandleBillingLimit(err, 'session_first_message')) return wb;
          toast.error('The first message did not start', err instanceof Error ? err.message : undefined);
        }
      }
      return wb;
    } catch (err) {
      captureWorkbenchFailure('create_session', err);
      // A box refusal keeps its sentence on the page and opens the modal with the action.
      maybeHandleBillingLimit(err, spec.kind === 'thread' ? 'thread_create' : 'session_create');
      setError(err instanceof Error && err.message ? err.message : spec.kind === 'thread' ? 'Could not create the thread.' : 'Could not create the session.');
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
  if (spec.kind === 'thread') {
    return api.workbenches.create({
      workspaceId: spec.workspaceId,
      kind: 'thread',
      runtime: 'sandbox',
      agent: spec.agent,
      model: spec.model,
      prompt: spec.attachments?.length ? undefined : prompt || undefined,
      namingText: namingTextFor(spec, prompt),
      internetAccess: spec.internetAccess,
    });
  }
  if (!spec.repositoryId || !spec.repoFullName) throw new Error('Choose a repository.');
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
    namingText: namingTextFor(spec, prompt),
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
      .catch((error) => captureWorkbenchFailure('update_first_chat', error, wb.id));
  }
  return wb;
}

/**
 * A first message with attachments is sent after the create, so the create
 * has no prompt. The text still names the session, its branch and its chat.
 */
function namingTextFor(spec: NewWorkbenchSpec, prompt: string): string | undefined {
  return spec.attachments?.length && prompt ? prompt : undefined;
}
