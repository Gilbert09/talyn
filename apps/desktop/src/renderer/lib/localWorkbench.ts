import {
  checkpointCreateSteps,
  DEFAULT_WORKBENCH_EFFORT,
  pickWorkbenchName,
  withSeq,
  workbenchNameFromTask,
  type AgentEventDraft,
  type SendWorkbenchMessageInput,
  type Workbench,
  type WorkbenchAgent,
  type WorkbenchChat,
  type WorkbenchEvent,
  type WorkbenchLocalBridge,
  type WorkbenchQueuedMessage,
  type WorkbenchTurnOutcome,
} from '@talyn/shared';
import { api } from './api';
import { getDeviceId, getWorkbenchBridge, newClientId } from './workbenchBridge';
import { ensureChatHistory } from './workbenchData';
import { makeUserMessageEvent } from './workbenchFormat';
import { lastSeq, lastTurn, useWorkbenchStore } from '../stores/workbenches';

/**
 * The local runtime, driven from the renderer.
 *
 * The Electron main process owns the processes (the agent CLI, git, the
 * terminals); the backend owns the rows. This module is the glue: it numbers
 * the bridge's unsequenced events, keeps them in the store, uploads them in
 * batches, reports the chat's status and session id, and queues messages sent
 * while a turn runs — exactly what the backend does for a sandbox.
 */

/** Upload cadence. One request a second keeps a busy turn to a handful of writes. */
export const LOCAL_UPLOAD_INTERVAL_MS = 1000;

type WorkbenchApi = Pick<typeof api.workbenches, 'uploadLocalEvents' | 'updateLocalChat'>;

export interface LocalControllerDeps {
  bridge: WorkbenchLocalBridge;
  api: WorkbenchApi;
  /** Load a chat's stored history before numbering new events after it. */
  loadHistory: (chatId: string) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface RunningTurn {
  workbenchId: string;
  turn: number;
}

export class LocalTurnController {
  private readonly deps: LocalControllerDeps;
  private readonly nextSeq = new Map<string, number>();
  private readonly running = new Map<string, RunningTurn>();
  private readonly reportedSession = new Map<string, string>();
  private pending = new Map<string, WorkbenchEvent[]>();
  private uploadTimer: unknown = null;
  private unsubscribers: Array<() => void> = [];

  constructor(deps: LocalControllerDeps) {
    this.deps = deps;
  }

  /** Subscribe to the bridge's turn and script streams. Returns the teardown. */
  start(): () => void {
    const { bridge } = this.deps;
    this.unsubscribers.push(
      bridge.onTurnEvent((frame) => this.handleTurnEvent(frame.chatId, frame.turn, frame.event)),
      bridge.onTurnEnd((frame) => void this.handleTurnEnd(frame.chatId, frame)),
      bridge.scripts.onFrame((frame) => useWorkbenchStore.getState().appendScriptFrame(frame))
    );
    return () => this.stop();
  }

  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    void this.flush();
  }

  isRunning(chatId: string): boolean {
    return this.running.has(chatId);
  }

  /** The next seq for a chat, continuing from the highest one held. */
  allocateSeq(chatId: string): number {
    const held = lastSeq(useWorkbenchStore.getState().chatEvents[chatId]?.events ?? []);
    const next = Math.max(this.nextSeq.get(chatId) ?? 1, held + 1);
    this.nextSeq.set(chatId, next + 1);
    return next;
  }

  /** Number one event, keep it, and queue it for upload. */
  record(chatId: string, turn: number, draft: AgentEventDraft): WorkbenchEvent {
    const seq = this.allocateSeq(chatId);
    const event: WorkbenchEvent = { chatId, seq, turn, event: withSeq(draft, seq) };
    useWorkbenchStore.getState().appendEvents(chatId, [event]);
    const list = this.pending.get(chatId);
    if (list) list.push(event);
    else this.pending.set(chatId, [event]);
    this.scheduleUpload();
    return event;
  }

  private scheduleUpload(): void {
    if (this.uploadTimer !== null) return;
    const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.uploadTimer = setTimer(() => {
      this.uploadTimer = null;
      void this.flush();
    }, LOCAL_UPLOAD_INTERVAL_MS);
  }

  /**
   * Upload every pending event. A failed batch goes back to the FRONT of the
   * chat's queue and is retried on the next tick: the backend de-duplicates on
   * `(chat_id, seq)`, so a retry of a batch that did land is harmless.
   */
  async flush(chatId?: string): Promise<void> {
    const batch = this.pending;
    if (chatId) {
      const one = batch.get(chatId);
      if (!one?.length) return;
      batch.delete(chatId);
      await this.uploadOne(chatId, one);
      return;
    }
    this.pending = new Map();
    if (this.uploadTimer !== null) {
      (this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.uploadTimer);
      this.uploadTimer = null;
    }
    await Promise.all([...batch].map(([id, events]) => this.uploadOne(id, events)));
  }

