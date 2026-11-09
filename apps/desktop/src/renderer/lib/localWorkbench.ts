import {
  checkpointCreateSteps,
  currentBranch,
  isValidBranchName,
  mergeBase,
  parseNulList,
  untrackedFiles,
  WORKBENCH_BRANCH_PROMPT_FILES_MAX,
  workbenchTurnPrompt,
  DEFAULT_WORKBENCH_EFFORT,
  parsePrDetails,
  parseAutoPrDetails,
  pickWorkbenchName,
  pullRequestOutcomeEvent,
  withSeq,
  workbenchBranchFromTask,
  workbenchNameFromTask,
  type AgentEventDraft,
  type NameWorkbenchBranchInput,
  type SendWorkbenchMessageInput,
  type Workbench,
  type WorkbenchAgent,
  type WorkbenchChat,
  type WorkbenchEvent,
  type PullRequestOutcome,
  type WorkbenchLocalBridge,
  type WorkbenchMessageIntent,
  type WorkbenchQueuedMessage,
  type WorkbenchTurnOutcome,
} from '@talyn/shared';
import { api } from './api';
import { getDeviceId, getWorkbenchBridge, newClientId } from './workbenchBridge';
import { ensureChatHistory } from './workbenchData';
import { makeUserMessageEvent } from './workbenchFormat';
import { adoptLocalPullRequest, openLocalPullRequest } from './localPullRequest';
import { toast } from '../stores/toast';
import { lastSeq, lastTurn, useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';

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

/** How long a turn that opens a PR waits for a better branch name before it pushes the old one. */
export const LOCAL_BRANCH_NAMING_DEADLINE_MS = 60_000;

type WorkbenchApi = Pick<typeof api.workbenches, 'uploadLocalEvents' | 'updateLocalChat' | 'createPullRequest'> &
  Partial<Pick<typeof api.workbenches, 'update' | 'adoptPullRequest' | 'nameBranch' | 'confirmBranchName' | 'removeQueuedMessage'>>;

export interface LocalControllerDeps {
  bridge: WorkbenchLocalBridge;
  api: WorkbenchApi;
  /** Load a chat's stored history before numbering new events after it. */
  loadHistory: (chatId: string) => Promise<void>;
  /**
   * The repository's Talyn instructions for `agent`: the text, null when none
   * apply, undefined when they could not be read (the files are then left alone).
   */
  repositoryInstructions?: (repositoryId: string, agent: WorkbenchAgent) => Promise<string | null | undefined>;
  /** The workspace override for Claude's commit co-author trailer. */
  claudeCoAuthoredBy?: (workspaceId: string) => boolean | undefined;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Overrides {@link LOCAL_BRANCH_NAMING_DEADLINE_MS}, for tests. */
  branchNamingDeadlineMs?: number;
  /** This computer's id. Defaults to {@link getDeviceId}. */
  deviceId?: () => string;
}

interface RunningTurn {
  workbenchId: string;
  turn: number;
  /** The message that started the turn, for the branch-name prompt. */
  text: string;
  intent?: WorkbenchMessageIntent;
  /** Set once the turn's pull request is under way, so a second end cannot open another. */
  pullRequestStarted?: boolean;
}

export class LocalTurnController {
  private readonly deps: LocalControllerDeps;
  private readonly nextSeq = new Map<string, number>();
  private readonly running = new Map<string, RunningTurn>();
  private readonly reportedSession = new Map<string, string>();
  /** Workbenches this controller has already asked a title for. One attempt each. */
  private readonly titled = new Set<string>();
  private pending = new Map<string, WorkbenchEvent[]>();
  private uploadTimer: unknown = null;
  private unsubscribers: Array<() => void> = [];
  /** Chats whose backend queue this controller is moving to this computer. */
  private readonly draining = new Set<string>();
  /** Chats this controller started a turn in. Their `running` is its own. */
  private readonly started = new Set<string>();

  constructor(deps: LocalControllerDeps) {
    this.deps = deps;
  }

  /** Subscribe to the bridge's turn and script streams. Returns the teardown. */
  start(): () => void {
    const { bridge } = this.deps;
    let chats = useWorkbenchStore.getState().chats;
    this.unsubscribers.push(
      bridge.onTurnEvent((frame) => this.handleTurnEvent(frame.chatId, frame.turn, frame.event)),
      bridge.onTurnEnd((frame) => void this.handleTurnEnd(frame.chatId, frame)),
      bridge.scripts.onFrame((frame) => useWorkbenchStore.getState().appendScriptFrame(frame)),
      // A chat arrives from a load or a broadcast; one with queued messages runs them here.
      useWorkbenchStore.subscribe((state) => {
        if (state.chats === chats) return;
        chats = state.chats;
        this.drainBackendQueues();
      })
    );
    this.drainBackendQueues();
    return () => this.stop();
  }

  /** Local sessions whose worktree is on this computer, with their chats. */
  private ownedChats(): Array<{ workbench: Workbench; chat: WorkbenchChat }> {
    const deviceId = (this.deps.deviceId ?? getDeviceId)();
    const { workbenches, chats } = useWorkbenchStore.getState();
    const owned: Array<{ workbench: Workbench; chat: WorkbenchChat }> = [];
    for (const workbench of Object.values(workbenches)) {
      if (workbench.runtime !== 'local' || workbench.deviceId !== deviceId || !workbench.localPath) continue;
      if (workbench.status === 'archived' || workbench.archivedAt) continue;
      for (const chat of chats[workbench.id] ?? []) owned.push({ workbench, chat });
    }
    return owned;
  }

  /**
   * After the sessions load. If the app quit or crashed during a turn, the
   * backend still shows the chat `running`, and nothing on this computer
   * will end it. Such a chat goes idle, with a note in its transcript. A
   * chat this controller started, or one with a turn process in main (a
   * reloaded window), is left alone.
   */
  async resetInterruptedTurns(): Promise<void> {
    const candidates = this.ownedChats().filter(
      ({ chat }) => chat.status === 'running' && !this.running.has(chat.id) && !this.started.has(chat.id)
    );
    if (!candidates.length) return;
    let live: Set<string>;
    try {
      live = new Set((await this.deps.bridge.runningTurns?.()) ?? []);
    } catch {
      // Main did not answer, so a live turn cannot be told from a dead one.
      return;
    }
    for (const { chat } of candidates) {
      if (live.has(chat.id) || this.running.has(chat.id) || this.started.has(chat.id)) continue;
      try {
        await this.deps.loadHistory(chat.id);
      } catch {
        continue;
      }
      if (this.running.has(chat.id) || this.started.has(chat.id)) continue;
      const turn = lastTurn(useWorkbenchStore.getState().chatEvents[chat.id]?.events ?? []);
      this.record(chat.id, turn, {
        type: 'system',
        subtype: 'local_turn_interrupted',
        text: 'The app quit during this turn.',
      } as AgentEventDraft);
      await this.flush(chat.id);
      const current = findChat(chat.id) ?? chat;
      if (current.status === 'running') this.setStatus(current, 'idle');
      await this.report(chat.id, { status: 'idle' });
    }
  }

  /**
   * The backend puts a message in a chat's queue when a session is made
   * with a first prompt, and only a sandbox drains that queue. For a local
   * chat this computer takes the messages off the backend, then sends them
   * like any other local message.
   */
  drainBackendQueues(): void {
    for (const { workbench, chat } of this.ownedChats()) {
      if (!chat.queuedMessages?.length || this.draining.has(chat.id)) continue;
      void this.drainBackendQueue(workbench, chat);
    }
  }

  private async drainBackendQueue(workbench: Workbench, chat: WorkbenchChat): Promise<void> {
    const remove = this.deps.api.removeQueuedMessage;
    if (!remove) return;
    this.draining.add(chat.id);
    const queued = [...chat.queuedMessages];
    try {
      // Off the backend first: a reload must not run a message twice.
      let latest = chat;
      for (const message of queued) latest = await remove(chat.id, message.id);
      useWorkbenchStore.getState().upsertChat(latest);
      for (const message of queued) {
        await this.send(workbench, findChat(chat.id) ?? latest, {
          text: message.text,
          attachments: message.attachments,
          planMode: message.planMode,
          model: message.model,
          effort: message.effort,
          intent: message.intent,
        });
      }
    } catch (err) {
      toast.error('A queued message did not start', err instanceof Error ? err.message : undefined);
    } finally {
      this.draining.delete(chat.id);
    }
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
    const event: WorkbenchEvent = { chatId, seq, turn, event: withSeq(draft, seq), createdAt: new Date().toISOString() };
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

  /**
   * The backend takes at most 1000 events and 2 MB per request. A busy turn
   * streams many partial events, and a short time offline can queue more
   * than that, so one upload is cut into chunks under both limits.
   */
  private async uploadOne(chatId: string, events: WorkbenchEvent[]): Promise<void> {
    const chunks = chunkEvents(events);
    for (let i = 0; i < chunks.length; i++) {
      try {
        await this.deps.api.uploadLocalEvents(chatId, chunks[i]);
      } catch (err) {
        const status = (err as { status?: unknown } | null)?.status;
        // One event the backend refuses for good must not block every later one.
        if (chunks[i].length === 1 && (status === 400 || status === 413)) {
          console.warn('[workbench] the backend refused a local event; it stays on this device only:', err);
          continue;
        }
        const later = this.pending.get(chatId) ?? [];
        this.pending.set(chatId, [...chunks.slice(i).flat(), ...later]);
        this.scheduleUpload();
        return;
      }
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
        intent: input.intent,
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
    this.started.add(chat.id);
    this.running.set(chat.id, { workbenchId: workbench.id, turn, text: input.text, intent: input.intent });
    this.setStatus(chat, 'running');

    await this.checkpoint(path, chat.id, turn);
    this.record(chat.id, turn, makeUserMessageEvent(input.text, input.attachments));
    void this.report(chat.id, { status: 'running' });
    if (turn === 1) void this.generateTitle(workbench, chat.agent, input.text);

    const text = withAttachmentNote(input.text, input.attachments);
    // The transcript keeps `input.text`; the hidden instructions reach the agent only.
    const planMode = input.planMode ?? chat.planMode;
    const { prompt, appendSystemPrompt } = workbenchTurnPrompt({
      agent: chat.agent,
      text,
      planMode,
      intent: input.intent,
      createPr: { branch: workbench.branch, baseBranch: workbench.baseBranch, extra: workbench.settings?.prompts?.create_pr },
      autoCreatePr: workbench.settings?.autoCreatePr,
      hasPullRequest: Boolean(workbench.pullRequestId),
    });
    const repositoryInstructions = workbench.repositoryId
      ? await this.deps.repositoryInstructions?.(workbench.repositoryId, chat.agent)
      : undefined;
    const claudeCoAuthoredBy = chat.agent === 'claude'
      ? this.deps.claudeCoAuthoredBy?.(workbench.workspaceId)
      : undefined;
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
        planMode,
        resumeSessionId: chat.agentSessionId ?? undefined,
        ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
        ...(claudeCoAuthoredBy !== undefined ? { claudeCoAuthoredBy } : {}),
        attachments: input.attachments,
        ...(repositoryInstructions !== undefined ? { repositoryInstructions } : {}),
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

  /**
   * A display title from the first message, by the local CLI with a cheap
   * model. Beside the turn, never in its way: any failure keeps the name. The
   * backend writes it only while the session has no title, so a person's
   * rename always wins.
   */
  async generateTitle(workbench: Workbench, agent: WorkbenchAgent, text: string): Promise<void> {
    const { bridge, api: workbenches } = this.deps;
    if (workbench.title || this.titled.has(workbench.id) || !bridge.generateTitle || !workbenches.update) return;
    this.titled.add(workbench.id);
    try {
      const title = await bridge.generateTitle({ agent, message: text });
      if (!title) return;
      if (useWorkbenchStore.getState().workbenches[workbench.id]?.title) return;
      useWorkbenchStore.getState().upsertWorkbench(await workbenches.update(workbench.id, { generatedTitle: title }));
    } catch {
      // The name stays.
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
    // While the PR is opened the turn still holds the chat, so a message sent
    // meanwhile queues instead of editing what is being committed.
    const workbench = wasRunning ? useWorkbenchStore.getState().workbenches[wasRunning.workbenchId] : undefined;
    const autoPr = wasRunning?.intent !== 'create_pr' && findChat(chatId)?.status !== 'awaiting_input' && Boolean(workbench) &&
      workbench?.settings?.autoCreatePr !== false && !workbench?.pullRequestId &&
      parseAutoPrDetails(outcome.resultText).ok;
    const succeeded = Boolean(wasRunning) && !outcome.isError && !outcome.cancelled;
    if (wasRunning && succeeded && wasRunning.intent === 'rename_branch') await this.followBranchRename(wasRunning);
    let nameAfter = false;
    if (wasRunning && (wasRunning.intent === 'create_pr' || autoPr) && !wasRunning.pullRequestStarted && succeeded) {
      wasRunning.pullRequestStarted = true;
      // The push fixes the branch name, so a better one comes first, from the agent's PR title.
      await this.nameBranchBeforePullRequest(chatId, wasRunning, outcome.resultText);
      await this.openPullRequest(chatId, wasRunning, outcome.resultText);
    } else if (wasRunning && succeeded && wasRunning.turn === 1 && wasRunning.intent !== 'rename_branch') {
      nameAfter = true;
    }
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

    // Beside the turn loop. Not when a queued message is about to start a turn on this branch.
    if (nameAfter && wasRunning && !useWorkbenchStore.getState().localQueues[chatId]?.length) {
      void this.nameBranch(chatId, wasRunning, { finalMessage: outcome.resultText });
    }

    const next = useWorkbenchStore.getState().dequeueLocal(chatId);
    if (!next) return;
    const workbenchId = wasRunning?.workbenchId ?? chat?.workbenchId;
    const nextWorkbench = workbenchId ? useWorkbenchStore.getState().workbenches[workbenchId] : undefined;
    const fresh = findChat(chatId);
    if (!nextWorkbench || !fresh) return;
    await this.startTurn(nextWorkbench, { ...fresh, status: 'idle' }, next);
  }

  /**
   * Name the branch before the PR pushes it, waiting at most the deadline.
   * A rename that has started is waited for, so the push always uses the
   * name the row holds.
   */
  private async nameBranchBeforePullRequest(chatId: string, run: RunningTurn, finalText: string): Promise<void> {
    const parsed = parsePrDetails(finalText);
    if (!parsed.ok) return;
    const controller = new AbortController();
    let committed = false;
    const work = this.nameBranch(chatId, run, { title: parsed.details.title }, {
      signal: controller.signal,
      onCommit: () => {
        committed = true;
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.deps.branchNamingDeadlineMs ?? LOCAL_BRANCH_NAMING_DEADLINE_MS);
    });
    try {
      if ((await Promise.race([work.then(() => 'done' as const), deadline])) === 'timeout') {
        controller.abort();
        if (committed) await work;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A better branch name for a new local session, decided by Talyn
   * (`api.workbenches.nameBranch`): reserve the name, rename the branch in
   * the worktree (main checks it), then confirm so the row moves last. A
   * refused or failed confirm renames the branch back. Never throws; every
   * failure keeps the name.
   */
  async nameBranch(
    chatId: string,
    run: RunningTurn,
    source: { title: string } | { finalMessage: string },
    opts: { signal?: AbortSignal; onCommit?: () => void } = {}
  ): Promise<void> {
    const { bridge, api: workbenches } = this.deps;
    const { nameBranch, confirmBranchName } = workbenches;
    const renameBranch = bridge.renameBranch?.bind(bridge);
    if (!nameBranch || !confirmBranchName || !renameBranch) return;
    const workbench = useWorkbenchStore.getState().workbenches[run.workbenchId];
    const path = workbench?.localPath;
    if (!workbench || workbench.runtime !== 'local' || !path || workbench.pullRequestId) return;
    const stopped = () => opts.signal?.aborted || this.otherTurnRunning(workbench.id, chatId);
    try {
      // The backend counts turns from the uploaded events.
      await this.flush(chatId);
      const input: NameWorkbenchBranchInput = { chatId };
      if ('title' in source) input.title = source.title;
      else {
        if (!bridge.suggestBranchName) return;
        // Ask the model only for a session whose branch may move.
        if ((await nameBranch(workbench.id, { chatId })).outcome !== 'suggest') return;
        const changedFiles = await this.changedFiles(path, workbench.baseBranch);
        const suggestion = await bridge.suggestBranchName({
          agent: workbench.agent,
          message: run.text,
          changedFiles,
          finalMessage: source.finalMessage,
        });
        input.suggestion = suggestion ?? '';
      }
      if (stopped()) return;
      const decision = await nameBranch(workbench.id, input);
      if (decision.outcome !== 'rename' || stopped()) return;
      opts.onCommit?.();
      const renamed = await renameBranch({ path, from: decision.from, to: decision.to });
      if (!renamed.ok) return;
      const confirm = () => confirmBranchName(workbench.id, { from: decision.from, to: decision.to }).catch(() => null);
      // A confirm is idempotent, so one whose answer was lost is sent again.
      const result = (await confirm()) ?? (await confirm());
      if (result?.outcome === 'renamed') {
        useWorkbenchStore.getState().upsertWorkbench(result.workbench);
        return;
      }
      await renameBranch({ path, from: decision.to, to: decision.from }).catch(() => undefined);
    } catch {
      // The name stays.
    }
  }

  /** After a `rename_branch` turn: the row follows the branch the agent left checked out. */
  private async followBranchRename(run: RunningTurn): Promise<void> {
    const update = this.deps.api.update;
    const workbench = useWorkbenchStore.getState().workbenches[run.workbenchId];
    if (!update || !workbench?.localPath) return;
    try {
      const head = await this.deps.bridge.exec(workbench.localPath, [currentBranch()]);
      const branch = head.exitCode === 0 ? head.stdout.trim() : '';
      if (!branch || branch === workbench.branch || !isValidBranchName(branch)) return;
      useWorkbenchStore.getState().upsertWorkbench(await update(workbench.id, { branch }));
    } catch {
      // The row keeps the old name; a later checkout report corrects it.
    }
  }

  private otherTurnRunning(workbenchId: string, chatId: string): boolean {
    for (const [id, run] of this.running) if (id !== chatId && run.workbenchId === workbenchId) return true;
    return false;
  }

  /** Paths changed against the base, for the branch-name prompt. Empty when git cannot say. */
  private async changedFiles(path: string, baseBranch: string): Promise<string[]> {
    try {
      let sha = '';
      for (const ref of [`origin/${baseBranch}`, baseBranch]) {
        const res = await this.deps.bridge.exec(path, [mergeBase(ref)]);
        if (res.exitCode === 0 && res.stdout.trim()) {
          sha = res.stdout.trim();
          break;
        }
      }
      if (!sha) return [];
      const [diff, untracked] = await Promise.all([
        this.deps.bridge.exec(path, [{ argv: ['git', 'diff', '--name-only', '-z', sha, '--'] }]),
        this.deps.bridge.exec(path, [untrackedFiles()]),
      ]);
      const files = [...parseNulList(diff.stdout), ...parseNulList(untracked.stdout)];
      return files.slice(0, WORKBENCH_BRANCH_PROMPT_FILES_MAX + 1);
    } catch {
      return [];
    }
  }

  /** Open the PR from the agent's block, and record the result. */
  private async openPullRequest(chatId: string, run: RunningTurn, finalText: string): Promise<void> {
    const workbench = useWorkbenchStore.getState().workbenches[run.workbenchId];
    const parsed = parsePrDetails(finalText);
    let outcome: PullRequestOutcome;
    if (!parsed.ok) outcome = (workbench && (await this.adoptPullRequest(workbench))) || { ok: false, message: parsed.error };
    else if (!workbench) outcome = { ok: false, message: 'The session is no longer loaded.' };
    else {
      try {
        const result = await openLocalPullRequest(this.deps.bridge, this.deps.api, workbench, {
          ...parsed.details,
          base: workbench.baseBranch,
        });
        useWorkbenchStore.getState().upsertWorkbench(result.workbench);
        outcome = { ok: true, ...result.pullRequest, existing: result.existing };
      } catch (err) {
        outcome = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }
    this.record(chatId, run.turn, pullRequestOutcomeEvent(outcome) as AgentEventDraft);
    if (!outcome.ok) toast.error('Could not open the pull request', outcome.message);
  }

  /**
   * No talyn-pr block: the agent may have opened the PR itself, against the
   * instructions. Link the one open PR at the worktree's HEAD, if there is one.
   * Never throws; null means "keep the missing-block message".
   */
  private async adoptPullRequest(workbench: Workbench): Promise<PullRequestOutcome | null> {
    const adoptApi = this.deps.api.adoptPullRequest;
    if (!adoptApi) return null;
    try {
      const adopted = await adoptLocalPullRequest(this.deps.bridge, { adoptPullRequest: adoptApi }, workbench);
      if (!adopted?.pullRequest) return null;
      useWorkbenchStore.getState().upsertWorkbench(adopted.workbench);
      const { number, url } = adopted.pullRequest;
      return { ok: true, number, url, existing: true, adopted: true };
    } catch {
      return null;
    }
  }

  async cancel(chatId: string): Promise<void> {
    const ours = this.running.has(chatId);
    await this.deps.bridge.cancelTurn(chatId);
    // A chat left `running` by an app that quit or crashed mid-turn has no
    // turn here to end it, so nothing would ever report it idle.
    const chat = findChat(chatId);
    if (!ours && !this.running.has(chatId) && chat?.status === 'running') {
      this.setStatus(chat, 'idle');
      await this.report(chatId, { status: 'idle' });
    }
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

/** Below the backend's 1000 events and 2 MB body per local-events request. */
export const LOCAL_UPLOAD_MAX_EVENTS = 500;
export const LOCAL_UPLOAD_MAX_BYTES = 1024 * 1024;

export function chunkEvents(events: WorkbenchEvent[]): WorkbenchEvent[][] {
  const chunks: WorkbenchEvent[][] = [];
  let current: WorkbenchEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    // JSON length counts UTF-16 units; three bytes each bounds the UTF-8 size.
    const size = JSON.stringify(event).length * 3;
    if (current.length && (current.length >= LOCAL_UPLOAD_MAX_EVENTS || bytes + size > LOCAL_UPLOAD_MAX_BYTES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
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
    repositoryInstructions: async (repositoryId, agent) => {
      try {
        const found = await api.repositories.instructions.get(repositoryId);
        if (!found) return null;
        return found.agents === 'both' || found.agents === agent ? found.body : null;
      } catch {
        return undefined;
      }
    },
    claudeCoAuthoredBy: (workspaceId) =>
      useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)?.settings?.claudeCoAuthoredBy !== false,
  });
  controller.start();
  return controller;
}

/**
 * After an archive: drop the session's queued messages, so a cancelled turn
 * does not start the next one, then stop its turns, scripts and terminals on
 * this machine. `removeLocalWorktree` then deletes the worktree.
 */
export async function stopLocalWorkbench(
  workbenchId: string,
  bridge: Pick<WorkbenchLocalBridge, 'stopWorkbench'> | null = getWorkbenchBridge()
): Promise<void> {
  const chatIds = (useWorkbenchStore.getState().chats[workbenchId] ?? []).map((c) => c.id);
  useWorkbenchStore.setState((s) => {
    const localQueues = { ...s.localQueues };
    for (const id of chatIds) delete localQueues[id];
    return { localQueues };
  });
  await bridge?.stopWorkbench?.(workbenchId);
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
  autoCreatePr?: boolean;
  baseBranch?: string;
  /** An existing branch (from a PR). Absent: a new branch named after the workbench. */
  branch?: string;
  fromPullRequestId?: string;
  /** An existing local clone. Absent: the main process clones it. */
  repoPath?: string;
  takenNames: string[];
  /** The workspace's `sessionBranchPrefix`. Applies only when `branch` is not given. */
  branchPrefix?: string;
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
  const branchBase = (input.prompt?.trim() ? workbenchBranchFromTask(input.prompt) : null) ?? name;
  const branchGenerated = input.branch === undefined && !input.fromPullRequestId;
  const wantedBranch = input.branch ?? `${input.branchPrefix ?? ''}${branchBase}`;
  const baseBranch = input.baseBranch || (await detectDefaultBranch(bridge, input.repoPath)) || 'main';
  const created = await bridge.createWorktree({
    repoPath: input.repoPath,
    cloneUrl: input.repoPath ? undefined : `https://github.com/${input.repoFullName}.git`,
    repoFullName: input.repoFullName,
    workbenchId: newClientId(),
    name,
    branch: wantedBranch,
    baseBranch,
    // Main adds a suffix when a branch of this name already exists.
    newBranch: branchGenerated,
  });
  const { path } = created;
  const branch = created.branch ?? wantedBranch;
  if (created.notice) toast.info('Made from your local branch', created.notice);
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
    // Named here from the prompt, so Talyn may rename it after the first turn.
    branchGenerated,
    // No `prompt`: the backend cannot run a local turn. The caller sends the
    // first message through the controller once the chat exists.
    deviceId: getDeviceId(),
    localPath: path,
    autoCreatePr: input.autoCreatePr,
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
