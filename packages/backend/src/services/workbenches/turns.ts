import { v4 as uuid } from 'uuid';
import {
  buildClaudeArgv,
  buildCodexArgv,
  checkpointCreateSteps,
  checkpointRestoreSteps,
  CLAUDE_SANDBOX_ENV,
  createAgentStreamParser,
  shellQuote,
  DEFAULT_WORKBENCH_EFFORT,
  WORKBENCH_EFFORTS,
  type AgentEventDraft,
  type SendWorkbenchMessageInput,
  type WorkbenchAttachment,
  type WorkbenchChatStatus,
  type WorkbenchQueuedMessage,
} from '@talyn/shared';
import { runWithoutScope } from '../../db/client.js';
import { assertRepoPath, refreshDiffStat } from './changes.js';
import { emitWorkbenchChat, emitWorkbenchEvents, emitWorkbenchUpdated } from './emit.js';
import { localRuntimeError, notReadyError, WorkbenchError } from './errors.js';
import { safeMarker } from './execFraming.js';
import { linkPullRequest, publicWorkbench } from './prLink.js';
import {
  killMarker,
  recordWorkbenchEvent,
  refreshSandboxCredentials,
  repoDirFor,
  runCapture,
  runGitSteps,
  runStream,
  sandboxScriptEnv,
} from './sandboxRuntime.js';
import {
  appendEvents,
  claimOrEnqueue,
  finishTurn,
  getChat,
  getCheckpoint,
  getWorkbench,
  rowToChat,
  runningChats,
  updateChat,
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
 * The follower is this process. The process in the sandbox is not — it runs
 * detached from the request — so a backend restart loses the view of a turn
 * and not the turn. The boot sweep (`sweepOrphanedTurns`) settles what a dead
 * process left `running`, stopping the orphan so two agents never share one
 * session, and says so in the transcript instead of leaving a silent hang.
 */

/** Events are written in batches: whichever comes first of this many, or this long. */
const FLUSH_EVENTS = 50;
const FLUSH_MS = 500;

/** The environment variable a large attachment chunk travels in. Under the kernel's 128 KiB per-string cap. */
const ATTACHMENT_CHUNK_B64 = 96 * 1024;

interface LiveTurn {
  turn: number;
  controller: AbortController;
  cancelRequested: boolean;
}

/** chatId → the turn this process is following. */
const liveTurns = new Map<string, LiveTurn>();

export function turnMarker(chatId: string): string {
  return safeMarker(`talyn-turn-${chatId}`);
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
  const attachments = Array.isArray(input.attachments) ? input.attachments.map(normaliseAttachment) : undefined;
  return {
    id: uuid(),
    text,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(typeof input.planMode === 'boolean' ? { planMode: input.planMode } : {}),
    ...(typeof input.model === 'string' && input.model.trim() ? { model: input.model.trim() } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
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
  if (wb.status !== 'ready' && wb.status !== 'provisioning') throw notReadyError(wb.status);
  const message = normaliseMessage(input);
  const claim = await claimOrEnqueue(chatId, message, wb.status === 'ready');
  if (!claim) throw new WorkbenchError('Chat not found', 404, 'not_found');
  emitWorkbenchChat(chat.workspaceId, rowToChat(claim.chat));
  if (claim.started) launchTurnLoop(chatId, claim.started);
  return { queued: claim.started?.message.id !== message.id };
}

/** Start the head of the queue when nothing is running — after a provision, or a cancel. */
export async function startQueuedIfIdle(chatId: string): Promise<boolean> {
  const claim = await claimOrEnqueue(chatId, null, true);
  if (!claim?.started) return false;
  emitWorkbenchChat(claim.chat.workspaceId, rowToChat(claim.chat));
  launchTurnLoop(chatId, claim.started);
  return true;
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
): Promise<void> {
  let next: { message: WorkbenchQueuedMessage; turn: number } | null = first;
  while (next) {
    const outcome = await runOneTurn(chatId, next.message, next.turn);
    const fin = await finishTurn(chatId, {
      finalStatus: outcome.status,
      statusMessage: outcome.statusMessage,
      drain: !outcome.cancelled,
    });
    if (fin) emitWorkbenchChat(fin.chat.workspaceId, rowToChat(fin.chat));
    void afterTurn(fin?.chat ?? null);
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
    if (linked.pullRequestId !== wb.pullRequestId) emitWorkbenchUpdated(await publicWorkbench(linked));
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

  constructor(
    private readonly workspaceId: string,
    private readonly chatId: string,
    private readonly turn: number,
  ) {}

  add(draft: AgentEventDraft | Record<string, unknown>): void {
    const { seq: _seq, ...event } = draft as Record<string, unknown>;
    this.pending.push({ turn: this.turn, event });
    if (this.pending.length >= FLUSH_EVENTS) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), FLUSH_MS);
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
          const stored = await appendEvents(this.chatId, batch);
          emitWorkbenchEvents(this.workspaceId, this.chatId, stored);
        })
        .catch((err) => console.error(`[workbench] storing events for chat ${this.chatId} failed:`, err));
    }
    return this.chain;
  }
}

