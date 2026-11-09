import { cancelLimitResume, chatLimitAgent, handleChatLimit } from './limitResume.js';
import { assertSandboxAgent, validateAgentModel } from './credentialPolicy.js';
import { archiveIdleSession } from './autoArchive.js';
import { suspendWorkbenchIfExhausted } from '../billing/usage/index.js';
import type { BoxGateError } from '../billing/entitlements.js';
import { existingBoxRefusal } from './boxGate.js';
import { sessionHasTalynMcp } from './talynMcp.js';
import { v4 as uuid } from 'uuid';
import {
  boxRefusalReason,
  buildClaudeArgv,
  buildCodexArgv,
  checkpointCreateSteps,
  checkpointRestoreSteps,
  CLAUDE_SANDBOX_ENV,
  createAgentStreamParser,
  parseAutoPrDetails,
  parsePrDetails,
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
  type WorkbenchCapacityWait,
  type WorkbenchChatStatus,
  type WorkbenchQueuedMessage,
  type WorkbenchStatus,
  type WorkbenchTurnPayer,
  type WorkbenchMessageTrigger,
} from '@talyn/shared';
import { payerRef, turnGitIdentityEnv } from '../teams/payer.js';
import { debugBus, describeError } from '../debugBus.js';
import { withRestorePhase } from './restorePhase.js';
import { startDurableExec, followDurableExec, followDurableBatches, retryBatchWrite, durableExecExists, removeDurableExecs, durableMarker, fenceDurableExec } from './durableExec.js';
import { TURN_OWNER, isWorkbenchDraining, isWorkbenchDetached } from './ownership.js';
import { runWithoutScope } from '../../db/client.js';
import { scheduleAgentBackup } from './agentBackups.js';
import { scheduleTurnInsights } from './turnInsights.js';
import { scheduleTurnUsage } from '../insights/turnUsage.js';
import { clearRecoveryRecap, recoveryRecap, RESUME_FAILED_RECAP_HEADER } from './agentRecap.js';
import { isResumeFailure } from './resumeFailure.js';
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
import { isHibernationFetchFailed, isWakeRefusal, localRuntimeError, notReadyError, userFacingError, WorkbenchError } from './errors.js';
import { capacityWaitDelayMs, PROVISION_CAPACITY_WAIT, WAITING_FOR_SANDBOX_MESSAGE } from './lifecycle.js';
import { isSizeRefusal } from './sandboxSize.js';
import { safeMarker } from './execFraming.js';
import { codexProviderPrelude } from './codexProvider.js';
import { syncInstructionFiles } from './instructions.js';
import { observeSessionFiles, sessionFileProbe } from './sessionFileSync.js';
import { syncSkillPack } from './skillPack.js';
import { notifyThread } from './threads.js';
import { sessionMemoryEnabled } from './memory.js';
import { growOrMove, moveWorkbenchToFreshSandbox, needsFreshGolden } from './move.js';
import { applyPendingResize, pendingResize } from './resize.js';
import { applyPendingRestart, pendingRestart } from './restart.js';
import { linkPullRequest, publicWorkbench } from './prLink.js';
import { openPullRequestFromTurn } from './pullRequest.js';
import { SANDBOX_LOST_MESSAGE } from './recovery.js';
import { FleetRunNotFoundError, type FleetCapacityError, type FleetHttpError, type FleetThrottleError } from '../selfHosted/client.js';
import { selectFleetAccount } from '../selfHosted/accountSelection.js';
import { exhaustedAgentFrom, noteExhaustedAgent, noteRateLimitedAccount, rateLimitedAgentFrom } from '../selfHosted/exhaustedQuota.js';
import {
  killMarker,
  isMarkerAlive,
  recordWorkbenchEvent,
  refreshSandboxCredentials,
  wakeWithCredentials,
  repoDirFor,
  runCapture,
  runGitSteps,
  sandboxScriptEnv,
  startAccountWatch,
  workbenchFleetAccountId,
  fleetClientFor,
} from './sandboxRuntime.js';
import { writeSandboxFiles, type SandboxFile } from './sandboxFiles.js';
import { checkpointWork, noteTurnActivity, settleTurnActivity } from './workCheckpoint.js';
import { sendWebhookSignal } from '../apiWebhooks/signals.js';
import { startTitleGeneration } from './title.js';
import { meterWorkbenchAwake } from './usageMeter.js';
import { followBranchRename, nameBranchBeforePullRequest, startBranchNaming, type BranchNamingInput } from './branchName.js';
import {
  abandonCapacityWait,
  appendEvents,
  busyPayerLogin,
  claimOrEnqueue,
  earlierOtherPayerTurn,
  payerBlockedSiblings,
  finishTurn,
  getChat,
  getCheckpoint,
  isFreshSessionTurn,
  getWorkbench,
  isThread,
  requeueTurn,
  rowToChat,
  updateChat,
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
  type TurnPayerRef,
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

/**
 * chatId → turn loops alive in this process. Wider than `liveTurns`, which is
 * empty between a claim and the first await of a turn: the sweep must never
 * adopt a lease that this process still works on.
 */
const turnLoops = new Map<string, number>();

/**
 * A turn's attempts, across launch failures, an account failover and
 * adoptions. Each attempt has its own log key, and a launch that fails is
 * fenced before the next one, so no attempt can run twice.
 */
export const MAX_TURN_ATTEMPTS = 4;
export const LAUNCH_FAILED_MESSAGE = 'The agent could not start in the sandbox.';
export const LOST_CONTACT_MESSAGE = 'Talyn lost contact with the agent in the sandbox.';
const DEFAULT_LAUNCH_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000];
let launchBackoffMs = DEFAULT_LAUNCH_BACKOFF_MS;

/**
 * Adoptions of one turn by this process that ended in an error before any
 * progress. They back off, and after `MAX_ADOPT_FAILURES` the turn settles,
 * so a box that cannot be reached is not retried silently forever.
 */
const MAX_ADOPT_FAILURES = 5;
const ADOPT_BACKOFF_BASE_MS = 5_000;
const adoptFailures = new Map<string, { turn: number; failures: number; notBefore: number }>();

/** Tests shorten the waits. */
export function setTurnRetryDelaysForTests(delays: readonly number[] | null): void {
  launchBackoffMs = delays ?? DEFAULT_LAUNCH_BACKOFF_MS;
  adoptFailures.clear();
}

/** One log line and one debug event for every lease handoff, release and launch failure. */
function noteTurn(action: string, chatId: string, turn: number, reason: string, error?: unknown): void {
  const line = `[workbench] chat ${chatId.slice(0, 8)} turn ${turn}: ${action.replace(/_/g, ' ')}: ${reason}`;
  if (error === undefined) console.log(line);
  else console.warn(`${line}: ${describeError(error)}`);
  debugBus.recordEvent({
    service: 'workbenches', action, summary: `chat ${chatId.slice(0, 8)} turn ${turn}: ${reason}`,
    ok: error === undefined, ...(error !== undefined ? { error } : {}),
  });
}

async function releaseLease(chatId: string, turn: number, reason: string, error?: unknown): Promise<void> {
  noteTurn('lease_released', chatId, turn, reason, error);
  await releaseTurnLease(chatId, turn);
}

/** Wait between launches; a cancel or an abort ends the wait early. */
async function backoff(ms: number, live: LiveTurn): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && !live.cancelRequested && !live.controller.signal.aborted && !isWorkbenchDetached()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, until - Date.now())));
  }
}

function launchBackoff(attempt: number): number {
  return launchBackoffMs[Math.min(attempt - 1, launchBackoffMs.length - 1)] ?? 0;
}

/** Every attempt's log and pid file for a turn, in one exec. */
async function removeTurnLogs(wb: WorkbenchRow, chatId: string, turn: number): Promise<void> {
  const entries = Array.from({ length: MAX_TURN_ATTEMPTS }, (_, attempt) => ({
    key: turnLogKey(chatId, turn, attempt), marker: turnMarker(chatId, turn, attempt),
  }));
  await removeDurableExecs(wb, entries)
    .catch((error) => recordWorkbenchEvent(wb, 'turn_cleanup_failed', 'The finished turn log could not be removed.', false, error));
}

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
 *
 * `payer`: a teammate who prompts from a space and pays for the turn (Teams
 * and Spaces). Absent means the owner. One payer per box: while another chat
 * of the box runs a turn paid by somebody else, the message waits in the
 * queue and `waitingFor` names that person's GitHub login. It starts when
 * their turn ends.
 */
