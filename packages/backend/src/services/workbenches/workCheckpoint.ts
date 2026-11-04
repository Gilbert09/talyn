import type { AgentEventDraft } from '@talyn/shared';
import { FleetRunNotFoundError } from '../selfHosted/client.js';
import { refreshDiffStat } from './changes.js';
import { captureChanges } from './changesCapture.js';
import { emitWorkbenchEvents } from './emit.js';
import { userFacingError } from './errors.js';
import { moveReadChunkScript } from './move.js';
import { writeSandboxFiles } from './sandboxFiles.js';
import { recordWorkbenchEvent, runCapture } from './sandboxRuntime.js';
import {
  appendEvents,
  clearWorkCheckpoint,
  getWorkbench,
  listChats,
  recordWorkCheckpoint,
  recordWorkSaveFailure,
  recordWorkSaveSuccess,
  type WorkbenchRow,
} from './store.js';
import {
  CHECKPOINT_KEEPS_FAILING_AFTER,
  CHECKPOINT_RECOVERED_NOTE,
  checkpointFailedNote,
  checkpointKeepsFailingNote,
  parseWorkRestore,
  parseWorkSave,
  tooLargeNote,
  workCleanupScript,
  workRestoreBundle,
  workRestoreScript,
  workSaveScript,
  workStagedBundle,
  type WorkKind,
  type WorkRestore,
  type WorkSaveResult,
} from './workCheckpointScripts.js';
import { WorkStorageUnavailableError, workObjectStore } from './workStorage.js';

/**
 * A session's saved work, kept in Talyn's storage and never pushed to GitHub.
 *
 * Two kinds per session: a `checkpoint`, taken while the session runs so a
 * lost sandbox does not take the work along, and an `archive`, taken when the
 * session is archived. Each is a git bundle (see `workCheckpointScripts.ts`).
 *
 * Checkpoint triggers: the end of every turn, and during a turn at most every
 * {@link CHECKPOINT_DURING_TURN_MS} once the agent used a tool that can change
 * files. Outside a turn, typing in the session's terminal and the end of a
 * script are triggers too, with the same throttle, so work done by a person
 * is saved as well. The same signals refresh the sidebar's diff stat, at most
 * every {@link DIFF_STAT_DURING_TURN_MS}. A checkpoint never fails or delays
 * a turn; a failed one is tried again at the next trigger.
 *
 * Each result goes on the row (`recordWorkSaveSuccess`/`recordWorkSaveFailure`),
 * which the Sandbox panel reads. The first failure in a run, and the
 * {@link CHECKPOINT_KEEPS_FAILING_AFTER}th, put a note in the chat, and so
 * does the save that ends the run. Before 2026-11-03 a failure went only to
 * the log, so a session could not tell that its work was not saved.
 *
 * # Storage layout
 *
 *   <workspaceId>/<workbenchId>/<kind>/meta.json
 *   <workspaceId>/<workbenchId>/<kind>/<generation>/part-00000 ...
 *
 * Storage has no append, so the bundle is read out of the box and uploaded
 * one 2 MiB part at a time: the backend never holds more than one part. The
 * parts go under a NEW generation, then `meta.json` is replaced to point at
 * it, then the old generation is deleted. A reader therefore always finds a
 * whole bundle, and a save that fails half-way leaves the last one in place.
 */

export const CHECKPOINT_DURING_TURN_MS = 60_000;
export const CHECKPOINT_SLOW_FRACTION = 0.2;
export const CHECKPOINT_MAX_GAP_MS = 5 * 60_000;
// A fast repo saves every minute; a slow repo spends no more than about a fifth of its time saving.
export function nextCheckpointGapMs(lastDurationMs: number): number {
  return lastDurationMs > CHECKPOINT_DURING_TURN_MS * CHECKPOINT_SLOW_FRACTION
    ? Math.min(5 * lastDurationMs, CHECKPOINT_MAX_GAP_MS)
    : CHECKPOINT_DURING_TURN_MS;
}
export const DIFF_STAT_DURING_TURN_MS = 20_000;
/** One part: a quiet exec answer is cut at 4 MiB, and capture mode sends base64. Same as a move's chunk. */
export const WORK_PART_BYTES = 2 * 1024 * 1024;
/** Staging the bundle. Past this it is stopped, and the next trigger tries again. */
const SAVE_TIMEOUT_MS = 3 * 60_000;
const PART_TIMEOUT_MS = 2 * 60_000;
/** The restore fetches missing commits and writes the files. */
const RESTORE_TIMEOUT_MS = 5 * 60_000;