  private async uploadOne(chatId: string, events: WorkbenchEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.deps.api.uploadLocalEvents(chatId, events);
    } catch {
      const later = this.pending.get(chatId) ?? [];
      this.pending.set(chatId, [...events, ...later]);
      this.scheduleUpload();
    }
  }

  /** Send a message: run it now, or queue it behind the running turn. */
  async send(workbench: Workbench, chat: WorkbenchChat, input: SendWorkbenchMessageInput): Promise<{ queued: boolean }> {
    await this.deps.loadHistory(chat.id);
    // This device's controller is the authority on whether ITS turn runs. The
    // row's `running` can be stale after a reload, and trusting it would queue
    // every message behind a turn that no longer exists.
    if (this.running.has(chat.id)) {
      const queued: WorkbenchQueuedMessage = {
        id: newClientId(),
        text: input.text,
        attachments: input.attachments,
        planMode: input.planMode,
        model: input.model,
        effort: input.effort,
        queuedAt: new Date().toISOString(),
      };
      useWorkbenchStore.getState().enqueueLocal(chat.id, queued);
      return { queued: true };
    }
    await this.startTurn(workbench, chat, input);
    return { queued: false };
  }

  private async startTurn(workbench: Workbench, chat: WorkbenchChat, input: SendWorkbenchMessageInput): Promise<void> {
    const path = workbench.localPath;
    if (!path) throw new Error('This session has no local path.');
    const events = useWorkbenchStore.getState().chatEvents[chat.id]?.events ?? [];
    const turn = Math.max(lastTurn(events), this.running.get(chat.id)?.turn ?? 0) + 1;
    this.running.set(chat.id, { workbenchId: workbench.id, turn });
    this.setStatus(chat, 'running');

    await this.checkpoint(path, chat.id, turn);
    this.record(chat.id, turn, makeUserMessageEvent(input.text, input.attachments));
    void this.report(chat.id, { status: 'running' });

    const prompt = withAttachmentNote(input.text, input.attachments);
    try {
      await this.deps.bridge.startTurn({
        workbenchId: workbench.id,
        chatId: chat.id,
        turn,
        path,
        agent: chat.agent,
        prompt,
        model: input.model ?? chat.model ?? undefined,
        effort: input.effort ?? chat.effort ?? DEFAULT_WORKBENCH_EFFORT,
        planMode: input.planMode ?? chat.planMode,
        resumeSessionId: chat.agentSessionId ?? undefined,
        attachments: input.attachments,
      });
    } catch (err) {
      this.record(chat.id, turn, {
        type: 'system',
        subtype: 'spawn_error',
        text: err instanceof Error ? err.message : 'The agent could not start.',
      } as AgentEventDraft);
      await this.handleTurnEnd(chat.id, {
        sessionId: chat.agentSessionId,
        isError: true,
        resultText: '',
        cancelled: false,
      });
    }
  }

  /** Snapshot the tree before the turn, so "revert to here" has something to restore. Best-effort. */
  private async checkpoint(path: string, chatId: string, turn: number): Promise<void> {
    try {
      const gitDir = await this.deps.bridge.exec(path, [{ argv: ['git', 'rev-parse', '--absolute-git-dir'] }]);
      if (gitDir.exitCode !== 0 || !gitDir.stdout.trim()) return;
      const tmpIndexPath = `${gitDir.stdout.trim()}/talyn-checkpoint-index`;
      await this.deps.bridge.exec(path, checkpointCreateSteps({ chatId, turn, tmpIndexPath }));
    } catch {
      // A repository with no commit yet cannot checkpoint; the turn still runs.
    }
  }

  handleTurnEvent(chatId: string, turn: number, draft: AgentEventDraft): void {
    this.record(chatId, turn, draft);
    const sessionId = typeof draft.session_id === 'string' ? draft.session_id : null;
    if (sessionId && this.reportedSession.get(chatId) !== sessionId) {
      this.reportedSession.set(chatId, sessionId);
      void this.report(chatId, { status: 'running', agentSessionId: sessionId });
    }
  }

  async handleTurnEnd(chatId: string, outcome: WorkbenchTurnOutcome): Promise<void> {
    const wasRunning = this.running.get(chatId);
    this.running.delete(chatId);
    const errorText = outcome.resultText?.trim();
    if (outcome.isError && !outcome.cancelled && errorText && wasRunning) {
      // Runs before the flush, so the explanation uploads with the turn's other events.
      this.record(chatId, wasRunning.turn, {
        type: 'system',
        subtype: 'error',
        text: errorText.slice(-2000),
      } as AgentEventDraft);
    }
    await this.flush(chatId);
    const status = outcome.isError && !outcome.cancelled ? 'error' : 'idle';
    const chat = findChat(chatId);
    if (chat) this.setStatus({ ...chat, agentSessionId: outcome.sessionId ?? chat.agentSessionId }, status);
    await this.report(chatId, { status, agentSessionId: outcome.sessionId ?? undefined });

    const next = useWorkbenchStore.getState().dequeueLocal(chatId);
    if (!next) return;
    const workbenchId = wasRunning?.workbenchId ?? chat?.workbenchId;
    const workbench = workbenchId ? useWorkbenchStore.getState().workbenches[workbenchId] : undefined;
    const fresh = findChat(chatId);
    if (!workbench || !fresh) return;
    await this.startTurn(workbench, { ...fresh, status: 'idle' }, next);
  }

  async cancel(chatId: string): Promise<void> {
    await this.deps.bridge.cancelTurn(chatId);
  }

  private setStatus(chat: WorkbenchChat, status: WorkbenchChat['status']): void {
    useWorkbenchStore.getState().upsertChat({ ...chat, status, updatedAt: new Date().toISOString() });
  }

  private async report(chatId: string, input: Parameters<WorkbenchApi['updateLocalChat']>[1]): Promise<void> {
    try {
      const updated = await this.deps.api.updateLocalChat(chatId, input);
      // The row is the backend's, but a stale reply must not undo a newer local status.
      const local = findChat(chatId);
      if (updated && (!local || local.status === updated.status)) useWorkbenchStore.getState().upsertChat(updated);
    } catch {
      // The events are what matter; the status is re-reported at the end of the turn.
    }
  }
}