export function userMessageEvent(message: WorkbenchQueuedMessage): Record<string, unknown> {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: message.text }] },
    talyn: {
      kind: 'user_message',
      messageId: message.id,
      ...(message.planMode !== undefined ? { planMode: message.planMode } : {}),
      ...(message.attachments ? { attachments: message.attachments.map((a) => ({ name: a.name, mimeType: a.mimeType })) } : {}),
    },
  };
}

function errorResultEvent(subtype: string, text: string): Record<string, unknown> {
  return { type: 'result', subtype, is_error: true, result: text };
}

async function runOneTurn(chatId: string, message: WorkbenchQueuedMessage, turn: number): Promise<TurnOutcome> {
  const chat = await getChat(chatId);
  if (!chat) return { status: 'error', statusMessage: 'Chat not found', cancelled: false };
  const live: LiveTurn = { turn, controller: new AbortController(), cancelRequested: false };
  liveTurns.set(chatId, live);
  const events = new EventBatcher(chat.workspaceId, chatId, turn);
  events.add(userMessageEvent(message));
  let parserResult: { isError: boolean; text: string } | null = null;
  let sawResult = false;
  try {
    const wb = await getWorkbench(chat.workbenchId);
    if (!wb || wb.status !== 'ready' || !wb.sandboxId) {
      throw new WorkbenchError('The session is not ready.', 409, 'not_ready');
    }
    recordWorkbenchEvent(wb, 'turn_start', `chat ${chatId.slice(0, 8)} turn ${turn}`);

    // The checkpoint first: it is also the exec that wakes a suspended box,
    // which the credential push below needs.
    await createCheckpoint(wb, chatId, turn).catch((err) =>
      console.warn(`[workbench] checkpoint for chat ${chatId} turn ${turn} failed:`, err),
    );
    await refreshSandboxCredentials(wb);
    if (live.cancelRequested) return cancelledOutcome(events);

    const attached = await writeAttachments(wb, chatId, turn, message.attachments ?? []);
    const planMode = message.planMode ?? chat.planMode;
    const model = message.model ?? chat.model ?? wb.model ?? undefined;
    const effort = message.effort ?? (chat.effort as WorkbenchQueuedMessage['effort']) ?? DEFAULT_WORKBENCH_EFFORT;
    const resumeSessionId = chat.agentSessionId ?? undefined;
    const agent = chat.agent === 'codex' ? 'codex' : 'claude';
    const prompt = promptWith(message.text, agent === 'codex' ? attached.other : attached.all);
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
        : buildClaudeArgv({ prompt, model, effort, planMode, resumeSessionId });
    const env = { ...sandboxScriptEnv(wb), ...(agent === 'claude' ? CLAUDE_SANDBOX_ENV : {}) };

    const parser = createAgentStreamParser(agent);
    let sessionId = chat.agentSessionId;
    // The guest sends one frame per line and the demux hands back whole lines,
    // so each goes straight to the parser — no line buffer is needed here.
    const onLine = (line: string) => {
      for (const draft of parser.push(line)) {
        if (draft.type === 'result') sawResult = true;
        events.add(draft);
      }
      if (parser.sessionId && parser.sessionId !== sessionId) {
        sessionId = parser.sessionId;
        void saveSessionId(chatId, sessionId);
      }
    };
    const outcome = await runStream(wb, argv.map(shellQuote).join(' '), {
      marker: turnMarker(chatId),
      cwd: repoDirFor(wb),
      env,
      signal: live.controller.signal,
      onStdoutLine: onLine,
    });
    parserResult = parser.result;

    if (live.cancelRequested) return cancelledOutcome(events, sawResult);
    if (outcome.exitCode === 0 && !parserResult?.isError) {
      await events.flush();
      return { status: 'idle', statusMessage: null, cancelled: false };
    }
    const why =
      parserResult?.text?.trim() ||
      outcome.stderrTail.trim() ||
      (outcome.exitCode === null
        ? 'The agent process ended without reporting an exit code.'
        : `The agent exited with code ${outcome.exitCode}.`);
    if (!sawResult) events.add(errorResultEvent('error_during_execution', why));
    await events.flush();
    return { status: 'error', statusMessage: why.slice(0, 500), cancelled: false };
  } catch (err) {
    if (live.cancelRequested) return cancelledOutcome(events, sawResult);
    const why = err instanceof Error ? err.message : String(err);
    console.warn(`[workbench] turn ${turn} of chat ${chatId} failed:`, err);
    events.add(errorResultEvent('error_during_execution', `Talyn could not run this turn: ${why}`));
    await events.flush();
    return { status: 'error', statusMessage: why.slice(0, 500), cancelled: false };
  } finally {
    liveTurns.delete(chatId);
  }
}

async function cancelledOutcome(events: EventBatcher, sawResult = false): Promise<TurnOutcome> {
  if (!sawResult) events.add(errorResultEvent('cancelled', 'Stopped.'));
  await events.flush();
  return { status: 'idle', statusMessage: 'Cancelled', cancelled: true };
}