/** Tools that cannot change the work tree. Anything else, Bash included, may have. */
const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'WebSearch', 'WebFetch', 'NotebookRead', 'BashOutput', 'ExitPlanMode',
]);

/** The cheap check: did this batch of agent events call a tool that may have changed files? */
export function draftsMayChangeFiles(drafts: ReadonlyArray<AgentEventDraft | Record<string, unknown>>): boolean {
  for (const draft of drafts) {
    const d = draft as { type?: unknown; message?: { content?: unknown } };
    if (d.type !== 'assistant' || !Array.isArray(d.message?.content)) continue;
    for (const block of d.message.content as Array<{ type?: unknown; name?: unknown }>) {
      if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
      if (READ_ONLY_TOOLS.has(block.name) || block.name.startsWith('mcp__')) continue;
      return true;
    }
  }
  return false;
}

// ============================================================================
// Storage keys
// ============================================================================

export interface WorkMeta {
  version: 1;
  kind: WorkKind;
  sha: string;
  base: string | null;
  branch: string;
  takenAt: string;
  size: number;
  sha256: string;
  parts: number;
  generation: string;
}

export function workPrefix(row: Pick<WorkbenchRow, 'workspaceId' | 'id'>, kind: WorkKind): string {
  return `${row.workspaceId}/${row.id}/${kind}`;
}

const metaKey = (prefix: string) => `${prefix}/meta.json`;
const partKey = (prefix: string, generation: string, i: number) => `${prefix}/${generation}/part-${String(i).padStart(5, '0')}`;

export async function readWorkMeta(row: Pick<WorkbenchRow, 'workspaceId' | 'id'>, kind: WorkKind): Promise<WorkMeta | null> {
  const raw = await workObjectStore().get(metaKey(workPrefix(row, kind)));
  if (!raw) return null;
  const meta = JSON.parse(raw.toString('utf8')) as WorkMeta;
  if (meta.version !== 1 || !/^[0-9a-f]{40,64}$/.test(meta.sha) || !Number.isInteger(meta.parts)) {
    throw new Error('the saved work metadata is not readable');
  }
  return meta;
}

/**
 * Make the stored checkpoint the archive, in storage only: the parts are copied
 * under the archive prefix and `meta.json` is written last, as a save does. No
 * checkpoint means the box held no unsaved work, so any older archive goes.
 * Returns whether a copy was promoted. Never touches the box.
 */
export async function promoteCheckpointToArchive(row: Pick<WorkbenchRow, 'workspaceId' | 'id'>): Promise<boolean> {
  const meta = await readWorkMeta(row, 'checkpoint');
  if (!meta) {
    await deleteSavedWork(row, ['archive']);
    return false;
  }
  const store = workObjectStore();
  const from = workPrefix(row, 'checkpoint');
  const to = workPrefix(row, 'archive');
  const previous = await readWorkMeta(row, 'archive').catch(() => null);
  for (let i = 0; i < meta.parts; i++) {
    const body = await store.get(partKey(from, meta.generation, i));
    if (!body) throw new Error(`part ${i + 1} of ${meta.parts} of the saved work is missing`);
    await store.put(partKey(to, meta.generation, i), body);
  }
  await store.put(metaKey(to), Buffer.from(JSON.stringify({ ...meta, kind: 'archive' satisfies WorkKind })));
  if (previous && previous.generation !== meta.generation) {
    const old = Array.from({ length: previous.parts }, (_, i) => partKey(to, previous.generation, i));
    await store.remove(old).catch(() => undefined);
  }
  return true;
}

/** Delete every object of these kinds. Folders are found by listing, so a half-written generation goes too. */
export async function deleteSavedWork(row: Pick<WorkbenchRow, 'workspaceId' | 'id'>, kinds: WorkKind[] = ['checkpoint', 'archive']): Promise<void> {
  const store = workObjectStore();
  for (const kind of kinds) {
    const prefix = workPrefix(row, kind);
    const top = await store.list(prefix);
    const keys = [...top.files];
    for (const folder of top.folders) keys.push(...(await store.list(folder)).files);
    // Meta last: until it goes, a reader still finds the parts it names.
    const meta = metaKey(prefix);
    await store.remove(keys.filter((k) => k !== meta));
    await store.remove([meta]);
  }
}