function findChat(chatId: string): WorkbenchChat | undefined {
  const { chats } = useWorkbenchStore.getState();
  for (const list of Object.values(chats)) {
    const hit = list.find((c) => c.id === chatId);
    if (hit) return hit;
  }
  return undefined;
}

function withAttachmentNote(text: string, attachments: SendWorkbenchMessageInput['attachments']): string {
  const paths = (attachments ?? []).map((a) => a.path).filter((p): p is string => Boolean(p));
  if (paths.length === 0) return text;
  return `${text}\n\nAttached files (in the working tree): ${paths.map((p) => `\`${p}\``).join(', ')}`;
}

let controller: LocalTurnController | null = null;

/** The app-wide controller, or null when this build has no local bridge. */
export function getLocalController(): LocalTurnController | null {
  if (controller) return controller;
  const bridge = getWorkbenchBridge();
  if (!bridge) return null;
  controller = new LocalTurnController({
    bridge,
    api: api.workbenches,
    loadHistory: (chatId) => ensureChatHistory(chatId),
  });
  controller.start();
  return controller;
}

// ============================================================================
// Creating a local workbench
// ============================================================================

export interface CreateLocalWorkbenchInput {
  workspaceId: string;
  repositoryId: string;
  repoFullName: string;
  agent: WorkbenchAgent;
  model?: string;
  baseBranch?: string;
  /** An existing branch (from a PR). Absent: a new branch named after the workbench. */
  branch?: string;
  fromPullRequestId?: string;
  /** An existing local clone. Absent: the main process clones it. */
  repoPath?: string;
  takenNames: string[];
  /** The first message. Names the workbench; it is sent by the caller once the chat exists. */
  prompt?: string;
}

/**
 * `git worktree add` on this machine, then the row. The worktree comes first
 * because the row records its path; a worktree with no row is a directory the
 * next attempt can reuse, while a row with no worktree is a broken workbench.
 */
export async function createLocalWorkbench(input: CreateLocalWorkbenchInput): Promise<Workbench> {
  const bridge = getWorkbenchBridge();
  if (!bridge) throw new Error('Local sessions need the Talyn desktop app.');
  const name = input.prompt?.trim()
    ? workbenchNameFromTask(input.prompt, input.takenNames)
    : pickWorkbenchName(input.takenNames);
  const branch = input.branch ?? name;
  const baseBranch = input.baseBranch || (await detectDefaultBranch(bridge, input.repoPath)) || 'main';
  const { path } = await bridge.createWorktree({
    repoPath: input.repoPath,
    cloneUrl: input.repoPath ? undefined : `https://github.com/${input.repoFullName}.git`,
    workbenchId: newClientId(),
    name,
    branch,
    baseBranch,
  });
  return api.workbenches.create({
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    runtime: 'local',
    agent: input.agent,
    model: input.model,
    baseBranch,
    branch,
    name,
    fromPullRequestId: input.fromPullRequestId,
    // No `prompt`: the backend cannot run a local turn. The caller sends the
    // first message through the controller once the chat exists.
    deviceId: getDeviceId(),
    localPath: path,
  });
}

async function detectDefaultBranch(bridge: WorkbenchLocalBridge, repoPath?: string): Promise<string | null> {
  if (!repoPath) return null;
  try {
    const res = await bridge.exec(repoPath, [{ argv: ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'] }]);
    if (res.exitCode !== 0) return null;
    return res.stdout.trim().replace(/^origin\//, '') || null;
  } catch {
    return null;
  }
}