async function saveSessionId(chatId: string, sessionId: string): Promise<void> {
  try {
    const row = await updateChat(chatId, { agentSessionId: sessionId });
    if (row) emitWorkbenchChat(row.workspaceId, rowToChat(row));
  } catch (err) {
    console.warn(`[workbench] saving the session id for chat ${chatId} failed:`, err);
  }
}

/** The prompt, with the attached files named so the agent knows where to look. */
function promptWith(text: string, files: Array<{ path: string; mimeType: string }>): string {
  if (files.length === 0) return text;
  const list = files.map((f) => `- ${f.path} (${f.mimeType})`).join('\n');
  return `${text}\n\nAttached files:\n${list}`;
}

/**
 * Put inline attachments on disk in the sandbox, and resolve path ones inside
 * the repository. Inline data travels in env-var chunks, because one argv or
 * env string is capped by the kernel at 128 KiB.
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
  const dir = `/tmp/talyn-attachments/${chatId}/${turn}`;
  for (const [i, a] of attachments.entries()) {
    if (a.path) {
      all.push({ path: `${repoDirFor(wb)}/${assertRepoPath(a.path)}`, mimeType: a.mimeType });
      continue;
    }
    const safeName = `${i}-${a.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}`;
    const target = `${dir}/${safeName}`;
    const data = a.dataBase64 ?? '';
    for (let off = 0; off === 0 || off < data.length; off += ATTACHMENT_CHUNK_B64) {
      const r = await runCapture(
        wb,
        `mkdir -p ${shellQuote(dir)} && printf %s "$TALYN_CHUNK" | base64 -d ${off === 0 ? '>' : '>>'} ${shellQuote(target)}`,
        { cwd: '/', env: { TALYN_CHUNK: data.slice(off, off + ATTACHMENT_CHUNK_B64) }, timeoutMs: 30_000, quiet: true },
      );
      if (r.exitCode !== 0) throw new Error(`could not write attachment ${a.name}: ${r.stderr.slice(-200)}`);
      if (data.length === 0) break;
    }
    all.push({ path: target, mimeType: a.mimeType });
  }
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

/** Snapshot the working tree before a turn, as a hidden commit under `refs/talyn/checkpoints`. */
export async function createCheckpoint(wb: WorkbenchRow, chatId: string, turn: number): Promise<string | null> {
  const steps = checkpointCreateSteps({ chatId, turn, tmpIndexPath: tmpIndexPath(chatId, turn) });
  const r = await runGitSteps(wb, steps, { quiet: true, timeoutMs: 120_000 });
  const sha = r.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (r.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new Error(`checkpoint exited ${r.exitCode}: ${r.stderr.slice(-300)}`);
  }
  const ref = steps.find((s) => s.argv[1] === 'update-ref')?.argv[2] ?? '';
  await upsertCheckpoint({ chatId, turn, ref, sha });
  return sha;
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
  if (wb.sandboxId) {
    await killMarker(wb, turnMarker(chatId)).catch((err) =>
      console.warn(`[workbench] stopping chat ${chatId} failed:`, err),
    );
  }
  if (!live) {
    const fin = await finishTurn(chatId, { finalStatus: 'idle', statusMessage: 'Cancelled', drain: false });
    if (fin) emitWorkbenchChat(fin.chat.workspaceId, rowToChat(fin.chat));
  }
}

/** Abort every follower this process holds for a workbench (archive, delete). */
export async function cancelAllTurns(chatIds: string[]): Promise<void> {
  await Promise.all(chatIds.map((id) => cancelTurn(id).catch(() => undefined)));
}

export const ORPHAN_MESSAGE =
  'The backend restarted while this turn was running, so Talyn lost its view of it and stopped the agent. ' +
  'Any changes it made are still in the session. Send a message to carry on.';

/**
 * Settle chats a dead process left `running`: stop the orphaned agent (two
 * processes on one session would interleave), mark the chat `error` with a
 * reason, and put that reason in the transcript. Chats this process is
 * following are left alone.
 */
export async function sweepOrphanedTurns(): Promise<number> {
  const rows = await runningChats();
  let settled = 0;
  for (const row of rows) {
    if (liveTurns.has(row.id)) continue;
    try {
      const wb = await getWorkbench(row.workbenchId);
      if (wb?.runtime === 'local') continue;
      if (wb?.sandboxId) await killMarker(wb, turnMarker(row.id)).catch(() => undefined);
      const chat = await getChat(row.id);
      const stored = await appendEvents(row.id, [
        { turn: chat?.turnCount ?? 0, event: errorResultEvent('error_during_execution', ORPHAN_MESSAGE) },
      ]);
      emitWorkbenchEvents(row.workspaceId, row.id, stored);
      const fin = await finishTurn(row.id, { finalStatus: 'error', statusMessage: ORPHAN_MESSAGE, drain: false });
      if (fin) emitWorkbenchChat(fin.chat.workspaceId, rowToChat(fin.chat));
      settled++;
    } catch (err) {
      console.warn(`[workbench] settling orphaned chat ${row.id} failed:`, err);
    }
  }
  return settled;
}