// ============================================================================
// Save
// ============================================================================

export type SaveOutcome =
  | { kind: 'saved'; sha: string; at: Date; size: number; unpushed?: number | null }
  | Exclude<WorkSaveResult, { kind: 'bundle' | 'failed' }>
  /** `error` is the exception, when one was thrown, so a caller can word it as it words fleet faults. */
  | { kind: 'failed'; detail: string; error?: unknown };

/** Read the staged bundle out of the box, a part at a time, into storage; then point `meta.json` at it. */
async function uploadBundle(row: WorkbenchRow, kind: WorkKind, b: Extract<WorkSaveResult, { kind: 'bundle' }>): Promise<void> {
  const store = workObjectStore();
  const prefix = workPrefix(row, kind);
  const generation = `${b.at.getTime().toString(36)}-${b.sha.slice(0, 12)}`;
  const parts = Math.max(1, Math.ceil(b.size / WORK_PART_BYTES));
  const source = workStagedBundle(row.id);
  for (let i = 0; i < parts; i++) {
    const offset = i * WORK_PART_BYTES;
    const length = Math.min(WORK_PART_BYTES, b.size - offset);
    const r = await runCapture(row, moveReadChunkScript(source, offset, length), {
      cwd: '/', quiet: true, timeoutMs: PART_TIMEOUT_MS, env: { TMPDIR: '/dev/shm' }, diskRecovery: false,
    });
    if (r.exitCode !== 0) throw new Error(`could not read the saved work: ${r.stderr.trim().slice(-200)}`);
    if (r.truncated || r.stdoutBytes.length !== length) {
      throw new Error(`reading the saved work returned ${r.stdoutBytes.length} of ${length} bytes`);
    }
    await store.put(partKey(prefix, generation, i), r.stdoutBytes);
  }
  const previous = await readWorkMeta(row, kind).catch(() => null);
  const meta: WorkMeta = {
    version: 1, kind, sha: b.sha, base: b.base, branch: row.branch, takenAt: b.at.toISOString(),
    size: b.size, sha256: b.sha256, parts, generation,
  };
  await store.put(metaKey(prefix), Buffer.from(JSON.stringify(meta)));
  if (previous && previous.generation !== generation) {
    const old = Array.from({ length: previous.parts }, (_, i) => partKey(prefix, previous.generation, i));
    await store.remove(old).catch((err) => console.warn(`[workbench] removing old saved work of ${row.id} failed:`, err));
  }
}

/**
 * Save the session's work as `kind`. Throws only for a lost box; any other
 * failure is a `failed` outcome. `clean` removes what was stored for `kind`,
 * because a stored bundle of work that has since been pushed or discarded
 * would bring it back.
 */
export async function saveWork(
  row: WorkbenchRow,
  kind: WorkKind,
  opts: { previousSha?: string | null; marker?: string } = {},
): Promise<SaveOutcome> {
  let staged = false;
  try {
    const r = await runCapture(row, workSaveScript(row, { kind, previousSha: opts.previousSha ?? null }), {
      quiet: true,
      timeoutMs: SAVE_TIMEOUT_MS,
      env: { TMPDIR: '/dev/shm', GIT_OPTIONAL_LOCKS: '0' },
      diskRecovery: false,
      ...(opts.marker ? { marker: opts.marker } : {}),
    });
    const result = parseWorkSave(r);
    if (result.kind === 'clean') {
      // With no storage configured nothing was ever stored, so there is nothing to remove.
      await deleteSavedWork(row, [kind]).catch((err) => {
        if (!(err instanceof WorkStorageUnavailableError)) throw err;
      });
      return result;
    }
    if (result.kind !== 'bundle') return result;
    staged = true;
    await uploadBundle(row, kind, result);
    return { kind: 'saved', sha: result.sha, at: result.at, size: result.size, unpushed: result.unpushed };
  } catch (err) {
    if (err instanceof FleetRunNotFoundError) throw err;
    return { kind: 'failed', detail: userFacingError(err), error: err };
  } finally {
    if (staged) {
      await runCapture(row, workCleanupScript(row.id), { cwd: '/', quiet: true, timeoutMs: 30_000, diskRecovery: false })
        .catch(() => undefined);
    }
  }
}