export async function sendMessage(
  chatId: string,
  input: SendWorkbenchMessageInput,
  opts: { origin?: 'talyn'; sentAt?: string; resumeVersion?: number; payer?: WorkbenchTurnPayer; trigger?: WorkbenchMessageTrigger } = {},
): Promise<{ queued: boolean; waitingFor?: string }> {
  const receivedAt = opts.sentAt ?? new Date().toISOString();
  const chat = await getChat(chatId);
  if (!chat) throw new WorkbenchError('Chat not found', 404, 'not_found');
  const wb = await getWorkbench(chat.workbenchId);
  if (!wb) throw new WorkbenchError('Session not found', 404, 'not_found');
  if (wb.runtime === 'local') throw localRuntimeError();
  // Only a workbench still starting may queue: a failed or archived one has no
  // box coming, so a queued message would wait forever.
  if (wb.archivedAt || wb.status === 'archived') throw notReadyError('archived');
  if (wb.status !== 'ready' && !workbenchQueuesMessages(wb.status as WorkbenchStatus)) throw notReadyError(wb.status);
  const message = { ...normaliseMessage(input), queuedAt: receivedAt };
  validateAgentModel(chat.agent, turnModelFor(message, chat, wb));
  if (wb.status === 'ready') assertSandboxAgent(wb, chat.agent === 'codex' ? 'codex' : 'claude');
  // Never from a request body: only Talyn's own callers write a Talyn message.
  if (opts.origin === 'talyn') message.origin = 'talyn';
  if (opts.origin === 'talyn' && opts.trigger) message.trigger = opts.trigger;
  if (opts.payer) message.payer = opts.payer;
  const payer = payerRef(message.payer);
  // A person's message that would start a turn now asks the plan first, so
  // the route can answer 402 and the composer keeps the text. A message
  // behind a running turn just queues: that turn's box is already paid for,
  // and the next turn start asks then. Talyn's own messages never throw
  // here; their turn start holds them in the queue instead.
  if (wb.status === 'ready' && chat.status !== 'running' && opts.origin !== 'talyn') {
    const refusal = await existingBoxRefusal(wb, false, payer);
    if (refusal) throw refusal;
  }
  const claim = await claimOrEnqueue(chatId, message, wb.status === 'ready', opts.resumeVersion);
  if (!claim) throw new WorkbenchError('Chat not found', 404, 'not_found');
  emitWorkbenchChat(chat.workspaceId, rowToChat(claim.chat));
  if (claim.started) {
    if (!claim.started.message.capacityWait) {
      sendWebhookSignal({ kind: 'turn_started', workspaceId: chat.workspaceId, chatId, turn: claim.started.turn });
    }
    launchTurnLoop(chatId, claim.started);
  }
  const waitingFor = claim.payerBlocked
    ? await busyPayerLogin(chatId, claim.chat.queuedMessages[0]?.payer?.userId ?? null)
    : null;
  return { queued: claim.started?.message.id !== message.id, ...(waitingFor ? { waitingFor } : {}) };
}

/** Start the head of the queue when nothing is running — after a provision, or a cancel. */
export async function startQueuedIfIdle(chatId: string): Promise<boolean> {
  if (isWorkbenchDraining()) { await markDrainPending(chatId); return false; }
  const claim = await claimOrEnqueue(chatId, null, true);
  if (!claim?.started) {
    if (claim) await archiveIdleSession(claim.chat.workbenchId);
    return false;
  }
  emitWorkbenchChat(claim.chat.workspaceId, rowToChat(claim.chat));
  // A message that waits for a free sandbox started its turn once already: a retry is not a new turn.
  if (!claim.started.message.capacityWait) {
    sendWebhookSignal({ kind: 'turn_started', workspaceId: claim.chat.workspaceId, chatId, turn: claim.started.turn });
  }
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
  turnLoops.set(chatId, (turnLoops.get(chatId) ?? 0) + 1);
  try {
    await runTurnLoopBody(chatId, first, resume, legacyTurn);
  } finally {
    const left = (turnLoops.get(chatId) ?? 1) - 1;
    if (left > 0) turnLoops.set(chatId, left);
    else turnLoops.delete(chatId);
  }
}

async function runTurnLoopBody(
  chatId: string,
  first: { message: WorkbenchQueuedMessage; turn: number },
  resume: TurnLease | undefined,
  legacyTurn: boolean,
): Promise<void> {
  let next: { message: WorkbenchQueuedMessage; turn: number } | null = first;
  let startAttempt = 0;
  let startFailedOver = false;
  while (next) {
    let lost: string | null = null;
    let lostError: unknown;
    const heldTurn: number = next.turn;
    const heartbeat = setInterval(() => {
      if (isWorkbenchDetached()) {
        lost = 'this instance detached';
        liveTurns.get(chatId)?.controller.abort();
        return;
      }
      void renewTurnLease(chatId, heldTurn).then((ok) => {
        if (!ok) { lost = 'another owner holds the lease'; liveTurns.get(chatId)?.controller.abort(); }
      }).catch((err: unknown) => {
        lost = 'the heartbeat could not be written';
        lostError = err;
        liveTurns.get(chatId)?.controller.abort();
      });
    }, 20_000);
    heartbeat.unref();
    let outcome: TurnOutcome;
    try {
      outcome = resume ? await resumeTurn(chatId, resume, legacyTurn) : await runOneTurn(chatId, next.message, next.turn, startAttempt, startFailedOver);
      resume = undefined;
      startAttempt = 0;
      startFailedOver = false;
    } catch (error) {
      await releaseLease(chatId, heldTurn, 'the turn follower failed', error);
      return;
    } finally { clearInterval(heartbeat); }
    // Before the lease checks: nothing ran, and a requeue that this instance still owns keeps the message safe across a deploy.
    if (outcome.capacityWait) {
      await requeueForSandbox(chatId, next.message, heldTurn, outcome.capacityWait);
      return;
    }
    if (lost || isWorkbenchDetached() || outcome.handedOff) {
      await releaseLease(chatId, heldTurn, lost ?? outcome.handoffReason ?? 'this instance detached', lostError ?? outcome.handoffError);
      return;
    }
    // The adopted attempt never started: run the turn again here, as its next attempt.
    if (outcome.relaunch) {
      startAttempt = outcome.relaunch.attempt;
      startFailedOver = outcome.relaunch.failedOver ?? false;
      next = { message: outcome.relaunch.message, turn: heldTurn };
      continue;
    }
    // Back in the queue, held by the plan: nothing restarts it until a person
    // sends again or the budget comes back. Restarting here would loop.
    if (outcome.held) return;
    // Back in the queue: the move that is running starts it when it ends.
    if (outcome.requeued) { await startQueuedIfIdle(chatId); return; }
    // T3: a turn that failed on a full disk is not run again (its side effects
    // could repeat); the box is made usable and the user sends it again.
    if (outcome.diskFull && !outcome.cancelled) await recoverTurnFromDiskFull(chatId);
    else if (outcome.agentSaysDiskFull && !outcome.cancelled && (await diskFullConfirmed(chatId))) {
      await recoverTurnFromDiskFull(chatId);
    }
    const fin = await finishTurn(chatId, {
      finalStatus: outcome.status,
      statusMessage: outcome.statusMessage,
      drain: !outcome.cancelled,
      owner: TURN_OWNER,
      turn: heldTurn,
    });
    adoptFailures.delete(chatId);
    if (fin) await startPayerBlockedSiblings(fin.chat.workbenchId, chatId);
    if (fin) {
      emitWorkbenchChat(fin.chat.workspaceId, rowToChat(fin.chat));
      sendWebhookSignal({ kind: 'turn_completed', workspaceId: fin.chat.workspaceId, chatId, turn: heldTurn, finalStatus: outcome.status });
      if (fin.started) sendWebhookSignal({ kind: 'turn_started', workspaceId: fin.chat.workspaceId, chatId, turn: fin.started.turn });
      await archiveIdleSession(fin.chat.workbenchId);
      await suspendIfOutOfBudget(fin.chat.workbenchId);
    }
    if (fin) {
      scheduleAgentBackup(chatId);
      // The time report and setup learning: in the background, never in the turn's way.
      scheduleTurnInsights(chatId, heldTurn);
      scheduleTurnUsage(chatId, heldTurn);
      const wb = await getWorkbench(fin.chat.workbenchId);
      if (wb?.sandboxId) await removeTurnLogs(wb, chatId, heldTurn);
    }
    void afterTurn(fin?.chat ?? null, outcome.succeeded);
    if (outcome.statusMessage === SANDBOX_LOST_MESSAGE && fin) {
      const wb = await getWorkbench(fin.chat.workbenchId);
      if (wb?.status === 'ready') await startQueuedIfIdle(chatId);
    }
    if (fin && !fin.started && !outcome.cancelled && outcome.status === 'error' &&
        outcome.statusMessage && chatLimitAgent(fin.chat, outcome.statusMessage)) {
      await handleChatLimit(fin.chat, outcome.statusMessage).catch((err) => {
        console.warn(`[workbench] resuming chat ${chatId} failed:`, err);
      });
    }
    next = fin?.started ?? null;
  }
}

