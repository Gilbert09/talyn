import { v4 as uuid } from 'uuid';
import {
  buildClaudeArgv,
  buildCodexArgv,
  checkpointCreateSteps,
  checkpointRestoreSteps,
  CLAUDE_SANDBOX_ENV,
  createAgentStreamParser,
  parseAutoPrDetails,
  workbenchTurnPrompt,
  shellQuote,
  toShellScript,
  workbenchQueuesMessages,
  DEFAULT_WORKBENCH_EFFORT,
  WORKBENCH_EFFORTS,
  WORKBENCH_MESSAGE_INTENTS,
  type AgentEventDraft,
  type AgentStreamParser,
  type SendWorkbenchMessageInput,
  type WorkbenchAttachment,
  type WorkbenchChatStatus,
  type WorkbenchQueuedMessage,
  type WorkbenchStatus,
} from '@talyn/shared';
import { debugBus } from '../debugBus.js';
import { startDurableExec, followDurableExec, followDurableBatches, retryBatchWrite, durableExecExists, removeDurableExec, durableMarker } from './durableExec.js';
import { TURN_OWNER, isWorkbenchDraining, isWorkbenchDetached } from './ownership.js';
import { runWithoutScope } from '../../db/client.js';
import { scheduleAgentBackup } from './agentBackups.js';
import { clearRecoveryRecap, recoveryRecap } from './agentRecap.js';
import { assertRepoPath, refreshDiffStat } from './changes.js';
import {
  DISK_PROBE_SCRIPT,
  isDiskFullError,
  isDiskFullText,
  LOW_DISK_BYTES,
  parseDiskProbe,
  withoutDiskProbe,
  type DiskProbe,
} from './execFailures.js';
import { emitWorkbenchChat, emitWorkbenchEvents, emitWorkbenchUpdated } from './emit.js';
import { notifyPrSessionChanged } from './prSessions.js';
import { localRuntimeError, notReadyError, WorkbenchError } from './errors.js';
import { safeMarker } from './execFraming.js';
import { syncInstructionFiles } from './instructions.js';
import { growOrMove, moveWorkbenchToFreshSandbox, needsFreshGolden } from './move.js';
import { linkPullRequest, publicWorkbench } from './prLink.js';
import { openPullRequestFromTurn } from './pullRequest.js';
import { SANDBOX_LOST_MESSAGE } from './recovery.js';
import { FleetRunNotFoundError } from '../selfHosted/client.js';
import { selectFleetAccount } from '../selfHosted/accountSelection.js';
import { exhaustedAgentFrom, noteExhaustedAgent, rateLimitedAgentFrom } from '../selfHosted/exhaustedQuota.js';
import {
  killMarker,
  isMarkerAlive,
  recordWorkbenchEvent,
  refreshSandboxCredentials,
  repoDirFor,
  runCapture,
  runGitSteps,
  sandboxScriptEnv,
  startAccountWatch,
  workbenchFleetAccountId,
} from './sandboxRuntime.js';
import { writeSandboxFiles, type SandboxFile } from './sandboxFiles.js';
import { startTitleGeneration } from './title.js';
import {
  appendEvents,
  claimOrEnqueue,
  finishTurn,
  getChat,
  getCheckpoint,
  getWorkbench,
  requeueTurn,
  rowToChat,
  getTurnLease,
  hasTurnEvent,
  turnLeases,
  claimTurnLease,
  renewTurnLease,
  releaseTurnLease,
  releaseOwnedTurnLeases,
  markDrainPending,
  setTurnAttempt,
  queuedIdleChats,
  type TurnLease,
  upsertCheckpoint,
  type ChatRow,
  type EventDraftInput,
  type WorkbenchRow,
} from './store.js';

/**
 * Agent turns in a sandbox workbench: one CLI process per turn, run through
 * the fleet's `exec?follow=1`, its stdout parsed by the shared agent-stream
 * parser into the transcript.
 *
 * # The queue
 *
 * An exec has no stdin, so there is no steering mid-turn. A message sent while
 * a turn runs joins the chat's `queued_messages`, and the turn's end takes the
 * next one — both through single-statement claims in the store, so two sends
 * can never start two turns on one chat. A turn the user CANCELS does not
 * drain: they pressed stop, and the next send runs the queue in order first.
 *
 * # Where a turn lives
 *
 * The agent and its output log live in the sandbox. A database lease selects
 * one backend follower. A stale lease permits replay from its saved offset.
 */

/** Events are written in batches: whichever comes first of this many, or this long. */
const FLUSH_EVENTS = 50;
const FLUSH_MS = 250;

interface LiveTurn {
  turn: number;
  controller: AbortController;
  cancelRequested: boolean;
}

/** chatId → the turn this process is following. */
const liveTurns = new Map<string, LiveTurn>();

export function turnMarker(chatId: string, turn?: number, attempt = 0): string {
  return safeMarker(`talyn-turn-${chatId}${turn === undefined ? '' : `-${turn}-${attempt}`}`);
}

export function isTurnLiveHere(chatId: string): boolean {
  return liveTurns.has(chatId);
}

// ============================================================================
// Sending
// ============================================================================

export function normaliseMessage(input: SendWorkbenchMessageInput): WorkbenchQueuedMessage {
  const text = typeof input?.text === 'string' ? input.text : '';
  if (!text.trim()) throw new WorkbenchError('A message needs some text.', 400, 'empty_message');
  if (input.effort !== undefined && !WORKBENCH_EFFORTS.includes(input.effort)) {
    throw new WorkbenchError(`Unknown effort "${String(input.effort)}".`, 400, 'bad_effort');
  }
  if (input.intent !== undefined && !WORKBENCH_MESSAGE_INTENTS.includes(input.intent)) {
    throw new WorkbenchError(`Unknown intent "${String(input.intent)}".`, 400, 'bad_intent');
  }
  const attachments = Array.isArray(input.attachments) ? input.attachments.map(normaliseAttachment) : undefined;
  return {
    id: uuid(),
    text,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(typeof input.planMode === 'boolean' ? { planMode: input.planMode } : {}),
    ...(typeof input.model === 'string' && input.model.trim() ? { model: input.model.trim() } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.intent ? { intent: input.intent } : {}),
    queuedAt: new Date().toISOString(),
  };
}

