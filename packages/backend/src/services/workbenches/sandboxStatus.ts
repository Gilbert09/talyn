import { and, desc, eq, gt, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  isSandboxSize,
  SANDBOX_SIZES,
  SANDBOX_WORK_WARN_AFTER_MS,
  type SandboxActivity,
  type SandboxSize,
  type SandboxStatusAction,
  type SandboxStatusProblem,
  type SandboxStatusState,
  type SandboxWorkSafety,
  type WorkbenchCapacityWait,
  type WorkbenchSandboxStatus,
  type WorkbenchStoredDiffStat,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { workbenchChats as chats, workbenchEvents as events, workbenchScriptRuns as runs } from '../../db/schema.js';
import type { FleetSandbox } from '../selfHosted/client.js';
import { describeBoxStart, parseStartHistory, startHistoryQuery, type StartHistoryEntry } from './boxStart.js';
import { fleetClientFor, isResuming } from './sandboxRuntime.js';
import { checkpointTime } from './workCheckpointScripts.js';
import type { WorkbenchRow } from './store.js';

/**
 * The Sandbox panel's answer (`GET /workbenches/:id/sandbox-status`): what
 * the box is, what runs on it, and whether its work is safe. Read-only. It
 * reads the session row, three small projections (chats, script runs, the
 * newest problem note), and the fleet's record of the box, cached for
 * {@link FLEET_READ_TTL_MS}. A fleet that does not answer makes the fleet
 * part `unknown`; it never fails the request.
 */

/** One fleet read per box per this long, however many panels poll. */
export const FLEET_READ_TTL_MS = 10_000;
/** A fleet read slower than this answers `unknown`. The panel must not hang on the fleet. */
const FLEET_READ_TIMEOUT_MS = 5_000;
/** A start this old with no wait for capacity is stuck: Retry is offered. */
export const STUCK_START_MS = 15 * 60_000;
/** The problem notes looked for, newest first, among a chat's latest events. */
export const PROBLEM_NOTE_SUBTYPES = [
  'workbench_failed',
  'sandbox_recovered',
  'sandbox_disk_full',
  'sandbox_resize_failed',
  'turn_interrupted',
  'work_checkpoint_failed',
  'work_checkpoint_too_large',
] as const;
/** How far back, in events per chat, the problem note is looked for. Keeps the read bounded. */
export const PROBLEM_NOTE_WINDOW = 2000;
const PROBLEM_TEXT_MAX_CHARS = 600;

// ============================================================================
// The fleet's record, cached
// ============================================================================

export type FleetRead =
  | { ok: true; sandbox: FleetSandbox; terminal: boolean; retired: boolean }
  | { ok: false; error: string };

const fleetCache = new Map<string, { at: number; read: Promise<FleetRead> }>();

/** Tests start with no cached reads. */
export function resetSandboxStatusCacheForTests(): void {
  fleetCache.clear();
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the fleet did not answer in ${ms / 1000} s`)), ms);
    timer.unref?.();
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** The fleet's record of the box. Never throws: a failure is `{ ok: false }`, cached like an answer. */
export function readFleetRecord(row: Pick<WorkbenchRow, 'workspaceId' | 'fleetHost'> & { sandboxId: string }, now = Date.now()): Promise<FleetRead> {
  const cached = fleetCache.get(row.sandboxId);
  if (cached && now - cached.at < FLEET_READ_TTL_MS) return cached.read;
  const read = (async (): Promise<FleetRead> => {
    try {
      const client = await fleetClientFor(row.workspaceId, row.fleetHost);
      const answer = await withTimeout(client.getSandbox(row.sandboxId), FLEET_READ_TIMEOUT_MS);
      return { ok: true, sandbox: answer.sandbox, terminal: Boolean(answer.terminal), retired: Boolean(answer.retired) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  })();
  fleetCache.set(row.sandboxId, { at: now, read });
  // Bounded: a long-lived process sees many boxes.
  if (fleetCache.size > 2000) {
    for (const [key, entry] of fleetCache) if (now - entry.at >= FLEET_READ_TTL_MS) fleetCache.delete(key);
  }
  return read;
}

// ============================================================================
// Projections
// ============================================================================

/**
 * The chat facts the panel needs. The queue is reduced in SQL to its length
 * and the head's capacity wait, because a queued message can carry inline
 * attachments.
 */
export const STATUS_CHAT_COLUMNS = {
  id: chats.id,
  title: chats.title,
  status: chats.status,
  turnStartedAt: chats.turnStartedAt,
  nextSeq: chats.nextSeq,
  closedAt: chats.closedAt,
  queued: sql<number>`coalesce(jsonb_array_length(${chats.queuedMessages}), 0)`.mapWith(Number),
  headWait: sql<WorkbenchCapacityWait | null>`${chats.queuedMessages} -> 0 -> 'capacityWait'`,
} as const;

export type StatusChat = {
  id: string;
  title: string;
  status: string;
  turnStartedAt: Date | null;
  nextSeq: number;
  closedAt: Date | null;
  queued: number;
  headWait: WorkbenchCapacityWait | null;
};

export function statusChatsQuery(workbenchId: string) {
  return getPoolDbClient().select(STATUS_CHAT_COLUMNS).from(chats).where(eq(chats.workbenchId, workbenchId));
}

/** Script runs without their output. */
export const STATUS_SCRIPT_COLUMNS = {
  name: runs.name,
  sandboxId: runs.sandboxId,
  running: runs.running,
  exitCode: runs.exitCode,
  startedAt: runs.startedAt,
} as const;

export type StatusScript = { name: string; sandboxId: string; running: boolean; exitCode: number | null; startedAt: Date | null };

export function statusScriptsQuery(workbenchId: string) {
  return getPoolDbClient().select(STATUS_SCRIPT_COLUMNS).from(runs).where(eq(runs.workbenchId, workbenchId));
}

export type ProblemNote = { subtype: string; text: string; at: Date };

/** The newest problem note among each open chat's last {@link PROBLEM_NOTE_WINDOW} events. Ships two short strings, never the event. */
export function problemNoteQuery(openChats: Array<Pick<StatusChat, 'id' | 'nextSeq'>>) {
  const windows: SQL[] = openChats.map((c) =>
    and(eq(events.chatId, c.id), gt(events.seq, Math.max(0, c.nextSeq - PROBLEM_NOTE_WINDOW)))!,
  );
  return getPoolDbClient()
    .select({
      subtype: sql<string>`${events.event} ->> 'subtype'`,
      text: sql<string>`left(coalesce(${events.event} ->> 'text', ''), ${PROBLEM_TEXT_MAX_CHARS})`,
      at: events.createdAt,
    })
    .from(events)
    .where(and(
      or(...windows),
      sql`${events.event} ->> 'type' = 'system'`,
      inArray(sql`${events.event} ->> 'subtype'`, [...PROBLEM_NOTE_SUBTYPES]),
    ))
    .orderBy(desc(events.createdAt))
    .limit(1);
}

// ============================================================================
// The answer
// ============================================================================

export interface SandboxStatusInput {
  row: WorkbenchRow;
  /** Null when the fleet was not asked (no box, or nothing to ask about). */
  fleet: FleetRead | null;
  chats: StatusChat[];
  scripts: StatusScript[];
  note: ProblemNote | null;
  /** Talyn is resuming the box now. */
  resuming: boolean;
  now: Date;
  /** The repository's recent box starts. Absent: not read. */
  history?: StartHistoryEntry[] | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const parsed = (s: string | null | undefined): Date | null => {
  if (!s) return null;
  const t = Date.parse(s);
  // The fleet's Go zero time means "never".
  return Number.isFinite(t) && t > 0 ? new Date(t) : null;
};

/** `12 minutes`, `1 hour 5 minutes`. */
export function durationWords(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = `${hours} hour${hours === 1 ? '' : 's'}`;
  return rest ? `${h} ${rest} minute${rest === 1 ? '' : 's'}` : h;
}

function sizeOf(row: WorkbenchRow, sandbox: FleetSandbox | null): WorkbenchSandboxStatus['size'] {
  const fromFleet = sandbox?.memMib
    ? (Object.keys(SANDBOX_SIZES) as SandboxSize[]).find((k) => SANDBOX_SIZES[k].memMib === sandbox.memMib) ?? null
    : null;
  // Without the fleet's answer, only a size the session chose is known; the repository's needs a GitHub read.
  const chosen = isSandboxSize(row.settings?.sandboxSize) ? row.settings.sandboxSize : null;
  const key = fromFleet ?? (sandbox?.memMib ? null : chosen);
  const memMib = sandbox?.memMib ?? (key ? SANDBOX_SIZES[key].memMib : null);
  if (!key && !memMib) return null;
  const milli = sandbox?.milliVcpu ?? (sandbox?.vcpuCount ? sandbox.vcpuCount * 1000 : key ? SANDBOX_SIZES[key].milliVcpu : null);
  const vcpus = milli === null ? null : milli / 1000;
  const label = key
    ? `${SANDBOX_SIZES[key].label}${vcpus ? `, ${vcpus} vCPU` : ''}`
    : `${Math.round((memMib ?? 0) / 1024)} GB${vcpus ? `, ${vcpus} vCPU` : ''}`;
  return { key, label, memMib, vcpus };
}

function activityOf(input: SandboxStatusInput): SandboxActivity[] {
  const { row, now } = input;
  const out: SandboxActivity[] = [];
  const open = input.chats.filter((c) => !c.closedAt);
  const many = open.length > 1;
  for (const chat of open) {
    const where = many ? ` in "${chat.title}"` : '';
    if (chat.status === 'running') {
      const since = chat.turnStartedAt;
      const time = since ? ` for ${durationWords(now.getTime() - since.getTime())}` : '';
      out.push({ kind: 'turn', text: `The agent is working${where}${time}.`, since: iso(since), chatId: chat.id });
    }
    const wait = chat.headWait;
    if (wait && typeof wait === 'object' && wait.startedAt) {
      const waking = wait.reason === 'waking';
      const tries = wait.attempts > 0 ? ` Try ${wait.attempts + 1}${wait.retryAt ? ` at ${checkpointTime(new Date(wait.retryAt))}` : ''}.` : '';
      out.push({
        kind: waking ? 'waking' : 'capacity_wait',
        text: `${waking ? 'Waking the sandbox' : 'Waiting for a free sandbox'} for a message${where}.${tries}`,
        since: wait.startedAt,
        chatId: chat.id,
      });
    }
    const waiting = chat.queued - (wait ? 1 : 0);
    if (waiting > 0) {
      out.push({ kind: 'queued', text: `${waiting} message${waiting === 1 ? '' : 's'} queued${where}.`, since: null, chatId: chat.id });
    }
  }
  for (const script of input.scripts) {
    if (!script.running || (row.sandboxId && script.sandboxId !== row.sandboxId)) continue;
    const time = script.startedAt ? ` for ${durationWords(now.getTime() - script.startedAt.getTime())}` : '';
    out.push(script.name === 'setup'
      ? { kind: 'setup', text: `The setup script is running${time}.`, since: iso(script.startedAt), name: script.name }
      : { kind: 'script', text: `The script "${script.name}" is running${time}.`, since: iso(script.startedAt), name: script.name });
  }
  return out;
}

function workOf(input: SandboxStatusInput, activity: SandboxActivity[]): SandboxWorkSafety | null {
  const { row, now } = input;
  if (row.runtime !== 'sandbox' || row.kind === 'thread') return null;
  const stat = row.diffStat as WorkbenchStoredDiffStat | null;
  const uncommitted = stat ? stat.uncommittedStats ?? { added: stat.added, removed: stat.removed, files: stat.files } : null;
  const committed = stat?.committedStats ?? null;
  const failures = row.workSaveFailures ?? 0;
  const savedAt = row.workCheckpointAt;
  const confirmed = [savedAt, row.workCheckedAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const unpushed = row.workUnpushedCommits;
  const hasWork = (uncommitted?.files ?? 0) > 0 || (unpushed ?? 0) > 0;
  let warning: string | null = null;
  let level: SandboxWorkSafety['warningLevel'] = null;
  const after = savedAt ? `changes made after ${checkpointTime(savedAt)}` : 'changes that are not pushed';
  if (failures >= 3) {
    level = 'danger';
    warning = `Talyn could not save the work ${failures} times in a row. If the sandbox is lost, ${after} are lost. Push the branch to keep them.`;
  } else if (failures > 0) {
    level = 'warn';
    warning = `The last save failed${row.workSaveError ? `: ${row.workSaveError.replace(/\.?\s*$/, '')}` : ''}. Talyn tries again after the next change.`;
  } else {
    // Work can be unsaved only since the later of the last save and the start of the running turn.
    const turn = activity.find((a) => a.kind === 'turn');
    const turnSince = turn?.since ? Date.parse(turn.since) : null;
    const unsavedMs = turnSince === null ? 0 : now.getTime() - Math.max(confirmed?.getTime() ?? 0, turnSince);
    if (unsavedMs > SANDBOX_WORK_WARN_AFTER_MS) {
      level = 'warn';
      warning = `The agent is working and Talyn has not saved the work for ${durationWords(unsavedMs)}.`;
    } else if (!savedAt && !row.workCheckedAt && hasWork && now.getTime() - row.createdAt.getTime() > SANDBOX_WORK_WARN_AFTER_MS) {
      level = 'warn';
      warning = 'Talyn has no saved copy of this work. If the sandbox is lost, changes that are not pushed are lost.';
    }
  }
  return {
    savedAt: iso(savedAt),
    savedBytes: row.workCheckpointBytes ?? null,
    checkedAt: iso(row.workCheckedAt),
    unpushedCommits: unpushed ?? null,
    uncommitted,
    committed,
    branchPushed: unpushed === null || unpushed === undefined ? null : unpushed === 0,
    failures,
    lastFailureAt: failures > 0 ? iso(row.workSaveFailedAt) : null,
    lastFailure: failures > 0 ? row.workSaveError ?? null : null,
    warning,
    warningLevel: level,
  };
}

function problemOf(input: SandboxStatusInput, fleetError: string | null): SandboxStatusProblem | null {
  const { row } = input;
  const candidates: Array<{ text: string; at: Date | null }> = [];
  if (row.status === 'error' || row.status === 'archiveError') {
    candidates.push({ text: row.statusMessage || 'The session failed.', at: row.updatedAt });
  }
  if ((row.workSaveFailures ?? 0) > 0 && row.workSaveError) {
    candidates.push({ text: `A save of the work failed: ${row.workSaveError}`, at: row.workSaveFailedAt });
  }
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const moveFailedAt = parsed(typeof settings.moveFailedAt === 'string' ? settings.moveFailedAt : null);
  if (moveFailedAt) candidates.push({ text: 'The last move to a new sandbox failed. The session stayed on its sandbox.', at: moveFailedAt });
  if (fleetError) candidates.push({ text: `The fleet reports: ${fleetError}`, at: null });
  if (input.note?.text) candidates.push({ text: input.note.text, at: input.note.at });
  if (candidates.length === 0) return null;
  // The session's own error first; then the newest with a time.
  const [first] = candidates;
  if (row.status === 'error' || row.status === 'archiveError') return { text: first.text, at: iso(first.at) };
  const best = candidates.reduce((a, b) => ((b.at?.getTime() ?? 0) > (a.at?.getTime() ?? 0) ? b : a));
  return { text: best.text, at: iso(best.at) };
}

interface StateAnswer {
  state: SandboxStatusState;
  headline: string;
  sleepsAt: Date | null;
  since: Date | null;
  replacementStarting: boolean;
}

function stateOf(input: SandboxStatusInput, activity: SandboxActivity[]): StateAnswer {
  const { row, now } = input;
  const base = { sleepsAt: null, since: null, replacementStarting: false };
  if (row.runtime !== 'sandbox') return { ...base, state: 'local', headline: 'This session runs on your computer.' };
  if (row.archivedAt || row.status === 'archived') return { ...base, state: 'archived', headline: 'Archived. The session has no sandbox.' };
  if (row.status === 'archiveError') return { ...base, state: 'failed', headline: 'The archive failed.' };
  if (row.sandboxState === 'lost') {
    const starting = row.status === 'provisioning';
    return {
      ...base,
      state: 'lost',
      replacementStarting: starting,
      headline: starting ? 'The sandbox was lost. Talyn is starting a new one.' : 'The sandbox was lost. Retry to start a new one.',
    };
  }
  if (row.status === 'moving') return { ...base, state: 'moving', headline: 'Moving to a new sandbox.' };
  if (row.status === 'error') return { ...base, state: 'failed', headline: 'The session could not start.' };
  if (row.status === 'provisioning') {
    const waiting = activity.find((a) => a.kind === 'capacity_wait');
    return { ...base, state: 'starting', headline: waiting ? 'Waiting for a free sandbox.' : 'Starting.' };
  }

  // Ready: the fleet's record decides between awake, asleep and gone.
  const sandbox = input.fleet?.ok ? input.fleet.sandbox : null;
  const busy = activity.some((a) => a.kind === 'turn' || a.kind === 'setup' || a.kind === 'script');
  if (input.resuming || activity.some((a) => a.kind === 'waking')) {
    return { ...base, state: 'waking', headline: 'Waking the sandbox.', since: parsed(sandbox?.suspendedAt) };
  }
  if (input.fleet?.ok && (input.fleet.terminal || input.fleet.retired || ['failed', 'stopped', 'cancelled'].includes(sandbox?.status ?? ''))) {
    return { ...base, state: 'lost', headline: 'The fleet no longer runs this sandbox. Talyn starts a new one at the next message.' };
  }
  if (sandbox) {
    switch (sandbox.status) {
      case 'suspended': {
        const since = parsed(sandbox.suspendedAt);
        const inStorage = Boolean(sandbox.suspendUploaded) && !sandbox.suspendDir;
        return inStorage
          ? { ...base, state: 'hibernated', since, headline: 'Asleep in storage. Waking it takes a few minutes.' }
          : { ...base, state: 'asleep', since, headline: 'Asleep. It wakes in a few seconds at the next message.' };
      }
      case 'queued':
      case 'starting':
        return { ...base, state: 'waking', headline: 'Waking the sandbox.' };
      case 'busy':
        return { ...base, state: 'running', since: parsed(sandbox.startedAt), headline: 'Running.' };
      case 'idle': {
        const since = parsed(sandbox.startedAt);
        if (busy) return { ...base, state: 'running', since, headline: 'Running.' };
        const last = parsed(sandbox.lastRequestAt);
        const sleepsAt = last && sandbox.idleTtlSec ? new Date(last.getTime() + sandbox.idleTtlSec * 1000) : null;
        const headline = sleepsAt
          ? sleepsAt.getTime() > now.getTime()
            ? `Idle. It goes to sleep in ${durationWords(sleepsAt.getTime() - now.getTime())}.`
            : 'Idle. It goes to sleep soon.'
          : 'Idle.';
        return { ...base, state: 'idle', since, sleepsAt, headline };
      }
    }
  }
  // The fleet did not answer: read what the row says.
  if (row.sandboxState === 'suspended') return { ...base, state: 'asleep', headline: 'Asleep.' };
  if (busy) return { ...base, state: 'running', headline: 'Running.' };
  return { ...base, state: 'unknown', headline: 'Talyn could not read the sandbox from the fleet.' };
}

function actionsOf(input: SandboxStatusInput, state: SandboxStatusState, activity: SandboxActivity[]): SandboxStatusAction[] {
  const { row, now } = input;
  const out: SandboxStatusAction[] = [];
  if (row.runtime !== 'sandbox' || row.archivedAt) return out;
  if (row.status === 'ready' && (state === 'asleep' || state === 'hibernated')) {
    out.push({ kind: 'wake', label: 'Wake', confirm: null });
  }
  const stuck = row.status === 'provisioning'
    && !activity.some((a) => a.kind === 'capacity_wait' || a.kind === 'setup')
    && now.getTime() - row.updatedAt.getTime() > STUCK_START_MS;
  if (row.status === 'error' || stuck) {
    // Retry deletes the box and starts from GitHub, except when it repeats the recovery of a lost box.
    const keepsCheckpoint = row.status === 'provisioning' && row.sandboxState === 'lost';
    out.push({
      kind: 'retry',
      label: 'Retry',
      confirm: keepsCheckpoint
        ? null
        : 'Retry deletes this sandbox and starts a new one from the branch on GitHub. Changes that are not pushed are lost.',
    });
  }
  if (row.status === 'ready' && row.kind !== 'thread' && state !== 'lost') {
    out.push({ kind: 'resize', label: 'Move to a new size', confirm: null });
  }
  const setup = input.scripts.find((s) => s.name === 'setup' && (!row.sandboxId || s.sandboxId === row.sandboxId));
  if (setup && (setup.running || (setup.exitCode !== null && setup.exitCode !== 0))) {
    out.push({ kind: 'show_setup_output', label: 'Show setup output', confirm: null });
  }
  return out;
}

/** The answer, from facts already read. Pure, so every mapping is testable. */
export function describeSandboxStatus(input: SandboxStatusInput): WorkbenchSandboxStatus {
  const { row, now } = input;
  const activity = row.runtime === 'sandbox' && !row.archivedAt ? activityOf(input) : [];
  const answer = stateOf(input, activity);
  const sandbox = input.fleet?.ok ? input.fleet.sandbox : null;
  const fleetError = sandbox?.error && ['failed', 'stopped', 'cancelled'].includes(sandbox.status) ? sandbox.error : null;
  const detail = row.statusMessage && row.status !== 'error' ? row.statusMessage : null;
  return {
    workbenchId: row.id,
    checkedAt: now.toISOString(),
    state: answer.state,
    headline: answer.headline,
    detail,
    sleepsAt: iso(answer.sleepsAt),
    since: iso(answer.since),
    replacementStarting: answer.replacementStarting,
    fleet: input.fleet === null
      ? { known: false, status: null, phase: null, error: null }
      : input.fleet.ok
        ? { known: true, status: input.fleet.sandbox.status ?? null, phase: input.fleet.sandbox.phase ?? null, error: input.fleet.sandbox.error ?? null }
        : { known: false, status: null, phase: null, error: input.fleet.error },
    host: row.fleetHost,
    size: row.runtime === 'sandbox' && row.kind !== 'thread' ? sizeOf(row, sandbox) : null,
    activity,
    work: workOf(input, activity),
    problem: problemOf(input, fleetError),
    actions: actionsOf(input, answer.state, activity),
    start: describeBoxStart({ row, sandbox, history: input.history ?? null }),
  };
}

/** Whether the fleet is worth asking: a box exists and the row cannot answer alone. */
function asksFleet(row: WorkbenchRow): row is WorkbenchRow & { sandboxId: string } {
  return row.runtime === 'sandbox' && !row.archivedAt && row.status === 'ready' && !!row.sandboxId && row.sandboxState !== 'lost';
}

export async function getSandboxStatus(row: WorkbenchRow, now = new Date()): Promise<WorkbenchSandboxStatus> {
  const [chatRows, scripts, fleet, history] = await Promise.all([
    statusChatsQuery(row.id) as Promise<StatusChat[]>,
    row.runtime === 'sandbox' ? (statusScriptsQuery(row.id) as Promise<StatusScript[]>) : Promise.resolve([]),
    asksFleet(row) ? readFleetRecord(row, now.getTime()) : Promise.resolve(null),
    readStartHistory(row),
  ]);
  const open = chatRows.filter((c) => !c.closedAt);
  const notes = open.length ? await problemNoteQuery(open) : [];
  const note = notes[0] ? { subtype: notes[0].subtype, text: notes[0].text, at: notes[0].at } : null;
  return describeSandboxStatus({
    row,
    fleet,
    chats: chatRows,
    scripts,
    note,
    resuming: row.sandboxId ? isResuming(row.sandboxId) : false,
    now,
    history,
  });
}

/** The repository's recent starts, for a sandbox session. Null when there is nothing to compare, or the read fails. */
async function readStartHistory(row: WorkbenchRow): Promise<StartHistoryEntry[] | null> {
  if (row.runtime !== 'sandbox' || row.kind === 'thread' || row.archivedAt || !row.repositoryId) return null;
  try {
    const [found] = await startHistoryQuery(row.repositoryId);
    return parseStartHistory(found?.recent);
  } catch (err) {
    console.warn(`[workbench] reading the start history of ${row.repositoryId} failed:`, err);
    return null;
  }
}