// ============================================================================
// Throttle
// ============================================================================

export interface Throttle {
  /** Run now when the interval since the last run (or `floor`) has passed; otherwise once, when it does. */
  poke(key: string, floor?: number): void;
  /** Count a run that happened elsewhere, so the next poke waits a full interval. */
  mark(key: string): void;
  recordDuration(key: string, durationMs: number): void;
  cancel(key: string): void;
}

export interface ThrottleClock {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

const realClock: ThrottleClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
};

/** Leading edge, plus one trailing run, so a change right after a run is still caught within one interval. */
export function createThrottle(
  intervalMs: number,
  run: (key: string) => Promise<unknown> | unknown,
  clock: ThrottleClock = realClock,
  gapForDuration?: (durationMs: number) => number,
): Throttle {
  const last = new Map<string, number>();
  const lastDuration = new Map<string, number>();
  const timers = new Map<string, { timer: unknown; floor: number }>();
  const running = new Set<string>();
  const pending = new Map<string, number>();
  const schedule = (key: string, floor: number) => {
    const interval = gapForDuration?.(lastDuration.get(key) ?? 0) ?? intervalMs;
    const wait = Math.max(last.get(key) ?? -Infinity, floor) + interval - clock.now();
    if (wait <= 0) {
      if (running.has(key)) {
        pending.set(key, Math.max(pending.get(key) ?? -Infinity, floor));
      } else {
        fire(key);
      }
      return;
    }
    const timer = clock.setTimer(() => {
      timers.delete(key);
      schedule(key, floor);
    }, wait);
    timers.set(key, { timer, floor });
  };
  const fire = (key: string) => {
    last.set(key, clock.now());
    running.add(key);
    const finish = () => {
      running.delete(key);
      const floor = pending.get(key);
      if (floor !== undefined) {
        pending.delete(key);
        schedule(key, floor);
      }
    };
    void Promise.resolve().then(() => {
      try {
        const result = run(key);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          void Promise.resolve(result).catch(() => undefined).finally(finish);
        } else {
          finish();
        }
      } catch {
        finish();
      }
    });
  };
  return {
    poke(key, floor = -Infinity) {
      if (timers.has(key)) return;
      schedule(key, floor);
    },
    mark(key) {
      last.set(key, clock.now());
    },
    recordDuration(key, durationMs) {
      lastDuration.set(key, durationMs);
      const waiting = timers.get(key);
      if (waiting) {
        clock.clearTimer(waiting.timer);
        timers.delete(key);
        schedule(key, waiting.floor);
      }
    },
    cancel(key) {
      const waiting = timers.get(key);
      if (waiting) clock.clearTimer(waiting.timer);
      timers.delete(key);
      pending.delete(key);
    },
  };
}

function liveSandbox(row: WorkbenchRow | null): row is WorkbenchRow & { sandboxId: string } {
  return Boolean(row && row.runtime === 'sandbox' && row.sandboxId && row.status === 'ready' && !row.archivedAt && !row.archivePendingAt);
}

async function refreshDiffStatOf(id: string): Promise<void> {
  const row = await getWorkbench(id);
  if (liveSandbox(row)) await refreshDiffStat(row);
}

async function checkpointOf(id: string): Promise<void> {
  const row = await getWorkbench(id);
  if (row) await checkpointWork(row, 'during_turn');
}

let checkpointClock = realClock;
let diffThrottle = createThrottle(DIFF_STAT_DURING_TURN_MS, refreshDiffStatOf);
let checkpointThrottle = createThrottle(CHECKPOINT_DURING_TURN_MS, checkpointOf, checkpointClock, nextCheckpointGapMs);

/** Tests drive the throttles with a fake clock. */
export function setWorkCheckpointClockForTests(clock: ThrottleClock | null): void {
  checkpointClock = clock ?? realClock;
  diffThrottle = createThrottle(DIFF_STAT_DURING_TURN_MS, refreshDiffStatOf, clock ?? realClock);
  checkpointThrottle = createThrottle(CHECKPOINT_DURING_TURN_MS, checkpointOf, checkpointClock, nextCheckpointGapMs);
  tooLargeNoted.clear();
}