function normaliseAttachment(a: WorkbenchAttachment): WorkbenchAttachment {
  const name = typeof a?.name === 'string' ? a.name.trim() : '';
  const hasData = typeof a?.dataBase64 === 'string' && a.dataBase64.length > 0;
  const hasPath = typeof a?.path === 'string' && a.path.length > 0;
  if (!name || hasData === hasPath) {
    throw new WorkbenchError('An attachment needs a name and exactly one of dataBase64 or path.', 400, 'bad_attachment');
  }
  return {
    name,
    mimeType: typeof a.mimeType === 'string' ? a.mimeType : 'application/octet-stream',
    ...(hasData ? { dataBase64: a.dataBase64 } : { path: a.path }),
  };
}

/**
 * Send a message to a chat. Starts a turn when the chat is idle and the
 * workbench is ready; otherwise the message waits in the queue (`queued`).
 */
export async function sendMessage(chatId: string, input: SendWorkbenchMessageInput): Promise<{ queued: boolean }> {
  const chat = await getChat(chatId);
  if (!chat) throw new WorkbenchError('Chat not found', 404, 'not_found');
  const wb = await getWorkbench(chat.workbenchId);
  if (!wb) throw new WorkbenchError('Session not found', 404, 'not_found');
  if (wb.runtime === 'local') throw localRuntimeError();
  // Only a workbench still starting may queue: a failed or archived one has no
  // box coming, so a queued message would wait forever.
  if (wb.archivedAt || wb.status === 'archived') throw notReadyError('archived');
  if (wb.status !== 'ready' && !workbenchQueuesMessages(wb.status as WorkbenchStatus)) throw notReadyError(wb.status);
  const message = normaliseMessage(input);
  const claim = await claimOrEnqueue(chatId, message, wb.status === 'ready');
  if (!claim) throw new WorkbenchError('Chat not found', 404, 'not_found');
  emitWorkbenchChat(chat.workspaceId, rowToChat(claim.chat));
  if (claim.started) launchTurnLoop(chatId, claim.started);
  return { queued: claim.started?.message.id !== message.id };
}

/** Start the head of the queue when nothing is running — after a provision, or a cancel. */
export async function startQueuedIfIdle(chatId: string): Promise<boolean> {
  if (isWorkbenchDraining()) { await markDrainPending(chatId); return false; }
  const claim = await claimOrEnqueue(chatId, null, true);
  if (!claim?.started) return false;
  emitWorkbenchChat(claim.chat.workspaceId, rowToChat(claim.chat));
  launchTurnLoop(chatId, claim.started);
  return true;
}

/** Tests only: follow a turn another call already claimed, as `sendMessage` would. */
export function launchTurnLoopForTests(chatId: string, first: { message: WorkbenchQueuedMessage; turn: number }): void {
  launchTurnLoop(chatId, first);
}

function launchTurnLoop(chatId: string, first: { message: WorkbenchQueuedMessage; turn: number }): void {
  // Off the request's owner scope: by the time this runs, that transaction has
  // committed and every query on it would fail.
  void runWithoutScope(() => runTurnLoop(chatId, first)).catch((err) => {
    console.error(`[workbench] turn loop for chat ${chatId} crashed:`, err);
  });
}

async function runTurnLoop(
  chatId: string,
  first: { message: WorkbenchQueuedMessage; turn: number },
  resume?: TurnLease,
  legacyTurn = false,
): Promise<void> {
  let next: { message: WorkbenchQueuedMessage; turn: number } | null = first;
  while (next) {
    let lost = false;
    const heldTurn = next.turn;
    const heartbeat = setInterval(() => {
      if (isWorkbenchDetached()) {
        lost = true;
        liveTurns.get(chatId)?.controller.abort();
        return;
      }
      void renewTurnLease(chatId, heldTurn).then((ok) => {
        if (!ok) { lost = true; liveTurns.get(chatId)?.controller.abort(); }
      }).catch((err: unknown) => {
        lost = true;
        liveTurns.get(chatId)?.controller.abort();
        debugBus.recordEvent({ service: 'workbenches', action: 'lease_failed', summary: 'The turn follower lost its lease.', ok: false, error: err });
      });
    }, 20_000);
    heartbeat.unref();
    let outcome: TurnOutcome;
    try {
      outcome = resume ? await resumeTurn(chatId, resume, legacyTurn) : await runOneTurn(chatId, next.message, next.turn);
      resume = undefined;
    } catch (error) {
      await releaseTurnLease(chatId, heldTurn);
      debugBus.recordEvent({ service: 'workbenches', action: 'turn_handoff', summary: 'The turn follower will reconnect.', ok: false, error });
      return;
    } finally { clearInterval(heartbeat); }
    if (lost || isWorkbenchDetached() || outcome.handedOff) {
      await releaseTurnLease(chatId, heldTurn);
      return;
    }
    // Back in the queue: the move that is running starts it when it ends.
    if (outcome.requeued) { await startQueuedIfIdle(chatId); return; }
    // T3: a turn that failed on a full disk is not run again (its side effects
    // could repeat); the box is made usable and the user sends it again.
    if (outcome.diskFull && !outcome.cancelled) await recoverTurnFromDiskFull(chatId);
    const fin = await finishTurn(chatId, {
      finalStatus: outcome.status,
      statusMessage: outcome.statusMessage,
      drain: !outcome.cancelled,
      owner: TURN_OWNER,
      turn: heldTurn,
    });
    if (fin) emitWorkbenchChat(fin.chat.workspaceId, rowToChat(fin.chat));
    if (fin) {
      scheduleAgentBackup(chatId);
      const wb = await getWorkbench(fin.chat.workbenchId);
      if (wb) for (const attempt of [0, 1]) {
        await removeDurableExec(wb, turnLogKey(chatId, heldTurn, attempt), turnMarker(chatId, heldTurn, attempt))
          .catch((error) => recordWorkbenchEvent(wb, 'turn_cleanup_failed', 'The finished turn log could not be removed.', false, error));
      }
    }
    void afterTurn(fin?.chat ?? null);
    if (outcome.statusMessage === SANDBOX_LOST_MESSAGE && fin) {
      const wb = await getWorkbench(fin.chat.workbenchId);
      if (wb?.status === 'ready') await startQueuedIfIdle(chatId);
    }
    next = fin?.started ?? null;
  }
}

