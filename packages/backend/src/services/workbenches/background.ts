import { randomUUID } from 'node:crypto';
import {
  BACKGROUND_COMMAND_MAX_CHARS,
  BACKGROUND_DEFAULT_KEEP_AWAKE_SECONDS,
  BACKGROUND_EXIT_TAIL_LINES,
  BACKGROUND_LOG_TAIL_DEFAULT,
  BACKGROUND_LOG_TAIL_MAX,
  BACKGROUND_MAX_KEEP_AWAKE_SECONDS,
  BACKGROUND_NAME_MAX_CHARS,
  formatDurationMs,
  shellQuote,
  WAKEUP_REASON_MAX_CHARS,
  type ScheduleWorkbenchWakeupInput,
  type StartWorkbenchBackgroundJobInput,
  type WorkbenchBackground,
  type WorkbenchBackgroundJob,
  type WorkbenchBackgroundJobStatus,
  type WorkbenchBackgroundLogs,
  type WorkbenchMessageTrigger,
  type WorkbenchWakeup,
  type WorkbenchWakeupCreatedBy,
} from '@talyn/shared';
import { pidFileFor } from './execFraming.js';
import { durablePaths, fenceDurableExec, startDurableExec } from './durableExec.js';
import { emitWorkbenchBackground } from './emit.js';
import { existingBoxRefusal } from './boxGate.js';
import { localRuntimeError, notReadyError, userFacingError, WorkbenchError } from './errors.js';
import { killMarker, repoDirFor, runCapture, sandboxScriptEnv } from './sandboxRuntime.js';
import { getChat, getWorkbench, listChats, type ChatRow, type WorkbenchRow } from './store.js';
import { payerRef, turnPayerFor } from '../teams/payer.js';
import {
  getJob,
  getWakeup,
  claimWakeup,
  insertJob,
  insertWakeup,
  listJobs,
  listWakeups,
  publicJob,
  publicWakeup,
  setJobKeepAwake,
  settleJob,
  settleWakeup,
  noteJobChecked,
  type JobRow,
  type WakeupRow,
} from './backgroundStore.js';

/**
 * Session background jobs and wake-ups.
 *
 * A job runs under the durable supervisor (`durableExec.ts`), in its own
 * process group, so it outlives the agent CLI that started it. Its log, start
 * marker and exit marker live in the box. The sweep (`backgroundSweep.ts`)
 * reads the exit marker; this file holds the actions and the check itself.
 *
 * A wake-up is a row. The sweep claims it when due and sends an ordinary
 * queued message with `origin: 'talyn'` and a `trigger`, so the turn runs
 * through the normal send path with the stored payer.
 */

/** A session's jobs and wake-ups, as the route and the WS event carry them. */
export async function backgroundOf(workbenchId: string): Promise<WorkbenchBackground> {
  const [jobs, wakeups] = await Promise.all([listJobs(workbenchId), listWakeups(workbenchId)]);
  return { workbenchId, jobs, wakeups };
}

/** Send the session's whole background state to its workspace. Never throws. */
export async function emitBackground(workspaceId: string, workbenchId: string): Promise<void> {
  try {
    emitWorkbenchBackground(workspaceId, await backgroundOf(workbenchId));
  } catch (err) {
    console.warn(`[background] sending the state of ${workbenchId} failed:`, err);
  }
}

// ============================================================================
// Input
// ============================================================================

function bad(message: string, code = 'bad_request'): WorkbenchError {
  return new WorkbenchError(message, 400, code);
}