/** Called with each stored batch of a running turn's events. Never throws, never waits. */
export function noteTurnActivity(row: Pick<WorkbenchRow, 'id' | 'workCheckpointAt'>, drafts: ReadonlyArray<AgentEventDraft | Record<string, unknown>>): void {
  try {
    if (!draftsMayChangeFiles(drafts)) return;
    diffThrottle.poke(row.id);
    checkpointThrottle.poke(row.id, row.workCheckpointAt?.getTime() ?? -Infinity);
  } catch (err) {
    console.warn(`[workbench] noting turn activity on ${row.id} failed:`, err);
  }
}

/**
 * A person typed in the session's terminal, or a script ended: files may have
 * changed outside a turn. The checkpoint waits one interval from now, so a
 * burst of typing is one save. Never throws, never waits.
 */
export function noteWorkActivity(workbenchId: string): void {
  try {
    const now = checkpointClock.now();
    diffThrottle.poke(workbenchId, now);
    checkpointThrottle.poke(workbenchId, now);
  } catch (err) {
    console.warn(`[workbench] noting work activity on ${workbenchId} failed:`, err);
  }
}

/**
 * A live read found other changes than the stored copy: take a checkpoint,
 * and with it a new copy, within one interval. Never throws, never waits.
 */
export function noteChangesStale(workbenchId: string): void {
  try {
    checkpointThrottle.poke(workbenchId);
  } catch (err) {
    console.warn(`[workbench] noting stale changes on ${workbenchId} failed:`, err);
  }
}

/** The Changes route just read the box: the stat it stored is fresh. */
export function noteDiffStatFresh(workbenchId: string): void {
  diffThrottle.mark(workbenchId);
}

/** A turn ended: its own refresh and checkpoint replace any still waiting. */
export function settleTurnActivity(workbenchId: string): void {
  diffThrottle.cancel(workbenchId);
  checkpointThrottle.cancel(workbenchId);
  checkpointThrottle.mark(workbenchId);
}

// ============================================================================
// Checkpoint and restore
// ============================================================================

type CheckpointReason = 'turn_end' | 'during_turn' | 'restored';

const inFlight = new Map<string, Promise<SaveOutcome | null>>();
/** One run asked for while another ran, per session. Further asks join it. */
const followUps = new Map<string, { reason: CheckpointReason; job: Promise<SaveOutcome | null> }>();
/** Sessions already told that their work is too large to save, until a save works again. */
const tooLargeNoted = new Set<string>();

async function noteTooLarge(row: WorkbenchRow, size: number): Promise<void> {
  if (tooLargeNoted.has(row.id)) return;
  tooLargeNoted.add(row.id);
  await noteChats(row, 'work_checkpoint_too_large', tooLargeNote(size));
}

/** The reason a joined follow-up keeps: a turn end says more than a save during the turn. */
function strongerReason(a: CheckpointReason, b: CheckpointReason): CheckpointReason {
  const rank: Record<CheckpointReason, number> = { during_turn: 0, restored: 1, turn_end: 2 };
  return rank[b] > rank[a] ? b : a;
}

/**
 * Checkpoint the session's unsaved work into Talyn's storage. Null when the
 * session has no live box. Never throws; one at a time per session.
 *
 * An ask while a save runs is never dropped: that save may have read the box
 * before the work the ask is about (a turn end is the usual case). Exactly one
 * more save runs after the current one, on the row as it is then; any further
 * asks join that one.
 */
export function checkpointWork(row: WorkbenchRow, reason: CheckpointReason): Promise<SaveOutcome | null> {
  // A thread has no repository, so no work to save.
  if (!liveSandbox(row) || row.kind === 'thread') return Promise.resolve(null);
  const running = inFlight.get(row.id);
  if (!running) return startCheckpoint(row, reason);
  const queued = followUps.get(row.id);
  if (queued) {
    queued.reason = strongerReason(queued.reason, reason);
    return queued.job;
  }
  const entry: { reason: CheckpointReason; job: Promise<SaveOutcome | null> } = { reason, job: Promise.resolve(null) };
  entry.job = running.catch(() => null).then(async () => {
    followUps.delete(row.id);
    const latest = await getWorkbench(row.id).catch(() => null);
    if (!liveSandbox(latest) || latest.kind === 'thread') return null;
    // A save that started after this ask covers it.
    return inFlight.get(row.id) ?? startCheckpoint(latest, entry.reason);
  });
  followUps.set(row.id, entry);
  return entry.job;
}