/** After a turn: the diff stat and the PR link may both have moved. Best effort. */
async function afterTurn(chat: ChatRow | null): Promise<void> {
  if (!chat) return;
  try {
    let wb = await getWorkbench(chat.workbenchId);
    if (!wb) return;
    wb = await refreshDiffStat(wb);
    const linked = await linkPullRequest(wb);
    if (linked.pullRequestId !== wb.pullRequestId) await emitWorkbenchUpdated(await publicWorkbench(linked));
    // The turn may have fixed the PR, so the merge queue and auto-keep look again.
    if (linked.pullRequestId) notifyPrSessionChanged(linked.workspaceId, linked.pullRequestId, 'session:turn_end');
  } catch (err) {
    console.warn(`[workbench] after-turn refresh for chat ${chat.id} failed:`, err);
  }
}

// ============================================================================
// One turn
// ============================================================================

interface TurnOutcome {
  status: WorkbenchChatStatus;
  statusMessage: string | null;
  cancelled: boolean;
  /** The turn failed because the box's disk is full. */
  diskFull?: boolean;
  /** The workbench was moving: the message went back to the queue and nothing ran. */
  requeued?: boolean;
  handedOff?: boolean;
}

export const DISK_FULL_MOVED_NOTE =
  'The sandbox ran out of disk space, so Talyn moved this session to a fresh sandbox. Send your message again to continue.';
export const DISK_FULL_GROWN_NOTE =
  'The sandbox ran out of disk space, so Talyn gave it more. Send your message again to continue.';

/** After a turn failed on a full disk: grow the disk or move the session, and say so. */
async function recoverTurnFromDiskFull(chatId: string): Promise<void> {
  try {
    const chat = await getChat(chatId);
    const wb = chat ? await getWorkbench(chat.workbenchId) : null;
    if (!chat || !wb || wb.status !== 'ready') return;
    const recovered = await growOrMove(wb, 'disk_full', { ownerChatId: chatId });
    if (!recovered.ok) return;
    const stored = await appendEvents(chatId, [
      {
        turn: chat.turnCount,
        event: {
          type: 'system',
          subtype: 'sandbox_disk_full',
          text: recovered.action === 'moved' ? DISK_FULL_MOVED_NOTE : DISK_FULL_GROWN_NOTE,
        },
      },
    ]);
    emitWorkbenchEvents(chat.workspaceId, chatId, stored);
  } catch (err) {
    console.warn(`[workbench] recovering chat ${chatId} from a full disk failed:`, err);
  }
}

/**
 * Writes a turn's events in batches and broadcasts each batch once stored, so
 * a client that reloads mid-turn pages exactly what the live socket showed.
 * Flushes are chained: two batches never race for the allocator.
 */
class EventBatcher {
  private pending: EventDraftInput[] = [];
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private failure: unknown;

  constructor(
    private readonly workspaceId: string,
    private readonly chatId: string,
    private readonly turn: number,
  ) {}

  add(draft: AgentEventDraft | Record<string, unknown>): void {
    const { seq: _seq, ...event } = draft as Record<string, unknown>;
    this.pending.push({ turn: this.turn, event });
    if (this.pending.length >= FLUSH_EVENTS) void this.flush().catch(() => undefined);
    else if (!this.timer) this.timer = setTimeout(() => void this.flush().catch(() => undefined), FLUSH_MS);
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.pending.splice(0);
    if (batch.length > 0) {
      this.chain = this.chain
        .then(async () => {
          if (this.failure) throw this.failure;
          const stored = await retryBatchWrite(() => appendEvents(this.chatId, batch, { owner: TURN_OWNER, turn: this.turn }));
          emitWorkbenchEvents(this.workspaceId, this.chatId, stored);
        })
        .catch((err: unknown) => { this.failure = err; });
    }
    return this.chain.then(() => { if (this.failure) throw this.failure; });
  }
}

export function userMessageEvent(message: WorkbenchQueuedMessage): Record<string, unknown> {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: message.text }] },
    talyn: {
      kind: 'user_message',
      messageId: message.id,
      ...(message.intent ? { intent: message.intent } : {}),
      ...(message.planMode !== undefined ? { planMode: message.planMode } : {}),
      ...(message.attachments ? { attachments: message.attachments.map((a) => ({ name: a.name, mimeType: a.mimeType, ...(a.path ? { path: a.path } : {}) })) } : {}),
    },
  };
}

/** A transcript line saying the session moved to another fleet account. */
function accountSwitchEvent(note: string): Record<string, unknown> {
  return { type: 'system', subtype: 'fleet_account_switched', text: note };
}

