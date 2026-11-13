import { useCallback, useState } from 'react';
import { DEFAULT_WORKBENCH_EFFORT, type SendWorkbenchMessageInput, type Workbench, type WorkbenchAgent, type WorkbenchAttachment, type WorkbenchEffort, type WorkbenchRuntimeKind } from '@talyn/shared';
import { api } from '../../../lib/api';
import { createLocalWorkbench } from '../../../lib/localWorkbench';
import { opsFor } from '../../../lib/workbenchOps';
import { toast } from '../../../stores/toast';
import { maybeHandleBillingLimit } from '../../../stores/billing';
import { useNavigationStore } from '../../../stores/navigation';
import { useWorkbenchStore } from '../../../stores/workbenches';
import { useWorkspaceStore } from '../../../stores/workspace';
import { trackEvent } from '../../../lib/analytics';
import { captureWorkbenchFailure } from '../../../lib/workbenchAnalytics';
import { sendFailureText } from '../../../lib/workbenchFormat';

export interface NewWorkbenchSpec {
  workspaceId: string;
  kind?: 'session' | 'thread';
  repositoryId?: string;
  repoFullName?: string;
  runtime: WorkbenchRuntimeKind;
  agent: WorkbenchAgent;
  model: string;
  effort: WorkbenchEffort;
  planMode: boolean;
  internetAccess: boolean;
  autoCreatePr?: boolean;
  /** The first message. Empty creates the workbench with nothing to do yet. */
  prompt: string;
  attachments?: WorkbenchAttachment[];
  /**
   * Start it in this space. It runs in my home workspace for the space's
   * team (`workspaceId`), and the space takes the repository by its full name.
   */
  spaceId?: string;
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
      trackEvent('session_created', { kind: wb.kind ?? 'session', runtime: wb.runtime, repository_id: wb.repositoryId, size: wb.settings.sandboxSize ?? wb.settings.boxSize ?? 'default' });
      if (spec.prompt.trim() && !spec.attachments?.length && spec.runtime !== 'local') {
        trackEvent('session_message_sent', { queued: true, plan_mode: spec.planMode, model_id: spec.model, attachments_count: 0 });
      }
      const store = useWorkbenchStore.getState();
      // A space session can run in a workspace other than the one shown.
      if (!spec.spaceId || store.workspaceId === wb.workspaceId) store.upsertWorkbench(wb);
      else store.addExtraWorkbench(wb);
      // The session opens with the prompt already in its chat, not an empty
      // one: the prompt's own event comes only when the sandbox starts the turn.
      const firstChat = wb.chats?.[0];
      // A sandbox prompt without images went with the create request, so it is already sent.
      const alreadySent = spec.runtime !== 'local' && !spec.attachments?.length;
      const pending: PendingFirstMessage | null = firstChat && spec.prompt.trim()
        ? { chatId: firstChat.id, id: store.addOutgoingMessage(firstChat.id, { text: spec.prompt.trim(), attachments: spec.attachments, settled: alreadySent }) }
        : null;
      useNavigationStore.getState().navigate({ view: 'workbench', id: wb.id });
      if (spec.runtime === 'local') void startLocalChat(wb, spec, pending);
      else if (spec.attachments?.length) {
        const firstInput: SendWorkbenchMessageInput = {
          text: spec.prompt.trim(), attachments: spec.attachments,
          model: spec.model, effort: spec.effort, planMode: spec.planMode,
        };
        try {
          const chat = firstChat ?? await api.workbenches.createChat(wb.id, { model: spec.model, effort: spec.effort, planMode: spec.planMode });
          const sent = await api.workbenches.sendMessage(chat.id, firstInput);
          if (pending) useWorkbenchStore.getState().settleOutgoingMessage(pending.chatId, pending.id);
          trackEvent('session_message_sent', { queued: sent.queued, plan_mode: spec.planMode, model_id: spec.model, attachments_count: spec.attachments.length });
        } catch (err) {
          captureWorkbenchFailure('send_first_message', err, wb.id);
          if (maybeHandleBillingLimit(err, 'workbench_send')) {
            if (pending) useWorkbenchStore.getState().removeOutgoingMessages(pending.chatId, [pending.id]);
            return wb;
          }
          // The prompt stays in the new chat with the error and a Retry action.
          if (pending) useWorkbenchStore.getState().failOutgoingMessage(pending.chatId, pending.id, { error: sendFailureText(err), input: firstInput });
          toast.error('The first message did not start', err instanceof Error ? err.message : undefined);
        }
      }
      return wb;
    } catch (err) {
      captureWorkbenchFailure('create_session', err);
      // A plan refusal also opens the upgrade modal; its sentence stays on the page.
      maybeHandleBillingLimit(err, spec.kind === 'thread' ? 'thread_create' : 'workbench_create');
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
  if (spec.spaceId) return createInSpace(spec.spaceId, spec, prompt);
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
      branchPrefix: useWorkspaceStore.getState().workspaces.find((w) => w.id === spec.workspaceId)?.settings?.sessionBranchPrefix,
      prompt,
      autoCreatePr: spec.autoCreatePr ?? true,
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
    prompt: spec.attachments?.length ? undefined : prompt || undefined,
    namingText: namingTextFor(spec, prompt),
    internetAccess: spec.internetAccess,
    autoCreatePr: spec.autoCreatePr ?? true,
  });
  await applyFirstChatSettings(wb, spec);
  return wb;
}