function startCheckpoint(row: WorkbenchRow & { sandboxId: string }, reason: CheckpointReason): Promise<SaveOutcome | null> {
  const job = takeCheckpoint(row, reason).finally(() => inFlight.delete(row.id));
  inFlight.set(row.id, job);
  return job;
}

async function takeCheckpoint(row: WorkbenchRow & { sandboxId: string }, reason: string): Promise<SaveOutcome> {
  let result: SaveOutcome;
  let lost = false;
  const startedAt = checkpointClock.now();
  let saveMs = 0;
  try {
    result = await saveWork(row, 'checkpoint', { previousSha: row.workCheckpointSha });
  } catch (err) {
    lost = err instanceof FleetRunNotFoundError;
    result = { kind: 'failed', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    saveMs = Math.max(0, checkpointClock.now() - startedAt);
    checkpointThrottle.recordDuration(row.id, saveMs);
  }
  try {
    if (result.kind === 'saved') {
      await recordWorkCheckpoint(row.id, row.sandboxId, result.sha, result.at, result.size);
      recordWorkbenchEvent(row, 'work_checkpoint', `${reason}: saved ${result.sha.slice(0, 8)} (${result.size} bytes)`);
    } else if (result.kind === 'clean') {
      await clearWorkCheckpoint(row.id, row.sandboxId);
    } else if (result.kind === 'too_large') {
      recordWorkbenchEvent(row, 'work_checkpoint', `${reason}: ${result.size} bytes is over the limit`, false);
      await noteTooLarge(row, result.size);
    } else if (result.kind === 'failed') {
      console.warn(`[workbench] work checkpoint for ${row.id} (${reason}) failed: ${result.detail}`);
      recordWorkbenchEvent(row, 'work_checkpoint', `${reason}: ${result.detail}`, false);
    }
    if (result.kind !== 'too_large' && result.kind !== 'failed') tooLargeNoted.delete(row.id);
    await recordSaveResult(row, result, lost);
  } catch (err) {
    console.warn(`[workbench] recording the work checkpoint for ${row.id} failed:`, err);
  }
  // A copy of the changes for the Changes tab while the box sleeps. Outside
  // this save's lock, so the next save never waits behind a capture.
  if (!lost) requestCapture(row, reason, saveMs);
  return result;
}

// ============================================================================
// The changes capture after a save
// ============================================================================

/** The capture running per session, and at most one asked for while it runs. */
const captures = new Map<string, { running: Promise<void>; next: { reason: string; saveMs: number } | null }>();

/**
 * Capture the changes after a save, one at a time per session. An ask while
 * one runs queues exactly one more, on the row as it is then. The capture's
 * time counts with its save's in the checkpoint gap: both run on the box.
 */
function requestCapture(row: WorkbenchRow, reason: string, saveMs: number): void {
  const current = captures.get(row.id);
  if (current) {
    current.next = { reason: current.next?.reason === 'turn_end' ? 'turn_end' : reason, saveMs };
    return;
  }
  const entry: { running: Promise<void>; next: { reason: string; saveMs: number } | null } = { running: Promise.resolve(), next: null };
  const run = async (target: WorkbenchRow, why: string, ms: number): Promise<void> => {
    // A save that started meanwhile goes first: two git reads at once on a box near its memory ceiling is worse than a wait.
    await inFlight.get(target.id)?.catch(() => null);
    const startedAt = checkpointClock.now();
    try {
      await captureChanges(target, why);
    } finally {
      checkpointThrottle.recordDuration(target.id, ms + Math.max(0, checkpointClock.now() - startedAt));
    }
  };
  entry.running = (async () => {
    try {
      await run(row, reason, saveMs);
      while (entry.next) {
        const { reason: why, saveMs: ms } = entry.next;
        entry.next = null;
        const latest = await getWorkbench(row.id).catch(() => null);
        if (!liveSandbox(latest) || latest.kind === 'thread') break;
        await run(latest, why, ms);
      }
    } catch (err) {
      console.warn(`[workbench] the changes capture of ${row.id} failed:`, err);
    } finally {
      captures.delete(row.id);
    }
  })();
  captures.set(row.id, entry);
}

/** Tests wait for the capture a checkpoint started. */
export async function settledCapturesForTests(): Promise<void> {
  while (captures.size > 0) await Promise.all([...captures.values()].map((c) => c.running));
}

/** Put one system note in each open chat of the session. */
async function noteChats(row: WorkbenchRow, subtype: string, text: string): Promise<void> {
  for (const chat of await listChats(row.id)) {
    if (chat.closedAt) continue;
    const stored = await appendEvents(chat.id, [{ turn: chat.turnCount, event: { type: 'system', subtype, text } }]);
    emitWorkbenchEvents(chat.workspaceId, chat.id, stored);
  }
}

/**
 * Keep the save's result on the row, and tell the chat when a run of
 * failures starts, keeps going, or ends. A lost box is recorded but not
 * noted: the loss has its own note, and its replacement starts a new run.
 */
async function recordSaveResult(row: WorkbenchRow & { sandboxId: string }, result: SaveOutcome, lost: boolean): Promise<void> {
  const now = new Date(checkpointClock.now());
  if (result.kind === 'saved' || result.kind === 'unchanged' || result.kind === 'clean') {
    const unpushed = result.kind === 'clean' ? 0 : result.unpushed ?? null;
    const ended = await recordWorkSaveSuccess(row.id, row.sandboxId, result.kind === 'saved' ? result.at : now, unpushed);
    if (ended) await noteChats(row, 'work_checkpoint_recovered', CHECKPOINT_RECOVERED_NOTE);
    return;
  }
  const detail = result.kind === 'too_large'
    ? tooLargeNote(result.size)
    : result.detail;
  const failures = await recordWorkSaveFailure(row.id, row.sandboxId, now, detail);
  // The size has its own note, shown once.
  if (failures === null || lost || result.kind === 'too_large') return;
  if (failures === 1) {
    await noteChats(row, 'work_checkpoint_failed', checkpointFailedNote(result.detail, row.workCheckpointAt));
  } else if (failures === CHECKPOINT_KEEPS_FAILING_AFTER) {
    await noteChats(row, 'work_checkpoint_failed', checkpointKeepsFailingNote(failures, row.workCheckpointAt));
  }
}

/**
 * Put saved work of `kind` back on a new box, after its clone: copy the bundle
 * in a part at a time, then apply it. A lost NEW box is the provision's
 * failure and propagates; anything else becomes a `failed` answer for the note.
 */
export async function restoreWork(row: WorkbenchRow, kind: WorkKind): Promise<WorkRestore> {
  let restore: WorkRestore;
  try {
    const meta = await readWorkMeta(row, kind);
    if (!meta) {
      restore = { kind: 'none' };
    } else {
      const store = workObjectStore();
      const prefix = workPrefix(row, kind);
      const target = workRestoreBundle(row.id);
      const part = `${target}.part`;
      for (let i = 0; i < meta.parts; i++) {
        const body = await store.get(partKey(prefix, meta.generation, i));
        if (!body) throw new Error(`part ${i + 1} of ${meta.parts} of the saved work is missing`);
        await writeSandboxFiles(row, [{ path: part, base64: body.toString('base64') }], {
          ...(i === 0 ? { before: `: > ${target}` } : {}),
          after: `cat ${part} >> ${target} && rm -f ${part}`,
          timeoutMs: PART_TIMEOUT_MS,
        });
      }
      const r = await runCapture(row, workRestoreScript(row, meta), { timeoutMs: RESTORE_TIMEOUT_MS, diskRecovery: false });
      restore = parseWorkRestore(r);
    }
  } catch (err) {
    if (err instanceof FleetRunNotFoundError) throw err;
    restore = { kind: 'failed', detail: userFacingError(err) };
  }
  recordWorkbenchEvent(row, `work_${kind}_restore`, restore.kind === 'failed' ? restore.detail : restore.kind, restore.kind !== 'failed');
  return restore;
}