function errorResultEvent(subtype: string, text: string): Record<string, unknown> {
  return { type: 'result', subtype, is_error: true, result: text };
}

async function runOneTurn(chatId: string, message: WorkbenchQueuedMessage, turn: number): Promise<TurnOutcome> {
  if (isWorkbenchDraining()) {
    const chat = await requeueTurn(chatId, message);
    if (chat) emitWorkbenchChat(chat.workspaceId, rowToChat(chat));
    return { status: 'idle', statusMessage: null, cancelled: false, requeued: true };
  }
  const chat = await getChat(chatId);
  if (!chat) return { status: 'error', statusMessage: 'Chat not found', cancelled: false };
  // A move claimed the workbench between this turn's claim and now: queue the
  // message again rather than fail it. Nothing has been written for the turn yet.
  const early = await getWorkbench(chat.workbenchId);
  if (early?.status === 'moving') {
    const requeued = await requeueTurn(chatId, message);
    if (requeued) {
      emitWorkbenchChat(requeued.workspaceId, rowToChat(requeued));
      // The move may have released already, and looked at this chat while it was still running.
      if ((await getWorkbench(chat.workbenchId))?.status === 'ready') void startQueuedIfIdle(chatId).catch(() => false);
      return { status: 'idle', statusMessage: null, cancelled: false, requeued: true };
    }
  }
  const live: LiveTurn = { turn, controller: new AbortController(), cancelRequested: false };
  liveTurns.set(chatId, live);
  const events = new EventBatcher(chat.workspaceId, chatId, turn);
  if (!(await hasTurnEvent(chatId, turn, 'user_message'))) events.add(userMessageEvent(message));
  let parserResult: { isError: boolean; text: string } | null = null;
  let sawResult = false;
  let agentMayBeRunning = false;
  let recapWrite = Promise.resolve();
  try {
    let wb = early;
    if (!wb || wb.archivedAt || wb.status !== 'ready' || !wb.sandboxId) {
      throw new WorkbenchError('The session is not ready.', 409, 'not_ready');
    }
    recordWorkbenchEvent(wb, 'turn_start', `chat ${chatId.slice(0, 8)} turn ${turn}`);

    // T1: a box asleep on a stale golden moves before anything wakes it.
    if (await needsFreshGolden(wb)) {
      const moved = await moveWorkbenchToFreshSandbox(wb, 'stale_golden', { ownerChatId: chatId });
      if (moved.moved) wb = moved.row;
    }
    if (live.cancelRequested) return cancelledOutcome(events);

    // The checkpoint first: it is also the exec that wakes a suspended box,
    // which the credential push below needs. It reports the free disk too (T2).
    wb = await checkpointAndCheckDisk(wb, chatId, turn);
    if (live.cancelRequested) return cancelledOutcome(events);
    const turnModel = message.model ?? chat.model ?? wb.model ?? undefined;
    // The session's account, or the next one when it has crossed the threshold.
    const refreshed = await refreshSandboxCredentials(wb, { model: turnModel });
    if (refreshed.note) events.add(accountSwitchEvent(refreshed.note));
    if (live.cancelRequested) return cancelledOutcome(events);
    // The box is awake and has its credentials: name the session beside the turn.
    if (turn === 1) startTitleGeneration(wb, message.text);

    const agent = chat.agent === 'codex' ? 'codex' : 'claude';
    // A reboot rewrites the agent's home files, so this runs every turn. A
    // failure costs the user's instructions for one turn, not the turn.
    await syncInstructionFiles(wb, agent).catch((err) => {
      if (err instanceof FleetRunNotFoundError) throw err;
      console.warn(`[workbench] syncing instruction files for chat ${chatId} failed:`, err);
      recordWorkbenchEvent(wb, 'instructions_sync', err instanceof Error ? err.message : String(err), false);
    });
    if (live.cancelRequested) return cancelledOutcome(events);

    const attached = await writeAttachments(wb, chatId, turn, message.attachments ?? []);
    const planMode = message.planMode ?? chat.planMode;
    const model = turnModel;
    const effort = message.effort ?? (chat.effort as WorkbenchQueuedMessage['effort']) ?? DEFAULT_WORKBENCH_EFFORT;
    const resumeSessionId = chat.agentSessionId ?? undefined;
    const text = promptWith(message.text, agent === 'codex' ? attached.other : attached.all);
    // The transcript keeps `message.text`; the hidden instructions reach the agent only.
    const recap = await recoveryRecap(chatId, turn);
    const { prompt, appendSystemPrompt } = workbenchTurnPrompt({
      recap,
      agent,
      text,
      planMode,
      intent: message.intent,
      createPr: { branch: wb.branch, baseBranch: wb.baseBranch, extra: wb.settings?.prompts?.create_pr },
      internetAccess: wb.settings?.internetAccess,
      autoCreatePr: wb.settings?.autoCreatePr,
      hasPullRequest: Boolean(wb.pullRequestId),
      imported: chat.importedFrom ? { root: chat.importedFrom.root || chat.importedFrom.cwd, repoDir: repoDirFor(wb) } : null,
    });
    const argv =
      agent === 'codex'
        ? buildCodexArgv({
            prompt,
            model,
            effort,
            planMode,
            resumeSessionId,
            images: attached.images,
            // The microVM is the boundary. Codex's own Landlock sandbox may not
            // be available inside it, and the box has nothing else to protect.
            sandboxMode: planMode ? 'read-only' : 'danger-full-access',
          })
        : buildClaudeArgv({ prompt, model, effort, planMode, resumeSessionId, appendSystemPrompt });
    const env = { ...sandboxScriptEnv(wb), ...(agent === 'claude' ? CLAUDE_SANDBOX_ENV : {}) };

    let accountId = refreshed.accountId;
    let outcome!: Awaited<ReturnType<typeof followDurableExec>>;
    let attemptSawResult = false;
    let recapStarted = false;
    const noteRecapStarted = () => {
      if (recap === undefined || recapStarted) return;
      recapStarted = true;
      recapWrite = clearRecoveryRecap(chatId).catch((err) => {
        console.warn(`[workbench] clearing the recap for chat ${chatId} failed:`, err);
      });
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const parser = createAgentStreamParser(agent);
      attemptSawResult = false;
      await events.flush();
      if (!(await setTurnAttempt(chatId, turn, attempt))) return handoffOutcome();
      const key = turnLogKey(chatId, turn, attempt);
      if (live.controller.signal.aborted || isWorkbenchDetached() || !(await renewTurnLease(chatId, turn))) return handoffOutcome();
      agentMayBeRunning = true;
      try {
        await startDurableExec(wb, key, turnMarker(chatId, turn, attempt), argv.map(shellQuote).join(' '), env);
      } catch (err) {
        if (isDiskFullError(err)) agentMayBeRunning = false;
        throw err;
      }
      const stopAccountWatch = startAccountWatch(wb, model, (note) => events.add(accountSwitchEvent(note)));
      const stream = followTurnOutput(wb, chat, turn, attempt, parser, 0, live.controller.signal, () => {
        noteRecapStarted();
        if (parser.result) { sawResult = true; attemptSawResult = true; }
      }).finally(stopAccountWatch);
      outcome = await stream;
      if (live.controller.signal.aborted || isWorkbenchDetached()) return handoffOutcome();
      agentMayBeRunning = false;
      if (outcome.exitCode === 0) noteRecapStarted();
      parserResult = parser.result;

      if (live.cancelRequested || (outcome.exitCode === 0 && !parserResult?.isError) || attempt > 0) break;
      // The account this attempt ran on. The row can still name the one from before the turn-start switch.
      const failedAccountId = accountId ?? workbenchFleetAccountId(wb);
      if (!failedAccountId) break;
      const why = parserResult?.text?.trim() || outcome.stderrTail.trim();
      const detail = [parserResult?.text, outcome.stderrTail].filter(Boolean).join('\n');
      const exhausted = exhaustedAgentFrom(detail) === agent;
      if (!exhausted && rateLimitedAgentFrom(detail) !== agent) break;
      if (exhausted) await noteExhaustedAgent(wb.workspaceId, agent, detail, failedAccountId);
      const selection = await selectFleetAccount(wb.workspaceId, agent, {
        model,
        avoidAccountIds: [failedAccountId],
      });
      if (!selection.account || selection.account.id === failedAccountId) break;
      if (!attemptSawResult) events.add(errorResultEvent('error_during_execution', why));
      await events.flush();
      if (live.cancelRequested) break;
      const oldLabel = selection.accounts.find((a) => a.id === failedAccountId)?.label ?? agent;
      const next = await refreshSandboxCredentials(wb, { model, avoidAccountIds: [failedAccountId] });
      if (!next.accountId || next.accountId === failedAccountId) break;
      const nextLabel = selection.accounts.find((a) => a.id === next.accountId)?.label ?? next.accountId;
      const limit = exhausted ? 'ran out of usage' : 'hit its rate limit';
      events.add(accountSwitchEvent(`${agent === 'claude' ? 'Claude' : 'Codex'} account “${oldLabel}” ${limit}. Retrying on “${nextLabel}”.`));
      accountId = next.accountId;
    }

    if (live.cancelRequested) return cancelledOutcome(events, sawResult);
    if (outcome.exitCode === 0 && !parserResult?.isError) {
      await events.flush();
      await finishSuccessfulAgent(wb, chatId, message, parserResult?.text ?? '', events, live);
      return { status: 'idle', statusMessage: null, cancelled: false };
    }
    const why =
      parserResult?.text?.trim() ||
      outcome.stderrTail.trim() ||
      (outcome.exitCode === null || outcome.exitCode === 125
        ? 'The agent stopped unexpectedly.'
        : `The agent exited with code ${outcome.exitCode}.`);
    if (!attemptSawResult) events.add(errorResultEvent('error_during_execution', why));
    await events.flush();
    // Not matched against the agent's text or stderr: only a failure Talyn's
    // own exec or the fleet reports says the disk is full (see the catch).
    return { status: 'error', statusMessage: why.slice(0, 500), cancelled: false };
  } catch (err) {
    if (live.controller.signal.aborted || isWorkbenchDetached()) return handoffOutcome();
    if (live.cancelRequested) return cancelledOutcome(events, sawResult);
    if (err instanceof FleetRunNotFoundError) {
      events.add(errorResultEvent('error_during_execution', SANDBOX_LOST_MESSAGE));
      await events.flush();
      return { status: 'error', statusMessage: SANDBOX_LOST_MESSAGE, cancelled: true };
    }
    if (agentMayBeRunning) {
      recordWorkbenchEvent(early!, 'turn_handoff', 'The turn follower will reconnect.', false, err);
      return handoffOutcome();
    }
    const why = err instanceof Error ? err.message : String(err);
    console.warn(`[workbench] turn ${turn} of chat ${chatId} failed:`, err);
    events.add(errorResultEvent('error_during_execution', `Talyn could not run this turn: ${why}`));
    await events.flush();
    const diskFull = isDiskFullError(err);
    return { status: 'error', statusMessage: why.slice(0, 500), cancelled: false, ...(diskFull ? { diskFull } : {}) };
  } finally {
    await recapWrite;
    liveTurns.delete(chatId);
  }
}