/** The same session or thread, started in a space by the space's create route. */
async function createInSpace(spaceId: string, spec: NewWorkbenchSpec, prompt: string): Promise<Workbench> {
  const shared = {
    agent: spec.agent,
    model: spec.model,
    prompt: spec.attachments?.length ? undefined : prompt || undefined,
    namingText: namingTextFor(spec, prompt),
    internetAccess: spec.internetAccess,
  };
  if (spec.kind === 'thread') {
    return (await api.spaces.createSession(spaceId, { kind: 'thread', ...shared })).workbench;
  }
  if (!spec.repoFullName) throw new Error('Choose a repository.');
  const { workbench } = await api.spaces.createSession(spaceId, {
    repoFullName: spec.repoFullName,
    ...shared,
    baseBranch: spec.baseBranch?.trim() || undefined,
    branch: spec.branch?.trim() || undefined,
    fromPullRequestId: spec.fromPullRequestId,
    autoCreatePr: spec.autoCreatePr ?? true,
  });
  await applyFirstChatSettings(workbench, spec);
  return workbench;
}

/**
 * The queued first message takes the chat's plan mode and effort when it
 * runs, and the box takes far longer to boot than this one request.
 */
async function applyFirstChatSettings(wb: Workbench, spec: NewWorkbenchSpec): Promise<void> {
  const chat = wb.chats?.[0];
  if (chat && (spec.planMode || spec.effort !== DEFAULT_WORKBENCH_EFFORT)) {
    await api.workbenches
      .updateChat(chat.id, { planMode: spec.planMode, effort: spec.effort })
      .then((updated) => useWorkbenchStore.getState().upsertChat(updated))
      .catch((error) => captureWorkbenchFailure('update_first_chat', error, wb.id));
  }
}

/** The first prompt, as the new session's transcript shows it before its event arrives. */
interface PendingFirstMessage {
  chatId: string;
  id: string;
}

/** A new local workbench's first chat, and its first message when one was given. */
async function startLocalChat(wb: Workbench, spec: NewWorkbenchSpec, pending: PendingFirstMessage | null): Promise<void> {
  const prompt = spec.prompt.trim();
  const { effort } = spec;
  try {
    // The create route already inserted the first chat; a second would be a duplicate "Chat" tab.
    let chat = wb.chats?.[0] ?? (await api.workbenches.createChat(wb.id, { model: spec.model, effort, planMode: spec.planMode }));
    if (wb.chats?.[0] && (spec.planMode || effort !== DEFAULT_WORKBENCH_EFFORT)) {
      chat = await api.workbenches.updateChat(chat.id, { planMode: spec.planMode, effort: spec.effort }).catch((error) => {
        captureWorkbenchFailure('update_first_chat', error, wb.id);
        return chat;
      });
    }
    const store = useWorkbenchStore.getState();
    store.upsertChat(chat);
    store.setChatEventsState(chat.id, { loaded: true });
    store.selectChat(wb.id, chat.id);
    if (prompt) {
      const ops = opsFor(wb);
      const attachments = spec.attachments?.length
        ? await Promise.all(spec.attachments.map(async (attachment) => attachment.dataBase64
          ? ops.attach({ name: attachment.name, mimeType: attachment.mimeType, dataBase64: attachment.dataBase64 })
          : attachment))
        : undefined;
      const sent = await ops.send(chat, { text: prompt, attachments, model: spec.model, planMode: spec.planMode, effort });
      if (pending) useWorkbenchStore.getState().settleOutgoingMessage(pending.chatId, pending.id);
      trackEvent('session_message_sent', { queued: sent.queued, plan_mode: spec.planMode, model_id: spec.model, attachments_count: attachments?.length ?? 0 });
    }
  } catch (err) {
    if (pending) useWorkbenchStore.getState().removeOutgoingMessages(pending.chatId, [pending.id]);
    captureWorkbenchFailure('send_first_message', err, wb.id);
    toast.error('The first message did not start', err instanceof Error ? err.message : undefined);
  }
}

/**
 * A first message with attachments is sent after the create, so the create
 * has no prompt. The text still names the session, its branch and its chat.
 */
function namingTextFor(spec: NewWorkbenchSpec, prompt: string): string | undefined {
  return spec.attachments?.length && prompt ? prompt : undefined;
}