/**
 * After a turn: start the chats of the box that waited because this turn's
 * payer held it (one payer per box). The claim checks again, so a chat whose
 * payer is still busy stays queued. Never fails the turn.
 */
async function startPayerBlockedSiblings(workbenchId: string, chatId: string): Promise<void> {
  try {
    for (const sibling of await payerBlockedSiblings(workbenchId, chatId)) await startQueuedIfIdle(sibling.id);
  } catch (err) {
    console.warn(`[workbench] starting the chats that waited for chat ${chatId} failed:`, err);
  }
}

/** After a turn: an owner out of budget does not keep an awake box. Never fails the turn. */
async function suspendIfOutOfBudget(workbenchId: string): Promise<void> {
  try {
    await suspendWorkbenchIfExhausted(workbenchId);
  } catch (err) {
    console.warn(`[workbench] budget check after a turn on ${workbenchId} failed:`, err);
  }
}

/** After a turn: the diff stat and the PR link may both have moved. Best effort. */
async function afterTurn(chat: ChatRow | null, succeeded?: BranchNamingInput): Promise<void> {
  if (!chat) return;
  try {
    let wb = await getWorkbench(chat.workbenchId);
    if (!wb) return;
    settleTurnActivity(wb.id);
    // A thread has no diff, checkpoint, pull request or branch.
    if (isThread(wb)) return;
    wb = await refreshDiffStat(wb);
    // After the stat, not beside it: two git reads at once on a box near its memory ceiling is worse than a second's wait.
    void checkpointWork(wb, 'turn_end');
    // The thread hears about a new pull request in the `session_finished` wake below, not in a second one.
    const linked = await linkPullRequest(wb, { notifyThread: false });
    if (linked.pullRequestId !== wb.pullRequestId) await emitWorkbenchUpdated(await publicWorkbench(linked));
    if (linked.threadId) {
      if (linked.pullRequestId && linked.pullRequestId !== wb.pullRequestId) await notifyThread(linked, 'pr_opened', { wake: false });
      // A queued message already started the next turn: the thread hears when that one ends.
      if (chat.status !== 'running') await notifyThread(linked, 'session_finished', { status: chat.status });
    }
    // The turn may have fixed the PR, so the merge queue and auto-keep look again.
    if (linked.pullRequestId) notifyPrSessionChanged(linked.workspaceId, linked.pullRequestId, 'session:turn_end');
    // After the link: a PR this turn opened keeps the branch its name.
    if (succeeded && linked.runtime === 'sandbox') startBranchNaming(linked.id, succeeded);
    // A resize or a restart asked for during this turn. When a queued message already started the next turn, its start applies it.
    // A resize makes a fresh box too, so it answers a restart asked for before it.
    if (chat.status !== 'running') {
      const latest = await getWorkbench(chat.workbenchId);
      if (latest && pendingResize(latest)) {
        void applyPendingResize(latest).catch((err) => console.warn(`[workbench] resizing ${latest.id} after a turn failed:`, err));
      } else if (latest && pendingRestart(latest)) {
        void applyPendingRestart(latest).catch((err) => console.warn(`[workbench] restarting ${latest.id} after a turn failed:`, err));
      }
    }
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
  /**
   * The agent failed and its own output says the disk is full. That text is
   * not proof (an agent can talk about disks), so the box's free space is
   * measured before Talyn acts on it.
   */
  agentSaysDiskFull?: boolean;
  /** The workbench was moving: the message went back to the queue and nothing ran. */
  requeued?: boolean;
  /** The plan refused the turn's box: the message went back to the queue and nothing ran. */
  held?: boolean;
  handedOff?: boolean;
  /** Why the lease is being given up, for the log line. */
  handoffReason?: string;
  handoffError?: unknown;
  /** The adopted attempt never started: run the turn again, from this attempt. */
  relaunch?: { message: WorkbenchQueuedMessage; attempt: number; failedOver?: boolean };
  /** The agent finished the turn: its message and final text, for the branch name. */
  succeeded?: BranchNamingInput;
  /** The fleet had no room to wake the box: the message goes back to the queue and waits. Nothing ran. */
  capacityWait?: WorkbenchCapacityWait;
}

export const DISK_FULL_MOVED_NOTE =
  'The sandbox ran out of disk space, so Talyn moved this session to a fresh sandbox. Send your message again to continue.';
export const DISK_FULL_GROWN_NOTE =
  'The sandbox ran out of disk space, so Talyn gave it more. Send your message again to continue.';

/**
 * The box's own numbers, after an agent said its disk was full mid-turn: true
 * when less than LOW_DISK_BYTES is free. The probe reads `df`, which works on a
 * full disk. Any failure to measure is false, so nothing moves on a guess.
 */
export async function diskFullConfirmed(chatId: string): Promise<boolean> {
  try {
    const chat = await getChat(chatId);
    const wb = chat ? await getWorkbench(chat.workbenchId) : null;
    if (!wb || wb.status !== 'ready' || !wb.sandboxId) return false;
    const probe = await runCapture(wb, DISK_PROBE_SCRIPT, { cwd: '/', quiet: true, timeoutMs: 60_000, env: { TMPDIR: '/dev/shm' }, diskRecovery: false });
    const disk = parseDiskProbe(probe.stderr);
    return disk !== null && disk.availBytes < LOW_DISK_BYTES;
  } catch (err) {
    console.warn(`[workbench] measuring the disk for chat ${chatId} failed:`, err);
    return false;
  }
}

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

/**
 * The model a turn runs on. Undefined: the agent's own default. The session's
 * model applies only to a chat on the session's agent, so a Codex chat in a
 * Claude session never runs a Claude model.
 */
export function turnModelFor(
  message: Pick<WorkbenchQueuedMessage, 'model'>,
  chat: { agent: string; model: string | null },
  wb: { agent: string; model: string | null },
): string | undefined {
  return message.model ?? chat.model ?? (chat.agent === wb.agent ? wb.model ?? undefined : undefined);
}

/**
 * The transcript line of a user message. `model` is the model the turn runs
 * on (null: the agent's default). Insights reads it, because Codex does not
 * name its model in its own events.
 */
export function userMessageEvent(
  message: WorkbenchQueuedMessage,
  attachments = message.attachments,
  model?: string | null,
): Record<string, unknown> {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: message.text }] },
    talyn: {
      kind: 'user_message',
      messageId: message.id,
      sentAt: message.queuedAt,
      ...(model !== undefined ? { model } : {}),
      ...(message.origin === 'talyn' ? { origin: 'talyn' } : {}),
      // A wake-up or a job exit: the clients show the turn as a system row.
      ...(message.origin === 'talyn' && message.trigger ? { trigger: message.trigger } : {}),
      // Who prompted, for a teammate's turn. The payer's workspace stays on the backend.
      ...(message.payer
        ? { payer: { userId: message.payer.userId, githubLogin: message.payer.githubLogin, avatarUrl: message.payer.avatarUrl } }
        : {}),
      ...(message.intent ? { intent: message.intent } : {}),
      ...(message.planMode !== undefined ? { planMode: message.planMode } : {}),
      ...(attachments ? { attachments: attachments.map((a) => ({ name: a.name, mimeType: a.mimeType, ...(a.path ? { path: a.path } : {}) })) } : {}),
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

async function runOneTurn(chatId: string, message: WorkbenchQueuedMessage, turn: number, firstAttempt = 0, alreadyFailedOver = false): Promise<TurnOutcome> {
  // Nothing has started: the next instance adopts the lease and launches the
  // agent. The chat stays `running` throughout, so no client sees it stop.
  if (isWorkbenchDraining()) return handoffOutcome('draining before the agent started');
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
  // The plan, before anything wakes the box: a turn needs budget, and waking a
  // sleeping box needs a free box slot. A relaunch of a turn that already
  // started is not asked again; a turn already running is never stopped.
  const payer = payerRef(message.payer);
  // One payer per box: a turn of another payer that started first on another
  // chat keeps the box. The claim cannot see a start in the same instant.
  if (early && firstAttempt === 0 && (await earlierOtherPayerTurn(chatId))) {
    return waitForOtherPayer(chatId, message);
  }
  if (early && firstAttempt === 0) {
    const refusal = await existingBoxRefusal(early, message.origin === 'talyn', payer);
    if (refusal) return holdTurn(chatId, message, refusal);
  }
  const live: LiveTurn = { turn, controller: new AbortController(), cancelRequested: false };
  liveTurns.set(chatId, live);
  const events = new EventBatcher(chat.workspaceId, chatId, turn);
  let needsUserMessage = !(await hasTurnEvent(chatId, turn, 'user_message'));
  const hasInlineAttachments = message.attachments?.some((attachment) => attachment.dataBase64) ?? false;
  const stampedModel = early ? turnModelFor(message, chat, early) ?? null : undefined;
  if (needsUserMessage && !hasInlineAttachments) {
    events.add(userMessageEvent(message, message.attachments, stampedModel));
    needsUserMessage = false;
  }
  let parserResult: { isError: boolean; text: string } | null = null;
  let sawResult = false;
  let agentMayBeRunning = false;
  /** Set when the first launch begins. Before it, nothing of this turn ran in the box. */
  let launched = false;
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
    // A resize asked for during an earlier turn, not yet applied: move before the agent starts.
    if (pendingResize(wb)) wb = await applyPendingResize(wb, { ownerChatId: chatId });
    // A restart asked for during an earlier turn, not yet answered by a move: a fresh box before the agent starts.
    if (pendingRestart(wb)) wb = await applyPendingRestart(wb, { ownerChatId: chatId });
    if (live.cancelRequested) return cancelledOutcome(events);

    // A box asleep on its host wakes with its credentials, so the fleet does
    // not fetch them before the boot. A no-op for a box that is awake.
    await wakeWithCredentials(wb);
    // The checkpoint first: it is also the exec that wakes a suspended box,
    // which the credential push below needs. It reports the free disk too (T2).
    // A relaunch keeps the turn's first checkpoint: an earlier attempt may have run.
    const awake = wb;
    const keepCheckpoint = firstAttempt > 0 && Boolean(await getCheckpoint(chatId, turn));
    const fresh = firstAttempt === 0 && turn === 1 && !awake.workCheckpointAt && !awake.workCheckedAt &&
      !awake.workSaveFailedAt && !chat.importedFrom && (await isFreshSessionTurn(awake.id));
    wb = await withRestorePhase(chatId, () => checkpointAndCheckDisk(awake, chatId, turn, fresh || keepCheckpoint), {
      readSandbox: async () => {
        const client = await fleetClientFor(awake.workspaceId, awake.fleetHost);
        return (await client.getSandbox(awake.sandboxId!)).sandbox;
      },
      publish: async () => {
        const current = await getChat(chatId);
        if (current) emitWorkbenchChat(current.workspaceId, rowToChat(current));
      },
    });
    // The box is awake now (an exec wakes a box the fleet suspended), so it is
    // billed, to this turn's payer from here on.
    await meterWorkbenchAwake(wb, { payer });
    if (live.cancelRequested) return cancelledOutcome(events);
    const turnModel = turnModelFor(message, chat, wb);
    const agent = chat.agent === 'codex' ? 'codex' : 'claude';
    validateAgentModel(agent, turnModel);
    // A teammate's commits are theirs. Before the push, so a refusal leaves the box as it was.
    const gitIdentity = payer ? await turnGitIdentityEnv(payer.userId) : {};
    const jobs = [
      refreshSandboxCredentials(wb, { agent, model: turnModel, payer }),
      syncInstructionFiles(wb, agent).catch((err) => {
        if (err instanceof FleetRunNotFoundError) throw err;
        console.warn(`[workbench] syncing instruction files for chat ${chatId} failed:`, err);
        recordWorkbenchEvent(wb, 'instructions_sync', err instanceof Error ? err.message : String(err), false);
      }),
      (async () => {
        // Talyn's own server acts as the owner, so a teammate's turn goes without it.
        const talynTools = !payer && (await sessionHasTalynMcp(wb));
        const talynSkills = await syncSkillPack(wb, { talynTools }).catch((err) => {
          if (err instanceof FleetRunNotFoundError) throw err;
          console.warn(`[workbench] syncing the skill pack for chat ${chatId} failed:`, err);
          recordWorkbenchEvent(wb, 'skill_pack_sync', err instanceof Error ? err.message : String(err), false);
          return false;
        });
        const memory = talynTools && (await sessionMemoryEnabled(wb.workspaceId).catch(() => false));
        return { talynTools, talynSkills, memory };
      })(),
      writeAttachments(wb, chatId, turn, message.attachments ?? []).then((attached) => {
        // Inline files have no path until the sandbox exists. Publish their
        // transcript event only after its preview path is ready to read.
        if (needsUserMessage) {
          events.add(userMessageEvent(message, attached.transcript, turnModel ?? null));
          needsUserMessage = false;
        }
        return attached;
      }),
    ] as const;
    const [refreshed, , { talynTools, talynSkills, memory }, attached] = await Promise.all(jobs).catch(async (err: unknown) => {
      // Finish every write before recovery, a retry, or another turn can start.
      await Promise.allSettled(jobs);
      if (needsUserMessage) {
        events.add(userMessageEvent(message, message.attachments, turnModel ?? null));
        needsUserMessage = false;
      }
      throw err;
    });
    if (refreshed.note) events.add(accountSwitchEvent(refreshed.note));
    if (live.cancelRequested) return cancelledOutcome(events);
    startTitleGeneration(wb, message.text);

    const planMode = message.planMode ?? chat.planMode;
    const model = turnModel;
    const effort = message.effort ?? (chat.effort as WorkbenchQueuedMessage['effort']) ?? DEFAULT_WORKBENCH_EFFORT;
    let resumeSessionId = chat.agentSessionId ?? undefined;
    const text = promptWith(message.text, agent === 'codex' ? attached.other : attached.all);
    // The transcript keeps `message.text`; the hidden instructions reach the agent only.
    let recap = await recoveryRecap(chatId, turn);
    const buildArgv = () => {
      const { prompt, appendSystemPrompt } = workbenchTurnPrompt({
        recap,
        agent,
        text,
        planMode,
        intent: message.intent,
        createPr: { branch: wb.branch, baseBranch: wb.baseBranch, extra: wb.settings?.prompts?.create_pr },
        internetAccess: wb.settings?.internetAccess,
        // A thread has no branch to open a pull request from.
        autoCreatePr: isThread(wb) ? false : wb.settings?.autoCreatePr,
        hasPullRequest: Boolean(wb.pullRequestId),
        imported: chat.importedFrom ? { root: chat.importedFrom.root || chat.importedFrom.cwd, repoDir: repoDirFor(wb) } : null,
        talynTools,
        talynSkills,
        memory,
        thread: isThread(wb),
      });
      return agent === 'codex'
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
    };
    let argv = buildArgv();
    const env = {
      ...sandboxScriptEnv(wb), ...(agent === 'claude' ? CLAUDE_SANDBOX_ENV : {}), ...gitIdentity, TALYN_TURN_QUEUED_AT: message.queuedAt,
      // The chat Talyn's background and wake-up tools act on.
      TALYN_CHAT_ID: chatId,
    };

    let accountId = refreshed.accountId;
    let outcome!: Awaited<ReturnType<typeof followTurnOutput>>;
    let attemptSawResult = false;
    let recapStarted = false;
    const noteRecapStarted = () => {
      if (recap === undefined || recapStarted) return;
      recapStarted = true;
      recapWrite = clearRecoveryRecap(chatId).catch((err) => {
        console.warn(`[workbench] clearing the recap for chat ${chatId} failed:`, err);
      });
    };
    let attempt = firstAttempt;
    let failedOver = alreadyFailedOver;
    launched = true;
    for (;;) {
      const parser = createAgentStreamParser(agent);
      attemptSawResult = false;
      await events.flush();
      if (!(await setTurnAttempt(chatId, turn, attempt))) return handoffOutcome('another owner holds the lease');
      if (live.controller.signal.aborted || isWorkbenchDetached()) return handoffOutcome('this instance detached');
      if (!(await renewTurnLease(chatId, turn))) return handoffOutcome('another owner holds the lease');
      // From here until the fence answers, an agent may be running in the box.
      agentMayBeRunning = true;
      const command = argv.map(shellQuote).join(' ');
      const script = agent === 'codex' ? `${codexProviderPrelude()}\n${command}` : command;
      const launch = await launchAgent(wb, chatId, turn, attempt, script, env).catch((err: unknown) => {
        if (isDiskFullError(err)) agentMayBeRunning = false;
        throw err;
      });
      if (!launch.started) {
        agentMayBeRunning = false;
        attempt++;
        if (attempt >= MAX_TURN_ATTEMPTS) {
          const why = `${LAUNCH_FAILED_MESSAGE} ${describeError(launch.error)}`.slice(0, 500);
          noteTurn('turn_launch_gave_up', chatId, turn, `${MAX_TURN_ATTEMPTS} attempts did not start`, launch.error);
          events.add(errorResultEvent('error_during_execution', why));
          await events.flush();
          return { status: 'error', statusMessage: why, cancelled: false };
        }
        await backoff(launchBackoff(attempt), live);
        if (live.cancelRequested) return cancelledOutcome(events);
        continue;
      }
      const stopAccountWatch = startAccountWatch(wb, model, (note) => events.add(accountSwitchEvent(note)), agent, payer);
      const stream = followTurnOutput(wb, chat, turn, attempt, parser, 0, live.controller.signal, () => {
        noteRecapStarted();
        if (parser.result) { sawResult = true; attemptSawResult = true; }
      }).finally(stopAccountWatch);
      outcome = await stream;
      if (live.controller.signal.aborted || isWorkbenchDetached()) return handoffOutcome('the follower was stopped');
      agentMayBeRunning = false;
      if (outcome.exitCode === 0) noteRecapStarted();
      parserResult = parser.result;

      if (live.cancelRequested || (outcome.exitCode === 0 && !parserResult?.isError)) break;
      if (attempt + 1 >= MAX_TURN_ATTEMPTS) break;
      const why = parserResult?.text?.trim() || outcome.stderrTail.trim();
      const detail = [parserResult?.text, outcome.stderrTail].filter(Boolean).join('\n');
      // The stored session cannot be resumed, and every turn would fail the same way: run once more in a new session.
      if (resumeSessionId && !outcome.productive && isResumeFailure(`${detail}\n${outcome.errorTail}`, resumeSessionId)) {
        noteTurn('turn_resume_failed', chatId, turn, `session ${resumeSessionId} could not be resumed; starting a new session`);
        if (!attemptSawResult) events.add(errorResultEvent('error_during_execution', why || outcome.errorTail));
        await recapWrite;
        const cleared = await updateChat(chatId, { agentSessionId: null, recapPending: true });
        if (cleared) emitWorkbenchChat(cleared.workspaceId, rowToChat(cleared));
        resumeSessionId = undefined;
        recap = await recoveryRecap(chatId, turn, RESUME_FAILED_RECAP_HEADER);
        recapStarted = false;
        argv = buildArgv();
        events.add({ type: 'system', subtype: 'agent_session_reset', text: SESSION_RESET_NOTE });
        attempt++;
        continue;
      }
      if (failedOver) break;
      // The account this attempt ran on. The row can still name the one from before the turn-start switch.
      const failedAccountId = accountId ?? workbenchFleetAccountId(wb, agent, payer?.userId);
      if (!failedAccountId) break;
      const hop = await failOverAccount(wb, agent, model, failedAccountId, detail, payer);
      if (!hop) break;
      if (!attemptSawResult) events.add(errorResultEvent('error_during_execution', why));
      await events.flush();
      if (live.cancelRequested) break;
      events.add(accountSwitchEvent(hop.note));
      accountId = hop.accountId;
      failedOver = true;
      attempt++;
    }

    if (live.cancelRequested) return cancelledOutcome(events, sawResult);
    if (outcome.exitCode === 0 && !parserResult?.isError) {
      await events.flush();
      await finishSuccessfulAgent(wb, chatId, message, parserResult?.text ?? '', events, live);
      return { status: 'idle', statusMessage: null, cancelled: false, succeeded: { message: message.text, finalMessage: parserResult?.text ?? '' } };
    }
    const why =
      parserResult?.text?.trim() ||
      outcome.stderrTail.trim() ||
      (outcome.exitCode === null || outcome.exitCode === 125
        ? 'The agent stopped unexpectedly.'
        : `The agent exited with code ${outcome.exitCode}.`);
    if (!attemptSawResult) events.add(errorResultEvent('error_during_execution', why));
    await events.flush();
    // The agent's text alone never counts as a full disk: a failure Talyn's own
    // exec or the fleet reports does (see the catch). A match here only asks
    // the caller to measure the box (diskFullConfirmed).
    const agentSaysDiskFull = isDiskFullText(outcome.stderrTail) || isDiskFullText(parserResult?.text ?? '');
    return { status: 'error', statusMessage: why.slice(0, 500), cancelled: false, ...(agentSaysDiskFull ? { agentSaysDiskFull } : {}) };
  } catch (err) {
    if (live.controller.signal.aborted || isWorkbenchDetached()) return handoffOutcome('the follower was stopped', err);
    if (live.cancelRequested) return cancelledOutcome(events, sawResult);
    if (err instanceof FleetRunNotFoundError) {
      events.add(errorResultEvent('error_during_execution', SANDBOX_LOST_MESSAGE));
      await events.flush();
      return { status: 'error', statusMessage: SANDBOX_LOST_MESSAGE, cancelled: true };
    }
    // The box could not wake: no room on its host, the fleet throttles us, or the
    // hibernated copy is not back yet. Wait, as a session start does. A relaunch
    // (attempt > 0) has logs in the box, so it does not.
    if (!launched && firstAttempt === 0 && isWakeRefusal(err) && !isSizeRefusal(err)) {
      return capacityWaitOutcome(early, chatId, message, turn, err, events);
    }
    if (agentMayBeRunning) return handoffOutcome('the agent may be running and its log could not be followed', err);
    // userFacingError, so a fleet answer such as hibernation_fetch_failed reads
    // as plain words and not as the fleet's raw refusal.
    const why = userFacingError(err);
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

/**
 * One hop to another account of the same agent after a rate limit or a spent
 * quota. Null when the failure is anything else, or no other account has usage.
 * Shared by the live attempt loop and a turn that a new instance adopted.
 */
async function failOverAccount(
  wb: WorkbenchRow,
  agent: 'claude' | 'codex',
  model: string | undefined,
  failedAccountId: string,
  detail: string,
  payer: TurnPayerRef | null = null,
): Promise<{ accountId: string; note: string } | null> {
  const exhausted = exhaustedAgentFrom(detail) === agent;
  if (!exhausted && rateLimitedAgentFrom(detail) !== agent) return null;
  // A teammate's limit is held on the teammate's workspace, and the hop is among their accounts.
  const workspaceId = payer?.workspaceId ?? wb.workspaceId;
  if (exhausted) await noteExhaustedAgent(workspaceId, agent, detail, failedAccountId);
  // Stored on the account, so the next turn start leaves it too, even when no hop was possible.
  else await noteRateLimitedAccount(failedAccountId, detail);
  const selection = await selectFleetAccount(workspaceId, agent, { model, avoidAccountIds: [failedAccountId] });
  if (!selection.account || selection.account.id === failedAccountId) return null;
  const oldLabel = selection.accounts.find((a) => a.id === failedAccountId)?.label ?? agent;
  const next = await refreshSandboxCredentials(wb, { agent, model, avoidAccountIds: [failedAccountId], payer });
  if (!next.accountId || next.accountId === failedAccountId) return null;
  const nextLabel = selection.accounts.find((a) => a.id === next.accountId)?.label ?? next.accountId;
  const limit = exhausted ? 'ran out of usage' : 'hit its rate limit';
  return {
    accountId: next.accountId,
    note: `${agent === 'claude' ? 'Claude' : 'Codex'} account “${oldLabel}” ${limit}. Retrying on “${nextLabel}”.`,
  };
}

export const SESSION_RESET_NOTE = 'The agent could not resume its earlier session, so Talyn started a new one.';

export const TURN_HELD_NOTE = 'Talyn did not start this message. It stays in the queue: send a message to try again.';

/**
 * Give the turn back to the queue: another payer's turn started first on
 * another chat of the box. The chat is marked to drain, so the end of that
 * turn, or the turn sweep, starts this one. Nothing ran.
 */
async function waitForOtherPayer(chatId: string, message: WorkbenchQueuedMessage): Promise<TurnOutcome> {
  const requeued = await requeueTurn(chatId, message);
  if (requeued) emitWorkbenchChat(requeued.workspaceId, rowToChat(requeued));
  noteTurn('turn_payer_wait', chatId, requeued?.turnCount ?? 0, 'another payer holds the box');
  return { status: 'idle', statusMessage: null, cancelled: false, requeued: true, held: true };
}

/** Give the turn back to the queue because the plan refused its box, and say why in the chat. */
async function holdTurn(chatId: string, message: WorkbenchQueuedMessage, refusal: BoxGateError): Promise<TurnOutcome> {
  const requeued = await requeueTurn(chatId, message);
  if (requeued) {
    const stored = await appendEvents(chatId, [
      {
        turn: requeued.turnCount,
        event: { type: 'system', subtype: boxRefusalReason(refusal.code), text: `${refusal.message} ${TURN_HELD_NOTE}` },
      },
    ]);
    emitWorkbenchEvents(requeued.workspaceId, chatId, stored);
    emitWorkbenchChat(requeued.workspaceId, rowToChat(requeued));
  }
  return { status: 'idle', statusMessage: null, cancelled: false, requeued: true, held: true };
}

async function cancelledOutcome(events: EventBatcher, sawResult = false): Promise<TurnOutcome> {
  if (!sawResult) events.add(errorResultEvent('cancelled', 'Stopped.'));
  await events.flush();
  return { status: 'idle', statusMessage: 'Cancelled', cancelled: true };
}

export const NO_FREE_SANDBOX_TURN_MESSAGE = 'No sandbox became free in 30 minutes. Retry the turn when the fleet has room.';
export const WAKING_SANDBOX_MESSAGE = 'Waking the sandbox';
export const SANDBOX_DID_NOT_WAKE_TURN_MESSAGE = 'The sandbox did not wake in 30 minutes. Retry the turn shortly.';

/**
 * Why the box could not wake, in the wait's words. `waking` when the fleet
 * could not fetch the hibernated copy yet, or reports the box as starting (a
 * restore is in progress). Otherwise `capacity`. The read is best effort.
 */
async function wakeRefusalReason(wb: WorkbenchRow | null, err: unknown): Promise<WorkbenchCapacityWait['reason']> {
  if (isHibernationFetchFailed(err)) return 'waking';
  if (!wb?.sandboxId) return 'capacity';
  try {
    const client = await fleetClientFor(wb.workspaceId, wb.fleetHost);
    return (await client.getSandbox(wb.sandboxId)).sandbox.status === 'starting' ? 'waking' : 'capacity';
  } catch {
    return 'capacity';
  }
}

/**
 * A turn whose box could not wake. A refusal that starts the wait, or changes
 * its reason, writes one note to the transcript. Each refusal sets the next
 * try with the session start's backoff. After the start's bound
 * (`PROVISION_CAPACITY_WAIT.maxMs`, counted from the first refusal) the turn
 * fails.
 */
async function capacityWaitOutcome(
  wb: WorkbenchRow | null,
  chatId: string,
  message: WorkbenchQueuedMessage,
  turn: number,
  err: FleetCapacityError | FleetThrottleError | FleetHttpError,
  events: EventBatcher,
): Promise<TurnOutcome> {
  const now = Date.now();
  const prior = message.capacityWait?.turn === turn ? message.capacityWait : undefined;
  const startedAt = prior ? Date.parse(prior.startedAt) : now;
  const left = PROVISION_CAPACITY_WAIT.maxMs - (now - startedAt);
  const reason = await wakeRefusalReason(wb, err);
  if (left <= 0) {
    const why = reason === 'waking' ? SANDBOX_DID_NOT_WAKE_TURN_MESSAGE : NO_FREE_SANDBOX_TURN_MESSAGE;
    noteTurn('turn_capacity_gave_up', chatId, turn, `the box did not wake after ${prior?.attempts ?? 0} tries`, err);
    events.add(errorResultEvent('error_during_execution', `Talyn could not run this turn: ${why}`));
    await events.flush();
    return { status: 'error', statusMessage: why, cancelled: false };
  }
  const attempts = prior?.attempts ?? 0;
  const retryAfterMs = 'retryAfterMs' in err ? err.retryAfterMs : undefined;
  const delay = Math.min(capacityWaitDelayMs(attempts, retryAfterMs), left);
  if (prior?.reason !== reason) {
    const text = reason === 'waking' ? WAKING_SANDBOX_MESSAGE : WAITING_FOR_SANDBOX_MESSAGE;
    events.add({ type: 'system', subtype: 'sandbox_capacity_wait', text });
    if (wb) recordWorkbenchEvent(wb, 'sandbox_capacity_wait', `chat ${chatId.slice(0, 8)} turn ${turn}: ${text}`, false);
  }
  noteTurn('turn_capacity_wait', chatId, turn, `${reason} (${err.name}); trying again in ${Math.round(delay / 1000)} s`);
  await events.flush();
  return {
    status: 'idle', statusMessage: null, cancelled: false,
    capacityWait: {
      turn, startedAt: new Date(startedAt).toISOString(), retryAt: new Date(now + delay).toISOString(),
      attempts: attempts + 1, reason,
    },
  };
}

/**
 * Put the waiting message back at the head of the queue, with its wait. The
 * queue claim does not start it before `retryAt`. This process tries at that
 * time, and the turn sweep tries too, so a deploy loses nothing.
 */
async function requeueForSandbox(chatId: string, message: WorkbenchQueuedMessage, turn: number, wait: WorkbenchCapacityWait): Promise<void> {
  adoptFailures.delete(chatId);
  const requeued = await requeueTurn(chatId, { ...message, capacityWait: wait }, turn);
  if (!requeued) {
    await releaseLease(chatId, turn, 'the chat moved on before its wait for a sandbox was recorded');
    return;
  }
  emitWorkbenchChat(requeued.workspaceId, rowToChat(requeued));
  const timer = setTimeout(() => {
    void runWithoutScope(() => retryWaitingMessage(chatId, message.id)).catch((err) => {
      console.warn(`[workbench] retrying the turn of chat ${chatId} after a wait for a sandbox failed:`, err);
    });
  }, Math.max(0, Date.parse(wait.retryAt) - Date.now()) + 100);
  timer.unref();
}

/** Start the waiting message, when it still waits at the head of the queue. */
async function retryWaitingMessage(chatId: string, messageId: string): Promise<boolean> {
  const chat = await getChat(chatId);
  const head = chat?.queuedMessages[0];
  if (!chat || chat.closedAt || head?.id !== messageId || !head.capacityWait) return false;
  return startQueuedIfIdle(chatId);
}

/** The chat is idle and the head of its queue waits for a free sandbox. */
export function isWaitingForSandbox(chat: Pick<ChatRow, 'status' | 'queuedMessages'>): boolean {
  return chat.status !== 'running' && Boolean(chat.queuedMessages?.[0]?.capacityWait);
}

/**
 * Stop a wait for a free sandbox: on a cancel, an archive, or when the person
 * removes the waiting message. The message leaves the queue and its turn ends
 * as stopped. Null when the chat has no message that waits.
 */
export async function endCapacityWait(chatId: string, messageId?: string): Promise<ChatRow | null> {
  const row = await abandonCapacityWait(chatId, messageId);
  if (!row) return null;
  const stored = await appendEvents(chatId, [{ turn: row.turnCount, event: errorResultEvent('cancelled', 'Stopped.') }]);
  emitWorkbenchEvents(row.workspaceId, chatId, stored);
  emitWorkbenchChat(row.workspaceId, rowToChat(row));
  sendWebhookSignal({ kind: 'turn_completed', workspaceId: row.workspaceId, chatId, turn: row.turnCount, finalStatus: 'idle' });
  return row;
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
  transcript: WorkbenchAttachment[];
}> {
  const all: Array<{ path: string; mimeType: string }> = [];
  const files: SandboxFile[] = [];
  const transcript: WorkbenchAttachment[] = [];
  const relativeDir = '.context/attachments';
  for (const [i, a] of attachments.entries()) {
    if (a.path) {
      all.push({ path: `${repoDirFor(wb)}/${assertRepoPath(a.path)}`, mimeType: a.mimeType });
      transcript.push(a);
      continue;
    }
    const name = inlineAttachmentName(a);
    const path = `${relativeDir}/${safeMarker(chatId)}-${turn}-${i}-${name}`;
    const target = `${repoDirFor(wb)}/${path}`;
    files.push({ path: target, base64: a.dataBase64 ?? '' });
    all.push({ path: target, mimeType: a.mimeType });
    transcript.push({ name: a.name, mimeType: a.mimeType, path });
  }
  if (files.length > 0) {
    const exclude = isThread(wb) ? undefined : [
      // The writer runs from /, and git must run in the checkout.
      `cd ${shellQuote(repoDirFor(wb))}`,
      'exclude=$(git rev-parse --git-path info/exclude)',
      'mkdir -p "$(dirname "$exclude")"',
      'touch "$exclude"',
      `grep -qxF ${shellQuote('.context/')} "$exclude" || printf '%s\\n' ${shellQuote('.context/')} >> "$exclude"`,
    ].join('\n');
    await writeSandboxFiles(wb, files, { before: exclude, timeoutMs: 120_000 });
  }
  const images = all.filter((f) => f.mimeType.startsWith('image/')).map((f) => f.path);
  const other = all.filter((f) => !f.mimeType.startsWith('image/'));
  return { all, images, other, transcript };
}

const IMAGE_ATTACHMENT_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/** A safe file name whose extension agrees with the declared image type. */
function inlineAttachmentName(attachment: WorkbenchAttachment): string {
  const safe = attachment.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 80) || 'file';
  const extension = IMAGE_ATTACHMENT_EXTENSIONS[attachment.mimeType.toLowerCase()];
  if (!extension) return safe;
  const stem = safe.replace(/\.[^.]+$/, '').slice(0, 80 - extension.length) || 'image';
  return `${stem}${extension}`;
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
  skipCheckpoint = false,
): Promise<{ sha: string | null; disk: DiskProbe | null; error: string | null }> {
  observeSessionFiles(wb, '');
  const probeScript = `${DISK_PROBE_SCRIPT}\n${sessionFileProbe(repoDirFor(wb))}`;
  // The first exec still wakes the box and checks its disk.
  if (isThread(wb) || skipCheckpoint) {
    const probe = await runCapture(wb, probeScript, { quiet: true, timeoutMs: 60_000, env: { TMPDIR: '/dev/shm' }, diskRecovery: false });
    observeSessionFiles(wb, probe.stderr);
    return { sha: null, disk: parseDiskProbe(probe.stderr), error: !isThread(wb) && probe.exitCode !== 0 ? probe.stderr : null };
  }
  const steps = checkpointCreateSteps({ chatId, turn, tmpIndexPath: tmpIndexPath(chatId, turn) });
  const r = await runCapture(wb, `${probeScript}\n${toShellScript(steps)}`, {
    quiet: true,
    timeoutMs: 120_000,
    env: { TMPDIR: '/dev/shm' },
    // The caller deals with a full disk itself, knowing which chat is running.
    diskRecovery: false,
  });
  observeSessionFiles(wb, r.stderr);
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
async function checkpointAndCheckDisk(wb: WorkbenchRow, chatId: string, turn: number, skipCheckpoint = false): Promise<WorkbenchRow> {
  const first = await createCheckpoint(wb, chatId, turn, skipCheckpoint).catch((err) => {
    // This exec wakes the box: a box that cannot wake fails every step after it, so the turn waits for room instead.
    if (err instanceof FleetRunNotFoundError || isWakeRefusal(err)) throw err;
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
    await createCheckpoint(recovered.row, chatId, turn, skipCheckpoint).catch(() => undefined);
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
  await cancelLimitResume(chatId);
  const chat = await getChat(chatId);
  if (!chat) throw new WorkbenchError('Chat not found', 404, 'not_found');
  const wb = await getWorkbench(chat.workbenchId);
  if (!wb) throw new WorkbenchError('Session not found', 404, 'not_found');
  if (wb.runtime === 'local') throw localRuntimeError();
  const live = liveTurns.get(chatId);
  if (live) live.cancelRequested = true;
  if (chat.status !== 'running' && !live) {
    // Between two tries of a wait for a free sandbox nothing runs: the wait itself stops.
    await endCapacityWait(chatId);
    return;
  }
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
      sendWebhookSignal({ kind: 'turn_completed', workspaceId: fin.chat.workspaceId, chatId, turn: chat.turnCount, finalStatus: 'idle' });
      await archiveIdleSession(fin.chat.workbenchId);
      await suspendIfOutOfBudget(fin.chat.workbenchId);
      if (wb.sandboxId) await removeTurnLogs(wb, chatId, chat.turnCount);
      await startPayerBlockedSiblings(fin.chat.workbenchId, chatId);
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
function handoffOutcome(reason: string, error?: unknown): TurnOutcome {
  return { status: 'running', statusMessage: null, cancelled: false, handedOff: true, handoffReason: reason,
    ...(error !== undefined ? { handoffError: error } : {}) };
}

/**
 * Launch one attempt. A launcher that gave up does not prove the agent did not
 * start, so the attempt's start marker is fenced: either the agent started
 * (follow it) or it never can (the caller tries the next attempt). A fence
 * that cannot be checked throws, and the turn is handed off undecided.
 */
async function launchAgent(
  wb: WorkbenchRow, chatId: string, turn: number, attempt: number, script: string, env: Record<string, string>,
): Promise<{ started: true } | { started: false; error: unknown }> {
  const key = turnLogKey(chatId, turn, attempt);
  try {
    await startDurableExec(wb, key, turnMarker(chatId, turn, attempt), script, env);
    return { started: true };
  } catch (error) {
    if (error instanceof FleetRunNotFoundError || isDiskFullError(error)) throw error;
    const fence = await fenceDurableExec(wb, key);
    if (fence === 'started') {
      noteTurn('turn_launch_late', chatId, turn, `attempt ${attempt} started after its launcher gave up`);
      return { started: true };
    }
    noteTurn('turn_launch_failed', chatId, turn, `attempt ${attempt} did not start (${fence})`, error);
    return { started: false, error };
  }
}

async function finishSuccessfulAgent(
  wb: WorkbenchRow, chatId: string, message: WorkbenchQueuedMessage,
  text: string, events: EventBatcher, live: LiveTurn,
): Promise<void> {
  if (live.cancelRequested || isWorkbenchDetached() || isThread(wb)) return;
  if (!(await renewTurnLease(chatId, live.turn)) || await hasTurnEvent(chatId, live.turn, 'talyn_pr')) return;
  let fresh = (await getWorkbench(wb.id)) ?? wb;
  if (message.intent === 'rename_branch') fresh = (await followBranchRename(fresh)) ?? fresh;
  if (message.intent === 'create_pr' || (wb.settings?.autoCreatePr !== false &&
      (await getChat(chatId))?.status !== 'awaiting_input' && !fresh.pullRequestId && parseAutoPrDetails(text).ok)) {
    events.add(await openPullRequestFromTurn(await nameBeforePush(fresh, chatId, message, text), text));
    await events.flush();
  }
}

/**
 * The PR is about to push the branch, after which its name is fixed. Name it
 * first, from the agent's own PR title, and return the row as it now is.
 */
async function nameBeforePush(wb: WorkbenchRow, chatId: string, message: WorkbenchQueuedMessage, text: string): Promise<WorkbenchRow> {
  const details = parsePrDetails(text);
  if (wb.runtime !== 'sandbox' || !details.ok) return wb;
  await nameBranchBeforePullRequest(wb.id, { message: message.text, finalMessage: text, suggestion: details.details.title, chatId });
  return (await getWorkbench(wb.id)) ?? wb;
}

async function resumeTurn(chatId: string, lease: TurnLease, legacyTurn: boolean): Promise<TurnOutcome> {
  const chat = await getChat(chatId);
  const wb = chat ? await getWorkbench(chat.workbenchId) : null;
  if (!chat || !wb) return handoffOutcome('the chat or its session is gone');
  const live: LiveTurn = { turn: lease.turn, controller: new AbortController(), cancelRequested: false };
  liveTurns.set(chatId, live);
  const events = new EventBatcher(chat.workspaceId, chatId, lease.turn);
  const parser = createAgentStreamParser(chat.agent === 'codex' ? 'codex' : 'claude', lease.parser);
  try {
    // Replay the saved prefix into the parser only. Codex keeps tool state between lines.
    const key = turnLogKey(chatId, lease.turn, lease.attempt);
    const exists = await durableExecExists(wb, key);
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
    if (!exists && lease.message) {
      if (isWorkbenchDraining() || isWorkbenchDetached()) return handoffOutcome('draining before the agent started');
      // Fence the attempt first, so its launcher cannot still start an agent beside the next one.
      const fence = await fenceDurableExec(wb, key);
      if (fence !== 'started') {
        const attempt = lease.attempt + 1;
        if (attempt >= MAX_TURN_ATTEMPTS) {
          noteTurn('turn_launch_gave_up', chatId, lease.turn, `${MAX_TURN_ATTEMPTS} attempts did not start`);
          events.add(errorResultEvent('error_during_execution', LAUNCH_FAILED_MESSAGE));
          await events.flush();
          return { status: 'error', statusMessage: LAUNCH_FAILED_MESSAGE, cancelled: false };
        }
        noteTurn('turn_relaunch', chatId, lease.turn, `attempt ${lease.attempt} never started (${fence}); launching attempt ${attempt}`);
        await backoff(launchBackoff(attempt), live);
        if (live.cancelRequested) return cancelledOutcome(events);
        if (live.controller.signal.aborted || isWorkbenchDetached()) return handoffOutcome('this instance detached');
        return { status: 'running', statusMessage: null, cancelled: false, relaunch: { message: lease.message, attempt } };
      }
      noteTurn('turn_launch_late', chatId, lease.turn, `attempt ${lease.attempt} started after its launcher gave up`);
    }
    if (!lease.parser && lease.offset > 0) {
      await followDurableExec(wb, key, turnMarker(chatId, lease.turn, lease.attempt), 0, async (record) => {
        if (record.stream === 'stdout') parser.push(record.line);
      }, live.controller.signal, lease.offset, turnMarker(chatId));
    }
    const outcome = await followTurnOutput(wb, chat, lease.turn, lease.attempt, parser, lease.offset, live.controller.signal,
      () => adoptFailures.delete(chatId));
    if (live.controller.signal.aborted || isWorkbenchDetached()) return handoffOutcome('the follower was stopped');
    if (live.cancelRequested) return cancelledOutcome(events, Boolean(parser.result));
    if (outcome.exitCode === 0 && !parser.result?.isError) {
      if (lease.message) await finishSuccessfulAgent(wb, chatId, lease.message, parser.result?.text ?? '', events, live);
      return {
        status: 'idle', statusMessage: null, cancelled: false,
        succeeded: { message: lease.message?.text ?? '', finalMessage: parser.result?.text ?? '' },
      };
    }
    // A rate limit on an adopted turn moves to another account, as a live one does.
    // Only the first attempt: a later one may already be the hop.
    const payer = payerRef(lease.message?.payer);
    const hopFrom = workbenchFleetAccountId(wb, chat.agent === 'codex' ? 'codex' : 'claude', payer?.userId);
    if (lease.message && lease.attempt === 0 && hopFrom && outcome.exitCode !== 125) {
      const agent = chat.agent === 'codex' ? 'codex' : 'claude';
      const detail = [parser.result?.text, outcome.stderrTail].filter(Boolean).join('\n');
      const model = turnModelFor(lease.message, chat, wb);
      const hop = await failOverAccount(wb, agent, model, hopFrom, detail, payer);
      if (hop) {
        if (!parser.result?.isError && !(await hasTurnEvent(chatId, lease.turn, 'result', true))) {
          events.add(errorResultEvent('error_during_execution', parser.result?.text?.trim() || outcome.stderrTail.trim() || 'The agent stopped.'));
        }
        events.add(accountSwitchEvent(hop.note));
        await events.flush();
        return { status: 'running', statusMessage: null, cancelled: false, relaunch: { message: lease.message, attempt: lease.attempt + 1, failedOver: true } };
      }
    }
    const why = outcome.exitCode === 125 ? ORPHAN_MESSAGE :
      parser.result?.text?.trim() || outcome.stderrTail.trim() || `The agent exited with code ${outcome.exitCode}.`;
    if (!parser.result?.isError && !(await hasTurnEvent(chatId, lease.turn, 'result', true))) {
      events.add(errorResultEvent('error_during_execution', why));
    }
    await events.flush();
    return { status: 'error', statusMessage: why, cancelled: false };
  } catch (err) {
    if (live.controller.signal.aborted || isWorkbenchDetached()) return handoffOutcome('the follower was stopped', err);
    if (!(err instanceof FleetRunNotFoundError)) {
      const failures = noteAdoptFailure(chatId, lease.turn);
      if (failures < MAX_ADOPT_FAILURES) return handoffOutcome(`the adopted turn could not be followed (failure ${failures})`, err);
      noteTurn('turn_lost_contact', chatId, lease.turn, `${failures} adoptions failed`, err);
      adoptFailures.delete(chatId);
      await killMarker(wb, turnMarker(chatId, lease.turn, lease.attempt)).catch(() => undefined);
      if (!(await hasTurnEvent(chatId, lease.turn, 'result', true))) events.add(errorResultEvent('error_during_execution', LOST_CONTACT_MESSAGE));
      await events.flush();
      return { status: 'error', statusMessage: LOST_CONTACT_MESSAGE, cancelled: false };
    }
    events.add(errorResultEvent('error_during_execution', SANDBOX_LOST_MESSAGE));
    await events.flush();
    return { status: 'error', statusMessage: SANDBOX_LOST_MESSAGE, cancelled: true };
  } finally { liveTurns.delete(chatId); }
}

/** Count a failed adoption of `turn` and set when this process may try again. */
function noteAdoptFailure(chatId: string, turn: number): number {
  const prior = adoptFailures.get(chatId);
  const failures = prior && prior.turn === turn ? prior.failures + 1 : 1;
  const delay = Math.min(ADOPT_BACKOFF_BASE_MS * 2 ** (failures - 1), 2 * 60_000);
  adoptFailures.set(chatId, { turn, failures, notBefore: Date.now() + delay });
  return failures;
}

function adoptReason(lease: Omit<TurnLease, 'message' | 'parser'>): string {
  const from = lease.owner === TURN_OWNER ? 'this instance' : lease.owner ? `instance ${lease.owner.slice(0, 8)}` : 'a legacy owner';
  if (!lease.heartbeat) return `${from} left a legacy turn without a heartbeat`;
  if (lease.heartbeat.getTime() === 0) return `${from} released it`;
  return `${from} stopped its heartbeat ${Math.round((Date.now() - lease.heartbeat.getTime()) / 1000)} s ago`;
}

/** Claim stale leases. A legacy process remains authoritative while its agent is alive. */
export async function sweepOrphanedTurns(): Promise<number> {
  if (isWorkbenchDraining()) return 0;
  let adopted = 0;
  for (const lease of await turnLeases()) {
    // Never adopt a turn this process is still working on, whatever its heartbeat says.
    if (liveTurns.has(lease.id) || turnLoops.has(lease.id)) continue;
    if (lease.heartbeat && Date.now() - lease.heartbeat.getTime() <= 90_000) continue;
    const failed = adoptFailures.get(lease.id);
    if (failed && failed.turn === lease.turn && Date.now() < failed.notBefore) continue;
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
      noteTurn('lease_adopted', claimed.id, claimed.turn, `${adoptReason(lease)}; following attempt ${claimed.attempt} from byte ${claimed.offset}`);
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
  startOffset: number, signal: AbortSignal, onStored?: () => void,
) {
  let offset = startOffset;
  let sessionId = chat.agentSessionId;
  // A session is kept for the next turn only once the agent answered in it. A
  // run that failed first may leave a session that cannot be resumed.
  let productive = startOffset > 0 && (await hasTurnEvent(chat.id, turn, 'assistant'));
  // The agent's own error lines on stdout (Codex reports some only there), for the caller's failure checks.
  let errorTail = '';
  const outcome = await followDurableBatches(wb, turnLogKey(chat.id, turn, attempt), turnMarker(chat.id, turn, attempt), offset,
    async (records) => {
      const drafts = records.flatMap<AgentEventDraft | Record<string, unknown>>(({ record }) => {
        if (record.spawned && record.timing) {
          const { queuedAt, spawnedAt } = record.timing;
          if (Number.isFinite(queuedAt) && Number.isFinite(spawnedAt) && spawnedAt >= queuedAt) {
            return [{ type: 'system', subtype: 'agent_spawn', talyn: { kind: 'turn_spawn_timing', startMs: spawnedAt - queuedAt } }];
          }
          return [];
        }
        const parsed = record.stream === 'stdout' ? parser.push(record.line) : [];
        return parsed.map((draft) => {
          if (draft.type !== 'system' || draft.subtype !== 'init' || !record.timing) return draft;
          const { queuedAt, spawnedAt, at } = record.timing;
          if (![queuedAt, spawnedAt, at].every(Number.isFinite) || spawnedAt < queuedAt || at < spawnedAt) return draft;
          return { ...draft, talyn: { kind: 'turn_start_timing', startMs: spawnedAt - queuedAt, initMs: at - spawnedAt } };
        });
      });
      const nextOffset = records[records.length - 1].offset;
      const snapshot = parser.snapshot();
      productive ||= drafts.some(isAgentAnswer) || (parser.result !== null && !parser.result.isError);
      for (const draft of drafts) {
        if (draft.type === 'system' && draft.subtype === 'stderr' && typeof draft.text === 'string') {
          errorTail = `${errorTail}\n${draft.text}`.slice(-4000);
        }
      }
      const stored = await retryBatchWrite(() => appendEvents(chat.id, drafts.map((event) => ({ turn, event })), {
        owner: TURN_OWNER, turn, offset: nextOffset, previousOffset: offset, parser: snapshot,
        sessionId: productive ? parser.sessionId : null,
      }));
      offset = nextOffset;
      onStored?.();
      emitWorkbenchEvents(chat.workspaceId, chat.id, stored);
      noteTurnActivity(wb, drafts);
      if (productive && parser.sessionId && parser.sessionId !== sessionId) {
        const updated = await getChat(chat.id);
        if (updated) emitWorkbenchChat(chat.workspaceId, rowToChat(updated));
        sessionId = parser.sessionId;
      }
    }, { records: FLUSH_EVENTS, ms: FLUSH_MS, signal, legacyMarker: turnMarker(chat.id) });
  return { ...outcome, productive, errorTail: errorTail.trim() };
}

/** The agent said or did something. Claude's synthetic message for an API error does not count. */
function isAgentAnswer(draft: AgentEventDraft | Record<string, unknown>): boolean {
  if (draft.type !== 'assistant' || draft.error || draft.isApiErrorMessage) return false;
  return (draft.message as { model?: unknown } | undefined)?.model !== '<synthetic>';
}

export async function detachTurnFollowers(): Promise<void> {
  for (const [chatId, live] of liveTurns) {
    noteTurn('lease_released', chatId, live.turn, 'this instance is detaching');
    live.controller.abort();
  }
  await releaseOwnedTurnLeases();
}