async function cancelledOutcome(events: EventBatcher, sawResult = false): Promise<TurnOutcome> {
  if (!sawResult) events.add(errorResultEvent('cancelled', 'Stopped.'));
  await events.flush();
  return { status: 'idle', statusMessage: 'Cancelled', cancelled: true };
}

/** The prompt, with the attached files named so the agent knows where to look. */
function promptWith(text: string, files: Array<{ path: string; mimeType: string }>): string {
  if (files.length === 0) return text;
  const list = files.map((f) => `- ${f.path} (${f.mimeType})`).join('\n');
  return `${text}\n\nAttached files:\n${list}`;
}

/**
 * Put inline attachments on disk in the sandbox, and resolve path ones inside
 * the repository.
 */
async function writeAttachments(
  wb: WorkbenchRow,
  chatId: string,
  turn: number,
  attachments: WorkbenchAttachment[],
): Promise<{
  all: Array<{ path: string; mimeType: string }>;
  images: string[];
  other: Array<{ path: string; mimeType: string }>;
}> {
  const all: Array<{ path: string; mimeType: string }> = [];
  const files: SandboxFile[] = [];
  const dir = `/tmp/talyn-attachments/${chatId}/${turn}`;
  for (const [i, a] of attachments.entries()) {
    if (a.path) {
      all.push({ path: `${repoDirFor(wb)}/${assertRepoPath(a.path)}`, mimeType: a.mimeType });
      continue;
    }
    const target = `${dir}/${i}-${a.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}`;
    files.push({ path: target, base64: a.dataBase64 ?? '' });
    all.push({ path: target, mimeType: a.mimeType });
  }
  if (files.length > 0) await writeSandboxFiles(wb, files);
  const images = all.filter((f) => f.mimeType.startsWith('image/')).map((f) => f.path);
  const other = all.filter((f) => !f.mimeType.startsWith('image/'));
  return { all, images, other };
}