function wholeSeconds(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw bad(`${field} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

/** Only for a session with a sandbox: a local session runs in the desktop app. */
function requireSandboxSession(row: WorkbenchRow): void {
  if (row.runtime !== 'sandbox') throw localRuntimeError();
  if (row.archivedAt || row.status === 'archived') throw notReadyError('archived');
}

/**
 * The chat a job or wake-up belongs to: the one named, else the session's
 * running chat, else its newest open chat.
 */
export async function resolveChat(row: WorkbenchRow, chatId?: unknown): Promise<ChatRow> {
  if (chatId !== undefined && chatId !== null && chatId !== '') {
    if (typeof chatId !== 'string') throw bad('chatId must be a string.');
    const chat = await getChat(chatId);
    if (!chat || chat.workbenchId !== row.id) throw new WorkbenchError('Chat not found', 404, 'not_found');
    if (chat.closedAt) throw new WorkbenchError('That chat is closed.', 409, 'chat_closed');
    return chat;
  }
  const open = (await listChats(row.id)).filter((c) => !c.closedAt);
  const running = open.filter((c) => c.status === 'running');
  const pick = (running.length ? running : open).at(-1);
  if (!pick) throw new WorkbenchError('This session has no open chat.', 409, 'no_chat');
  return pick;
}

/**
 * Who pays for what a row starts later. An agent's row takes the payer of its
 * chat's running turn: the turn that asked. A person's row is the person's own,
 * and only the owner reaches these routes, so it is the owner (null).
 */
function payerFor(chat: ChatRow, createdBy: WorkbenchWakeupCreatedBy): { payerUserId: string | null; payerWorkspaceId: string | null } {
  if (createdBy === 'agent' && chat.status === 'running' && chat.payerUserId && chat.payerWorkspaceId) {
    return { payerUserId: chat.payerUserId, payerWorkspaceId: chat.payerWorkspaceId };
  }
  return { payerUserId: null, payerWorkspaceId: null };
}

/** A job's payer as the box gate reads it. Null means the session's owner. */
export function jobPayer(job: Pick<JobRow, 'payerUserId' | 'payerWorkspaceId'>): { userId: string; workspaceId: string } | null {
  return job.payerUserId && job.payerWorkspaceId ? { userId: job.payerUserId, workspaceId: job.payerWorkspaceId } : null;
}

// ============================================================================
// Jobs
// ============================================================================

export const backgroundJobKey = (id: string) => `bg-${id}`;
export const backgroundJobMarker = (id: string) => `talyn-bg-${id}`;

function defaultName(command: string): string {
  const first = command.trim().split('\n')[0].trim();
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}

/** Start a command under the durable supervisor, in the session's current box. */
export async function startBackgroundJob(
  row: WorkbenchRow,
  input: StartWorkbenchBackgroundJobInput,
): Promise<WorkbenchBackgroundJob> {
  requireSandboxSession(row);
  const command = typeof input?.command === 'string' ? input.command : '';
  if (!command.trim()) throw bad('A background job needs a command.');
  if (command.length > BACKGROUND_COMMAND_MAX_CHARS) {
    throw bad(`The command is ${command.length} characters. The limit is ${BACKGROUND_COMMAND_MAX_CHARS}, because it reaches the sandbox in one environment variable. Put a long script in a file and run the file.`);
  }
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : defaultName(command);
  if (name.length > BACKGROUND_NAME_MAX_CHARS) throw bad(`The name is over ${BACKGROUND_NAME_MAX_CHARS} characters.`);
  const repoDir = repoDirFor(row);
  const cwdInput = typeof input.cwd === 'string' ? input.cwd.trim() : '';
  const cwd = !cwdInput ? repoDir : cwdInput.startsWith('/') ? cwdInput : `${repoDir}/${cwdInput}`;
  const keepAwakeSeconds = input.keepAwakeSeconds === undefined
    ? BACKGROUND_DEFAULT_KEEP_AWAKE_SECONDS
    : wholeSeconds(input.keepAwakeSeconds, 'keepAwakeSeconds', 0, BACKGROUND_MAX_KEEP_AWAKE_SECONDS);
  if (input.notifyOnExit !== undefined && typeof input.notifyOnExit !== 'boolean') throw bad('notifyOnExit must be true or false.');
  if (row.status !== 'ready' || !row.sandboxId) throw notReadyError(row.status);
  const chat = await resolveChat(row, input.chatId);

  const id = randomUUID();
  const now = new Date();
  // The row first: a job that starts must always have a record to settle.
  const job = await insertJob({
    id,
    workbenchId: row.id,
    chatId: chat.id,
    workspaceId: row.workspaceId,
    sandboxId: row.sandboxId,
    name,
    command,
    cwd,
    status: 'running',
    durableKey: backgroundJobKey(id),
    marker: backgroundJobMarker(id),
    keepAwakeUntil: keepAwakeSeconds > 0 ? new Date(now.getTime() + keepAwakeSeconds * 1000) : null,
    notifyOnExit: input.notifyOnExit ?? true,
    ...payerFor(chat, 'agent'),
    startedAt: now,
  });
  try {
    await startDurableExec(row, job.durableKey, job.marker, `cd ${shellQuote(cwd)} || exit 1\n${command}`, {
      ...sandboxScriptEnv(row),
      TALYN_BACKGROUND_JOB_ID: id,
    }, true);
  } catch (err) {
    // A launch that timed out may still have started. The fence decides, once.
    const fence = await fenceDurableExec(row, job.durableKey).catch(() => 'unwritable' as const);
    if (fence !== 'started') {
      await settleJob(id, { status: 'lost', detail: `The job did not start: ${userFacingError(err)}` });
      await emitBackground(row.workspaceId, row.id);
      throw err;
    }
  }
  await emitBackground(row.workspaceId, row.id);
  return publicJob(job);
}

async function ownedJob(row: WorkbenchRow, jobId: string): Promise<JobRow> {
  const job = await getJob(jobId);
  if (!job || job.workbenchId !== row.id) throw new WorkbenchError('Background job not found', 404, 'not_found');
  return job;
}

/** Why a running job can no longer be running, or null. Facts from the row only. */
export function jobLostReason(job: Pick<JobRow, 'sandboxId'>, row: WorkbenchRow | null): string | null {
  if (!row) return 'The session was deleted.';
  if (row.archivedAt || row.status === 'archived') return 'The session was archived, and its sandbox with it.';
  if (['lost', 'deleted', 'error'].includes(row.sandboxState)) return 'The sandbox was lost.';
  if (row.sandboxId !== job.sandboxId && row.status !== 'moving') {
    return 'The session moved to another sandbox. Running processes do not move with it.';
  }
  return null;
}

/** Stop a job: INT, TERM, then KILL to its process group. */
export async function stopBackgroundJob(row: WorkbenchRow, jobId: string): Promise<WorkbenchBackgroundJob> {
  const job = await ownedJob(row, jobId);
  if (job.status !== 'running') return publicJob(job);
  const lost = jobLostReason(job, row);
  if (lost) {
    const settled = await settleJob(job.id, { status: 'lost', detail: lost });
    await emitBackground(row.workspaceId, row.id);
    return publicJob(settled ?? job);
  }
  await killMarker(row, job.marker);
  const settled = await settleJob(job.id, { status: 'stopped', detail: 'Stopped.' });
  await emitBackground(row.workspaceId, row.id);
  return publicJob(settled ?? (await getJob(job.id)) ?? job);
}

/** Keep the box awake for `seconds` from now. 0 lets it sleep. */
export async function keepJobAwake(row: WorkbenchRow, jobId: string, seconds: unknown): Promise<WorkbenchBackgroundJob> {
  const value = wholeSeconds(seconds, 'seconds', 0, BACKGROUND_MAX_KEEP_AWAKE_SECONDS);
  const job = await ownedJob(row, jobId);
  if (job.status !== 'running') throw new WorkbenchError('The job is not running.', 409, 'job_not_running');
  const updated = await setJobKeepAwake(job.id, value > 0 ? new Date(Date.now() + value * 1000) : null);
  await emitBackground(row.workspaceId, row.id);
  return publicJob(updated ?? (await getJob(job.id)) ?? job);
}

/**
 * Reads the job's state and, on request, the last lines of its log, in one
 * exec. `exited` comes from the exit marker. `gone` means the supervisor's
 * process group is dead with no exit marker; `missing` means the box has no
 * start marker for the job at all.
 */
export const JOB_PROBE = String.raw`
const fs = require('fs');
const p = JSON.parse(process.env.TALYN_LOG_PATHS);
const n = Number(process.env.TALYN_TAIL_LINES || 0), maxBytes = Number(process.env.TALYN_TAIL_BYTES || 0);
const readExit = () => { try { const v = fs.readFileSync(p.exit, 'utf8').trim(); return v === '' ? null : Number(v); } catch { return null; } };
let code = readExit(), state;
if (code !== null) state = 'exited';
else {
  let alive = false;
  try { const pid = Number(fs.readFileSync(process.env.TALYN_PID_FILE, 'utf8')); if (Number.isSafeInteger(pid) && pid > 0) { process.kill(-pid, 0); alive = true; } } catch {}
  if (alive) state = 'running';
  else { code = readExit(); state = code !== null ? 'exited' : fs.existsSync(p.started) ? 'gone' : 'missing'; }
}
let files = [];
try {
  if (fs.statSync(p.log).isDirectory()) {
    files = fs.readdirSync(p.log).filter(s => /^\d+$/.test(s)).map(Number).sort((a, b) => a - b).map(s => p.log + '/' + s);
    for (const old of files.slice(0, -2)) fs.rmSync(old, { force: true });
    files = files.slice(-2);
  } else files = [p.log];
} catch {}
const lines = [];
if (n > 0 && files.length) {
  const chunks = []; let total = 0, partial = false;
  for (let i = files.length - 1; i >= 0 && total < maxBytes; i--) {
    let size; try { size = fs.statSync(files[i]).size; } catch { continue; }
    const take = Math.min(size, maxBytes - total);
    if (take < size) partial = true;
    const fd = fs.openSync(files[i], 'r'); const b = Buffer.alloc(take);
    fs.readSync(fd, b, 0, take, size - take); fs.closeSync(fd);
    chunks.unshift(b); total += take;
  }
  const text = Buffer.concat(chunks).toString('utf8').split('\n');
  if (partial) text.shift();
  for (const l of text) { if (!l) continue; try { const r = JSON.parse(l); if (typeof r.line === 'string' && !r.spawned) lines.push(r.line); } catch {} }
}
process.stdout.write(JSON.stringify({ state, code: Number.isFinite(code) ? code : null, lines: lines.slice(-n) }));
`;

export interface JobProbe {
  state: 'running' | 'exited' | 'gone' | 'missing';
  code: number | null;
  lines: string[];
}

/** One exec into the box. It wakes a sleeping box, so callers decide first. */
export async function probeJob(row: WorkbenchRow, job: Pick<JobRow, 'durableKey' | 'marker'>, tailLines: number): Promise<JobProbe> {
  const result = await runCapture(row, `node -e ${shellQuote(JOB_PROBE)}`, {
    quiet: true,
    cwd: '/',
    timeoutMs: 15_000,
    env: {
      TALYN_LOG_PATHS: JSON.stringify(durablePaths(job.durableKey)),
      TALYN_PID_FILE: pidFileFor(job.marker),
      TALYN_TAIL_LINES: String(tailLines),
      TALYN_TAIL_BYTES: String(Math.min(1024 * 1024, Math.max(64 * 1024, tailLines * 1024))),
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`The job check did not finish (exit ${result.exitCode}).`, { cause: new Error(result.stderr.slice(-500)) });
  }
  const parsed = JSON.parse(result.stdout) as JobProbe;
  if (!['running', 'exited', 'gone', 'missing'].includes(parsed.state)) throw new Error('The job check answered nonsense.');
  return { state: parsed.state, code: typeof parsed.code === 'number' ? parsed.code : null, lines: Array.isArray(parsed.lines) ? parsed.lines : [] };
}

/** Longest log tail in a job's exit message. The agent reads the rest with talyn_background_logs. */
const EXIT_TAIL_MAX_CHARS = 16_000;

function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

/** The text of the turn that reports a job's exit. */
export function jobExitPrompt(job: Pick<JobRow, 'id' | 'name' | 'command' | 'startedAt'>, code: number | null, lines: string[], endedAt: Date): string {
  const ran = formatDurationMs(Math.max(0, endedAt.getTime() - job.startedAt.getTime()));
  let tail = lines.join('\n');
  if (tail.length > EXIT_TAIL_MAX_CHARS) tail = `(cut to the last ${EXIT_TAIL_MAX_CHARS} characters)\n${tail.slice(-EXIT_TAIL_MAX_CHARS)}`;
  const command = job.command.length > 500 ? `${job.command.slice(0, 500)}…` : job.command;
  return [
    `[Talyn] Background job "${job.name}" (id ${job.id}) exited with ${code === null ? 'an unknown code' : `code ${code}`} after ${ran}.`,
    `Command: ${command}`,
    lines.length ? `The last ${lines.length} lines of its output:\n${fenced(tail)}` : 'It printed no output.',
    'Read more of the log with `talyn_background_logs`. Continue the work, or report to the person.',
  ].join('\n');
}

/**
 * Apply what a probe found. A running job records the check; an exited job
 * settles once, and its exit wake-up is inserted and fired. Returns the
 * job's status after the probe.
 */
export async function applyProbe(row: WorkbenchRow, job: JobRow, probe: JobProbe, now = new Date()): Promise<WorkbenchBackgroundJobStatus> {
  if (probe.state === 'running') {
    await noteJobChecked(job.id, now);
    return 'running';
  }
  if (probe.state !== 'exited') {
    const settled = await settleJob(job.id, {
      status: 'lost',
      detail: probe.state === 'gone'
        ? 'The job stopped without an exit code. The sandbox may have restarted, or the system stopped it.'
        : 'The sandbox has no record of the job.',
    }, now);
    if (settled) await emitBackground(row.workspaceId, row.id);
    return 'lost';
  }
  const settled = await settleJob(job.id, { status: 'exited', exitCode: probe.code }, now);
  if (!settled) return ((await getJob(job.id))?.status ?? 'exited') as WorkbenchBackgroundJobStatus;
  let wakeupId: string | null = null;
  if (settled.notifyOnExit) {
    const lines = probe.lines.slice(-BACKGROUND_EXIT_TAIL_LINES);
    const wakeup = await insertWakeup({
      id: randomUUID(),
      workbenchId: settled.workbenchId,
      chatId: settled.chatId,
      workspaceId: settled.workspaceId,
      wakeAt: now,
      reason: `Background job ${settled.name} exited with ${probe.code === null ? 'an unknown code' : `code ${probe.code}`}`,
      prompt: jobExitPrompt(settled, probe.code, lines, now),
      createdBy: 'agent',
      payerUserId: settled.payerUserId,
      payerWorkspaceId: settled.payerWorkspaceId,
      sourceJobId: settled.id,
    });
    wakeupId = wakeup?.id ?? null;
  }
  await emitBackground(row.workspaceId, row.id);
  if (wakeupId) await fireWakeup(wakeupId);
  return 'exited';
}

/**
 * The logs route and tool. Without `live`, a sleeping box is not woken and
 * nothing is read. A read also settles a job that has exited.
 */
export async function readJobLogs(
  row: WorkbenchRow,
  jobId: string,
  opts: { tail?: unknown; live: boolean; asleep: boolean },
): Promise<WorkbenchBackgroundLogs> {
  const tail = opts.tail === undefined ? BACKGROUND_LOG_TAIL_DEFAULT : wholeSeconds(opts.tail, 'tail', 1, BACKGROUND_LOG_TAIL_MAX);
  const job = await ownedJob(row, jobId);
  const base = { jobId: job.id, status: job.status as WorkbenchBackgroundJobStatus, exitCode: job.exitCode };
  if (jobLostReason(job, row)) {
    if (job.status === 'running') {
      await settleJob(job.id, { status: 'lost', detail: jobLostReason(job, row)! });
      await emitBackground(row.workspaceId, row.id);
      return { ...base, status: 'lost', lines: [], asleep: false };
    }
    return { ...base, lines: [], asleep: false };
  }
  if (opts.asleep && !opts.live) return { ...base, lines: [], asleep: true };
  requireSandboxSession(row);
  if (row.status !== 'ready' || !row.sandboxId) throw notReadyError(row.status);
  const probe = await probeJob(row, job, tail);
  const status = job.status === 'running' ? await applyProbe(row, job, probe) : (job.status as WorkbenchBackgroundJobStatus);
  const fresh = await getJob(job.id);
  return { jobId: job.id, status, exitCode: fresh?.exitCode ?? job.exitCode, lines: probe.lines, asleep: false };
}

// ============================================================================
// Wake-ups
// ============================================================================

/** Schedule a wake-up turn. The time must be in the future; there is no upper bound. */
export async function scheduleWakeup(
  row: WorkbenchRow,
  input: ScheduleWorkbenchWakeupInput,
  createdBy: WorkbenchWakeupCreatedBy,
  now = new Date(),
): Promise<WorkbenchWakeup> {
  requireSandboxSession(row);
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw bad('A wake-up needs a reason.');
  if (reason.length > WAKEUP_REASON_MAX_CHARS) {
    throw bad(`The reason is over ${WAKEUP_REASON_MAX_CHARS} characters. Put long notes in a file, and name the file in the reason.`);
  }
  const hasDelay = input.delaySeconds !== undefined && input.delaySeconds !== null;
  const hasAt = input.at !== undefined && input.at !== null && input.at !== '';
  if (hasDelay === hasAt) throw bad('Give exactly one of delaySeconds and at.');
  let wakeAt: Date;
  if (hasDelay) {
    if (typeof input.delaySeconds !== 'number' || !Number.isInteger(input.delaySeconds)) throw bad('delaySeconds must be a whole number.');
    if (input.delaySeconds < 1) throw bad('delaySeconds must be 1 or more. Talyn cannot wake a session in the past.', 'wakeup_in_past');
    wakeAt = new Date(now.getTime() + input.delaySeconds * 1000);
  } else {
    wakeAt = new Date(typeof input.at === 'string' ? input.at : NaN);
    if (Number.isNaN(wakeAt.getTime())) throw bad('at must be an ISO time, for example 2026-11-08T15:30:00Z.');
    if (wakeAt.getTime() <= now.getTime()) throw bad('That time is in the past. Give a time in the future.', 'wakeup_in_past');
  }
  if (!Number.isFinite(wakeAt.getTime())) throw bad('That time is too far away.');
  const chat = await resolveChat(row, input.chatId);
  const wakeup = await insertWakeup({
    id: randomUUID(),
    workbenchId: row.id,
    chatId: chat.id,
    workspaceId: row.workspaceId,
    wakeAt,
    reason,
    createdBy,
    ...payerFor(chat, createdBy),
    createdAt: now,
  });
  if (!wakeup) throw new Error('The wake-up was not stored.');
  await emitBackground(row.workspaceId, row.id);
  return publicWakeup(wakeup);
}

export async function cancelWakeup(row: WorkbenchRow, wakeupId: string): Promise<WorkbenchWakeup> {
  const wakeup = await getWakeup(wakeupId);
  if (!wakeup || wakeup.workbenchId !== row.id) throw new WorkbenchError('Wake-up not found', 404, 'not_found');
  if (wakeup.status !== 'scheduled') return publicWakeup(wakeup);
  const cancelled = await settleWakeup(wakeup.id, 'scheduled', 'cancelled', 'Cancelled.');
  await emitBackground(row.workspaceId, row.id);
  return publicWakeup(cancelled ?? (await getWakeup(wakeup.id)) ?? wakeup);
}

/** The text of a scheduled wake-up's turn. A job's exit has its own (`prompt`). */
export function wakeupPrompt(wakeup: Pick<WakeupRow, 'reason' | 'createdBy' | 'createdAt'>): string {
  const who = wakeup.createdBy === 'user' ? 'the person' : 'you';
  return [
    `[Talyn] Wake-up ${who} scheduled at ${wakeup.createdAt.toISOString()}: ${wakeup.reason}`,
    'See running background jobs with `talyn_list_background`. Continue the work, or report to the person.',
  ].join('\n');
}

export function wakeupTrigger(wakeup: WakeupRow, job: JobRow | null): WorkbenchMessageTrigger {
  if (wakeup.sourceJobId && job) {
    return {
      kind: 'job_exit', wakeupId: wakeup.id, reason: wakeup.reason,
      jobId: job.id, jobName: job.name, exitCode: job.exitCode,
    };
  }
  return { kind: 'wakeup', wakeupId: wakeup.id, reason: wakeup.reason, createdBy: wakeup.createdBy as WorkbenchWakeupCreatedBy };
}

/**
 * Fire one wake-up: claim it, then send its turn through the normal send path
 * with the stored payer. An archived session or a closed chat cancels it; a
 * box-gate refusal or a send that fails marks it failed with the reason, and
 * nothing answers 402. True when a turn was sent or queued.
 *
 * The order is claim, then send. A crash between the two loses the wake-up
 * (it shows as fired with no turn); the other order could send it twice.
 */
export async function fireWakeup(id: string, now = new Date()): Promise<boolean> {
  const claimed = await claimWakeup(id, now);
  if (!claimed) return false;
  let sent = false;
  try {
    const row = await getWorkbench(claimed.workbenchId);
    const chat = await getChat(claimed.chatId);
    if (!row || row.archivedAt || row.status === 'archived') {
      await settleWakeup(claimed.id, 'fired', 'cancelled', 'The session is archived.');
    } else if (!chat || chat.closedAt) {
      await settleWakeup(claimed.id, 'fired', 'cancelled', 'The chat is closed.');
    } else if (row.runtime !== 'sandbox') {
      await settleWakeup(claimed.id, 'fired', 'failed', localRuntimeError().message);
    } else {
      const payer = claimed.payerUserId && claimed.payerWorkspaceId
        ? await turnPayerFor(claimed.payerUserId, claimed.payerWorkspaceId)
        : null;
      const refusal = await existingBoxRefusal(row, true, payerRef(payer));
      if (refusal) {
        await settleWakeup(claimed.id, 'fired', 'failed', refusal.message);
      } else {
        const job = claimed.sourceJobId ? await getJob(claimed.sourceJobId) : null;
        // Loaded here: turns.ts reaches move.ts, which imports this file.
        const { sendMessage } = await import('./turns.js');
        await sendMessage(chat.id, { text: claimed.prompt ?? wakeupPrompt(claimed) }, {
          origin: 'talyn',
          trigger: wakeupTrigger(claimed, job),
          ...(payer ? { payer } : {}),
        });
        sent = true;
      }
    }
  } catch (err) {
    console.warn(`[background] wake-up ${claimed.id} failed:`, err);
    await settleWakeup(claimed.id, 'fired', 'failed', userFacingError(err)).catch(() => null);
  }
  await emitBackground(claimed.workspaceId, claimed.workbenchId);
  return sent;
}