// ============================================================================
// Checkpoints
// ============================================================================

function tmpIndexPath(chatId: string, turn: number, tag = 'cp'): string {
  return `/tmp/talyn-${tag}-${safeMarker(chatId)}-${turn}.index`;
}

/**
 * Snapshot the working tree before a turn, as a hidden commit under
 * `refs/talyn/checkpoints`, and report the root filesystem's free space from
 * the same exec. The probe runs first and the framing's temp files go to
 * /dev/shm, so a full disk still answers with its numbers.
 */
export async function createCheckpoint(
  wb: WorkbenchRow,
  chatId: string,
  turn: number,
): Promise<{ sha: string | null; disk: DiskProbe | null; error: string | null }> {
  const steps = checkpointCreateSteps({ chatId, turn, tmpIndexPath: tmpIndexPath(chatId, turn) });
  const r = await runCapture(wb, `${DISK_PROBE_SCRIPT}\n${toShellScript(steps)}`, {
    quiet: true,
    timeoutMs: 120_000,
    env: { TMPDIR: '/dev/shm' },
    // The caller deals with a full disk itself, knowing which chat is running.
    diskRecovery: false,
  });
  const disk = parseDiskProbe(r.stderr);
  const sha = r.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (r.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    return { sha: null, disk, error: `checkpoint exited ${r.exitCode}: ${withoutDiskProbe(r.stderr).slice(-300)}` };
  }
  const ref = steps.find((s) => s.argv[1] === 'update-ref')?.argv[2] ?? '';
  await upsertCheckpoint({ chatId, turn, ref, sha });
  return { sha, disk, error: null };
}

/**
 * T2: the turn-start checkpoint, and when the disk is low or full, a grow or a
 * move before the turn runs. Returns the row to run the turn on.
 */
async function checkpointAndCheckDisk(wb: WorkbenchRow, chatId: string, turn: number): Promise<WorkbenchRow> {
  const first = await createCheckpoint(wb, chatId, turn).catch((err) => {
    if (err instanceof FleetRunNotFoundError) throw err;
    console.warn(`[workbench] checkpoint for chat ${chatId} turn ${turn} failed:`, err);
    return { sha: null, disk: null, error: err instanceof Error ? err.message : String(err) };
  });
  if (first.error) console.warn(`[workbench] checkpoint for chat ${chatId} turn ${turn} failed: ${first.error}`);
  const low = first.disk !== null && first.disk.availBytes < LOW_DISK_BYTES;
  const full = isDiskFullText(first.error);
  if (!low && !full) return wb;
  const recovered = await growOrMove(wb, full ? 'disk_full' : 'low_disk', { ownerChatId: chatId, probe: first.disk }).catch(
    (err) => {
      console.warn(`[workbench] making room for chat ${chatId} failed:`, err);
      return { ok: false as const };
    },
  );
  if (!recovered.ok) return wb;
  if (recovered.action === 'moved' || first.sha === null) {
    await createCheckpoint(recovered.row, chatId, turn).catch(() => undefined);
  }
  return recovered.row;
}

/**
 * Put the working tree back as it was before `turn`. The current state is
 * snapshotted first under `<chatId>-undo`, so a restore can itself be undone
 * by hand; the branch, HEAD and the real index are never moved.
 */
export async function restoreCheckpoint(chatId: string, turn: number): Promise<void> {
  const chat = await getChat(chatId);
  if (!chat) throw new WorkbenchError('Chat not found', 404, 'not_found');
  const wb = await getWorkbench(chat.workbenchId);
  if (!wb) throw new WorkbenchError('Session not found', 404, 'not_found');
  if (wb.runtime === 'local') throw localRuntimeError();
  if (wb.status !== 'ready') throw new WorkbenchError('The session is not ready.', 409, 'not_ready');
  if (chat.status === 'running') {
    throw new WorkbenchError('Stop the running turn before restoring a checkpoint.', 409, 'chat_running');
  }
  const cp = await getCheckpoint(chatId, turn);
  if (!cp) throw new WorkbenchError(`No checkpoint for turn ${turn}.`, 404, 'checkpoint_not_found');

  const undo = checkpointCreateSteps({
    chatId: `${chatId}-undo`,
    turn,
    tmpIndexPath: tmpIndexPath(chatId, turn, 'undo'),
  });
  const steps = [...undo, ...checkpointRestoreSteps({ sha: cp.sha, tmpIndexPath: tmpIndexPath(chatId, turn, 'restore') })];
  const r = await runGitSteps(wb, steps, { quiet: true, timeoutMs: 120_000 });
  if (r.exitCode !== 0) {
    throw new Error(`restoring the checkpoint failed (exit ${r.exitCode}): ${r.stderr.slice(-300)}`);
  }
  const stored = await appendEvents(chatId, [
    {
      turn: chat.turnCount,
      event: { type: 'system', subtype: 'checkpoint_restored', talyn: { turn, sha: cp.sha } },
    },
  ]);
  emitWorkbenchEvents(chat.workspaceId, chatId, stored);
  await refreshDiffStat(wb);
}

// ============================================================================
// Cancel and the boot sweep
// ============================================================================

/**
 * Stop the running turn. The kill goes to the sandbox by marker, so it works
 * whether or not this process is the one following the turn. When nothing
 * here is following it, the chat is settled here as well — otherwise the
 * follower's own ending settles it.
 */
export async function cancelTurn(chatId: string): Promise<void> {
  const chat = await getChat(chatId);
  if (!chat) throw new WorkbenchError('Chat not found', 404, 'not_found');
  const wb = await getWorkbench(chat.workbenchId);
  if (!wb) throw new WorkbenchError('Session not found', 404, 'not_found');
  if (wb.runtime === 'local') throw localRuntimeError();
  const live = liveTurns.get(chatId);
  if (live) live.cancelRequested = true;
  if (chat.status !== 'running' && !live) return;
  const lease = await getTurnLease(chatId);
  if (lease && lease.turn !== chat.turnCount) return;
  if (wb.sandboxId) {
    const marker = lease?.heartbeat ? await durableMarker(wb, turnLogKey(chatId, lease.turn, lease.attempt),
      turnMarker(chatId, lease.turn, lease.attempt), turnMarker(chatId)) : turnMarker(chatId);
    await killMarker(wb, marker);
  }
  if (!live) {
    const fin = await finishTurn(chatId, { finalStatus: 'idle', statusMessage: 'Cancelled', drain: false, turn: chat.turnCount });
    if (fin) {
      emitWorkbenchChat(fin.chat.workspaceId, rowToChat(fin.chat));
      if (wb.sandboxId) for (const attempt of [0, 1]) {
        await removeDurableExec(wb, turnLogKey(chatId, chat.turnCount, attempt), turnMarker(chatId, chat.turnCount, attempt))
          .catch((error) => recordWorkbenchEvent(wb, 'turn_cleanup_failed', 'The finished turn log could not be removed.', false, error));
      }
    }
  }
}

/** Abort every follower this process holds for a workbench (archive, delete). */
export async function cancelAllTurns(chatIds: string[]): Promise<void> {
  await Promise.all(chatIds.map((id) => cancelTurn(id).catch(() => undefined)));
}

export const ORPHAN_MESSAGE = 'The agent stopped unexpectedly.';
export const LEGACY_INTERRUPTED_MESSAGE = 'This turn was interrupted by an update; send your message again.';

export function turnLogKey(chatId: string, turn: number, attempt: number): string {
  return `${chatId}-${turn}-${attempt}`;
}
function handoffOutcome(): TurnOutcome {
  return { status: 'running', statusMessage: null, cancelled: false, handedOff: true };
}

async function finishSuccessfulAgent(
  wb: WorkbenchRow, chatId: string, message: WorkbenchQueuedMessage,
  text: string, events: EventBatcher, live: LiveTurn,
): Promise<void> {
  if (live.cancelRequested || isWorkbenchDetached()) return;
  if (!(await renewTurnLease(chatId, live.turn)) || await hasTurnEvent(chatId, live.turn, 'talyn_pr')) return;
  const fresh = (await getWorkbench(wb.id)) ?? wb;
  if (message.intent === 'create_pr' || (wb.settings?.autoCreatePr !== false &&
      (await getChat(chatId))?.status !== 'awaiting_input' && !fresh.pullRequestId && parseAutoPrDetails(text).ok)) {
    events.add(await openPullRequestFromTurn(fresh, text));
    await events.flush();
  }
}

async function resumeTurn(chatId: string, lease: TurnLease, legacyTurn: boolean): Promise<TurnOutcome> {
  const chat = await getChat(chatId);
  const wb = chat ? await getWorkbench(chat.workbenchId) : null;
  if (!chat || !wb) return handoffOutcome();
  const live: LiveTurn = { turn: lease.turn, controller: new AbortController(), cancelRequested: false };
  liveTurns.set(chatId, live);
  const events = new EventBatcher(chat.workspaceId, chatId, lease.turn);
  const parser = createAgentStreamParser(chat.agent === 'codex' ? 'codex' : 'claude', lease.parser);
  try {
    // Replay the saved prefix into the parser only. Codex keeps tool state between lines.
    const key = turnLogKey(chatId, lease.turn, lease.attempt);
    const exists = await durableExecExists(wb, key);
    if (!exists && lease.message) {
      const requeued = await requeueTurn(chatId, lease.message, lease.turn);
      if (requeued) emitWorkbenchChat(chat.workspaceId, rowToChat(requeued));
      return { status: 'idle', statusMessage: null, cancelled: false, requeued: true };
    }
    if (!exists && !lease.message) {
      if (!legacyTurn) {
        events.add(errorResultEvent('error_during_execution', ORPHAN_MESSAGE));
        await events.flush();
        return { status: 'error', statusMessage: ORPHAN_MESSAGE, cancelled: false };
      }
      events.add({ type: 'system', subtype: 'turn_interrupted', text: LEGACY_INTERRUPTED_MESSAGE });
      await events.flush();
      return { status: 'idle', statusMessage: LEGACY_INTERRUPTED_MESSAGE, cancelled: true };
    }
    if (!lease.parser && lease.offset > 0) {
      await followDurableExec(wb, key, turnMarker(chatId, lease.turn, lease.attempt), 0, async (record) => {
        if (record.stream === 'stdout') parser.push(record.line);
      }, live.controller.signal, lease.offset, turnMarker(chatId));
    }
    const outcome = await followTurnOutput(wb, chat, lease.turn, lease.attempt, parser, lease.offset, live.controller.signal);
    if (live.controller.signal.aborted || isWorkbenchDetached()) return handoffOutcome();
    if (live.cancelRequested) return cancelledOutcome(events, Boolean(parser.result));
    if (outcome.exitCode === 0 && !parser.result?.isError) {
      if (lease.message) await finishSuccessfulAgent(wb, chatId, lease.message, parser.result?.text ?? '', events, live);
      return { status: 'idle', statusMessage: null, cancelled: false };
    }
    const why = outcome.exitCode === 125 ? ORPHAN_MESSAGE :
      parser.result?.text?.trim() || outcome.stderrTail.trim() || `The agent exited with code ${outcome.exitCode}.`;
    if (!parser.result?.isError && !(await hasTurnEvent(chatId, lease.turn, 'result', true))) {
      events.add(errorResultEvent('error_during_execution', why));
    }
    await events.flush();
    return { status: 'error', statusMessage: why, cancelled: false };
  } catch (err) {
    if (live.controller.signal.aborted || isWorkbenchDetached()) return handoffOutcome();
    if (!(err instanceof FleetRunNotFoundError)) {
      recordWorkbenchEvent(wb, 'turn_handoff', 'The turn follower will reconnect.', false, err);
      return handoffOutcome();
    }
    events.add(errorResultEvent('error_during_execution', SANDBOX_LOST_MESSAGE));
    await events.flush();
    return { status: 'error', statusMessage: SANDBOX_LOST_MESSAGE, cancelled: true };
  } finally { liveTurns.delete(chatId); }
}

/** Claim stale leases. A legacy process remains authoritative while its agent is alive. */
export async function sweepOrphanedTurns(): Promise<number> {
  if (isWorkbenchDraining()) return 0;
  let adopted = 0;
  for (const lease of await turnLeases()) {
    if (liveTurns.has(lease.id)) continue;
    if (lease.heartbeat && Date.now() - lease.heartbeat.getTime() <= 90_000) continue;
    try {
      const wb = await getWorkbench(lease.workbenchId);
      if (!wb || wb.runtime === 'local' || !wb.sandboxId) continue;
      if (!lease.heartbeat) {
        if (Date.now() - lease.updatedAt.getTime() < 3 * 60_000) continue;
        if (await isMarkerAlive(wb, turnMarker(lease.id))) continue;
      }
      if (!(await claimTurnLease(lease))) continue;
      const claimed = await getTurnLease(lease.id);
      if (!claimed) continue;
      adopted++;
      const first = { message: claimed.message ?? { id: 'legacy', text: '', queuedAt: new Date().toISOString() }, turn: claimed.turn };
      void runWithoutScope(() => runTurnLoop(claimed.id, first, claimed, lease.heartbeat === null)).catch((err) => {
        console.error(`[workbench] resuming chat ${claimed.id} failed:`, err);
      });
    } catch (err) {
      console.warn(`[workbench] claiming chat ${lease.id} failed:`, err);
    }
  }
  for (const chat of await queuedIdleChats()) await startQueuedIfIdle(chat.id);
  return adopted;
}

async function followTurnOutput(
  wb: WorkbenchRow, chat: ChatRow, turn: number, attempt: number, parser: AgentStreamParser,
  startOffset: number, signal: AbortSignal, onParsed?: () => void,
) {
  let offset = startOffset;
  let sessionId = chat.agentSessionId;
  return followDurableBatches(wb, turnLogKey(chat.id, turn, attempt), turnMarker(chat.id, turn, attempt), offset,
    async (records) => {
      const drafts = records.flatMap(({ record }) => record.stream === 'stdout' ? parser.push(record.line) : []);
      onParsed?.();
      const nextOffset = records[records.length - 1].offset;
      const snapshot = parser.snapshot();
      const stored = await retryBatchWrite(() => appendEvents(chat.id, drafts.map((event) => ({ turn, event })), {
        owner: TURN_OWNER, turn, offset: nextOffset, previousOffset: offset, parser: snapshot,
      }));
      offset = nextOffset;
      emitWorkbenchEvents(chat.workspaceId, chat.id, stored);
      if (parser.sessionId && parser.sessionId !== sessionId) {
        const updated = await getChat(chat.id);
        if (updated) emitWorkbenchChat(chat.workspaceId, rowToChat(updated));
        sessionId = parser.sessionId;
      }
    }, { records: FLUSH_EVENTS, ms: FLUSH_MS, signal, legacyMarker: turnMarker(chat.id) });
}

export async function detachTurnFollowers(): Promise<void> {
  for (const live of liveTurns.values()) live.controller.abort();
  await releaseOwnedTurnLeases();
}
