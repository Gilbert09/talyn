import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { WorkbenchChanges, WorkbenchDiffScope } from '@talyn/shared';
import { FleetRunNotFoundError } from '../selfHosted/client.js';
import { parseChangeLists, storeDiffStat } from './changes.js';
import {
  captureCleanupScript,
  capturedObjectPath,
  captureReadChunkScript,
  changesCaptureScript,
  contentsEntries,
  parseCaptureOutput,
  parseListSections,
} from './changesCaptureScript.js';
import {
  changesEtag,
  contentsIndexKeyOf,
  deleteAllChanges,
  deleteGeneration,
  indexKeyOf,
  listsKey,
  listsKeyOf,
  objectPartKey,
  readChangesMeta,
  withChangesLock,
  writeChangesMeta,
  type ChangesMeta,
  type ChangesObjectName,
  type PatchIndex,
  type PatchIndexEntry,
  type StoredObject,
} from './changesStore.js';
import { emitWorkbenchUpdated } from './emit.js';
import { userFacingError } from './errors.js';
import { publicWorkbench } from './prLink.js';
import { recordWorkbenchEvent, runCapture, type SandboxExecOptions, type SandboxExecResult } from './sandboxRuntime.js';
import { readFleetRecord } from './sandboxStatus.js';
import { getWorkbench, updateWorkbench, type WorkbenchRow } from './store.js';
import { isWorkStorageConfigured, WorkStorageUnavailableError, workObjectStore } from './workStorage.js';

/**
 * Store a copy of a session's changes while its box runs, so the Changes and
 * Files tabs can show them while it sleeps (see `changesStore.ts` for the
 * layout and `changesCaptureScript.ts` for the guest side).
 *
 * One exec stages everything in the box's tmpfs and prints a manifest; the
 * backend then reads each object out a 2 MiB part at a time, as the saved
 * work does, so it never holds more than one part of a patch. When the merge
 * base, HEAD and the work tree are those of the last copy, the box says
 * `UNCHANGED` and nothing is read.
 *
 * Triggers: every work checkpoint (turn end, during a turn that changes files,
 * terminal input, a script's end, a restore), a ready box after a start or a
 * move, and an archive. Best effort: a capture never throws.
 */

/** One part: a quiet exec answer is cut at 4 MiB, and capture mode sends base64. The saved work's part size. */
export const CAPTURE_PART_BYTES = 2 * 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 3 * 60_000;
const PART_TIMEOUT_MS = 2 * 60_000;
/** Removing the staging is one `rm -rf` in tmpfs. A box that does not answer in this time is left alone. */
const CLEANUP_TIMEOUT_MS = 15_000;
/** The lists are read into memory to parse. Past this, the capture fails rather than holding more. */
const LISTS_MAX_BYTES = 32 * 1024 * 1024;

export type CaptureOutcome =
  | { kind: 'captured'; meta: ChangesMeta; changes: WorkbenchChanges }
  | { kind: 'unchanged'; meta: ChangesMeta }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; detail: string };

/** How the capture runs a script on the box. Tests run it against a real repository. */
export interface CaptureRunner {
  /** The guest's tmpfs, where the script stages. */
  tmpDir: string;
  run(row: WorkbenchRow, script: string, opts: SandboxExecOptions): Promise<SandboxExecResult>;
  /**
   * True only when the fleet says the box runs now. The cleanup after a
   * failed exec asks first: an exec on a sleeping box wakes it.
   */
  isRunning(row: WorkbenchRow & { sandboxId: string }): Promise<boolean>;
}

async function boxIsRunning(row: WorkbenchRow & { sandboxId: string }): Promise<boolean> {
  const read = await readFleetRecord({ workspaceId: row.workspaceId, fleetHost: row.fleetHost, sandboxId: row.sandboxId }, Date.now(), { fresh: true });
  if (!read.ok || read.terminal || read.retired) return false;
  return read.sandbox?.status === 'idle' || read.sandbox?.status === 'busy';
}

const boxRunner: CaptureRunner = { tmpDir: '/dev/shm', run: (row, script, opts) => runCapture(row, script, opts), isRunning: boxIsRunning };
let runner: CaptureRunner = boxRunner;

export function setCaptureRunnerForTests(next: CaptureRunner | null): void {
  runner = next ?? boxRunner;
}

let limits: { maxPatchBytes?: number } = {};

/** Tests use small caps, so an over-large patch needs no large repository. */
export function setCaptureLimitsForTests(next: { maxPatchBytes?: number } | null): void {
  limits = next ?? {};
}

const SCOPES: Array<[WorkbenchDiffScope, ChangesObjectName, string]> = [
  ['combined', 'patch', 'P_COMBINED'],
  ['uncommitted', 'patch-uncommitted', 'P_UNCOMMITTED'],
  ['committed', 'patch-committed', 'P_COMMITTED'],
];

function capturable(row: WorkbenchRow, archiving: boolean): row is WorkbenchRow & { sandboxId: string } {
  return row.runtime === 'sandbox' && row.kind !== 'thread' && !!row.sandboxId && (row.status === 'ready' || archiving);
}

/**
 * Capture the session's changes into storage. One at a time per session; a
 * call while one runs waits for it and then runs. Never throws.
 */
export function captureChanges(row: WorkbenchRow, reason: string): Promise<CaptureOutcome> {
  if (!capturable(row, reason === 'archive')) return Promise.resolve({ kind: 'skipped', reason: 'no running sandbox' });
  if (!isWorkStorageConfigured()) return Promise.resolve({ kind: 'skipped', reason: 'storage is not configured' });
  return withChangesLock(row.id, () => capture(row, reason)).catch((err): CaptureOutcome => {
    if (err instanceof WorkStorageUnavailableError) return { kind: 'skipped', reason: 'storage is not configured' };
    return { kind: 'failed', detail: userFacingError(err) };
  });
}

async function capture(row: WorkbenchRow & { sandboxId: string }, reason: string): Promise<CaptureOutcome> {
  const started = Date.now();
  // Uncached: another process may have written a newer copy.
  const previous = await readChangesMeta(row, { fresh: true });
  // When the box was read. A list stored after this is newer than this copy's.
  const observedAt = new Date();
  /** `staged`: the box may hold a staging dir. `execThrew`: the last exec threw, so the box state is unknown. */
  let staged = false;
  let execThrew = false;
  /** A generation with parts in storage that no meta names yet. Deleted if the capture stops. */
  let orphan: string | null = null;
  try {
    const script = changesCaptureScript(row, {
      previous: previous ? { mergeBase: previous.mergeBase, headSha: previous.headSha, treeSha: previous.treeSha } : null,
      ...limits,
    });
    staged = true;
    execThrew = true;
    const r = await runner.run(row, script, {
      quiet: true, timeoutMs: CAPTURE_TIMEOUT_MS, env: { TMPDIR: runner.tmpDir, GIT_OPTIONAL_LOCKS: '0' }, diskRecovery: false,
    });
    execThrew = false;
    const parsed = parseCaptureOutput(r);
    if (parsed.kind === 'failed') {
      record(row, reason, `failed: ${parsed.detail}`, false);
      return parsed;
    }
    if (parsed.kind === 'unchanged') {
      // The script removed its staging before it printed UNCHANGED.
      staged = false;
      if (!previous) return { kind: 'failed', detail: 'the box reported no change, but no copy is stored' };
      // The same work on another box, or a list that moved and came back: the copy is right again.
      if (previous.sandboxId === row.sandboxId && !previous.listNewer) {
        if (row.changesEtag !== previous.etag) await announce(row, previous);
        return { kind: 'unchanged', meta: previous };
      }
      const meta: ChangesMeta = {
        ...previous,
        sandboxId: row.sandboxId,
        etag: changesEtag(row.sandboxId, previous.mergeBase, previous.headSha, previous.treeSha),
      };
      delete meta.listNewer;
      if (!(await sessionExists(row))) return { kind: 'skipped', reason: 'the session was deleted' };
      await writeChangesMeta(row, meta);
      if (!(await announce(row, meta))) return { kind: 'skipped', reason: 'the session was deleted' };
      return { kind: 'unchanged', meta };
    }
    const generation = `${Date.now().toString(36)}-${parsed.treeSha.slice(0, 8)}`;
    orphan = generation;
    const objects: ChangesMeta['objects'] = {};
    let listsBody: Buffer | null = null;
    for (const obj of parsed.objects) {
      if (obj.name === 'lists') {
        if (obj.bytes > LISTS_MAX_BYTES) throw new Error(`the changes list is ${obj.bytes} bytes compressed`);
        execThrew = true;
        listsBody = (await readStaged(row, obj.name, obj.bytes, obj.sha256, null)).body;
        execThrew = false;
        continue;
      }
      // With no commits on the branch, or nothing uncommitted, two patches are the same bytes: store them once.
      const twin = (Object.entries(objects) as Array<[ChangesObjectName, StoredObject]>)
        .find(([, o]) => 'sha256' in o && o.sha256 === obj.sha256 && !o.from);
      if (twin && 'parts' in twin[1]) {
        objects[obj.name] = { ...twin[1], from: twin[0] };
        continue;
      }
      execThrew = true;
      const { parts } = await readStaged(row, obj.name, obj.bytes, obj.sha256, { generation, name: obj.name });
      execThrew = false;
      objects[obj.name] = { parts, bytes: obj.bytes, sha256: obj.sha256, raw: obj.raw } as StoredObject;
    }
    for (const t of parsed.tooLarge) objects[t.name] = { tooLarge: t.raw };
    if (!listsBody) throw new Error('the capture staged no lists');
    const sections = parseListSections(gunzipSync(listsBody));
    const text = (label: string) => sections[label]?.toString('utf8') ?? '';
    const changes = parseChangeLists(Object.fromEntries(Object.keys(sections).map((k) => [k, text(k)])));
    const index: PatchIndex = {};
    for (const [scope, name, label] of SCOPES) {
      const stored = objects[name];
      if (!stored || !('parts' in stored)) continue;
      const entries = patchIndex(sections[label] ?? Buffer.alloc(0), text(`${label}_OFFSETS`), stored.raw);
      if (entries) index[scope] = entries;
    }
    const store = workObjectStore();
    await store.put(listsKeyOf(row, generation), Buffer.from(JSON.stringify(changes)));
    await store.put(indexKeyOf(row, generation), Buffer.from(JSON.stringify(index)));
    if (objects.contents && 'parts' in objects.contents) {
      const entries = contentsEntries(sections.CHANGED ?? Buffer.alloc(0), text('CONTENT_INDEX'));
      await store.put(contentsIndexKeyOf(row, generation), Buffer.from(JSON.stringify(entries)));
    }
    const meta: ChangesMeta = {
      version: 2,
      generation,
      takenAt: new Date().toISOString(),
      sandboxId: row.sandboxId,
      mergeBase: parsed.mergeBase,
      headSha: parsed.headSha,
      treeSha: parsed.treeSha,
      etag: changesEtag(row.sandboxId, parsed.mergeBase, parsed.headSha, parsed.treeSha),
      listsKey: listsKey(changes),
      objects,
    };
    // A session deleted during the capture has had its stored changes removed: do not put a copy back.
    if (!(await sessionExists(row))) return { kind: 'skipped', reason: 'the session was deleted' };
    await writeChangesMeta(row, meta);
    orphan = null;
    // Announce first: a process that cached the old meta reads the new one
    // when it sees the new etag on the row, before the old parts go.
    const updated = await announce(row, meta);
    if (!updated) return { kind: 'skipped', reason: 'the session was deleted' };
    if (previous && previous.generation !== generation) {
      await deleteGeneration(row, previous.generation).catch((err) =>
        console.warn(`[workbench] removing the old stored changes of ${row.id} failed:`, err),
      );
    }
    // The sidebar's number and the list-only copy follow the same read, unless a newer list is already stored.
    await storeDiffStat(updated, changes, { observedAt }).catch((err) => console.warn(`[workbench] storing the diff stat of ${row.id} failed:`, err));
    const bytes = Object.values(objects).reduce((sum, o) => sum + ('bytes' in o && !o.from ? o.bytes : 0), 0);
    record(row, reason, `stored ${meta.etag} (${bytes} bytes) in ${Date.now() - started} ms`, true);
    return { kind: 'captured', meta, changes };
  } catch (err) {
    if (err instanceof FleetRunNotFoundError) {
      staged = false;
      return { kind: 'skipped', reason: 'the sandbox is gone' };
    }
    if (err instanceof WorkStorageUnavailableError) throw err;
    record(row, reason, `failed: ${userFacingError(err)}`, false);
    return { kind: 'failed', detail: userFacingError(err) };
  } finally {
    if (orphan) {
      await deleteGeneration(row, orphan).catch((err) =>
        console.warn(`[workbench] removing the unfinished stored changes of ${row.id} failed:`, err),
      );
    }
    if (staged) await cleanStaging(row, execThrew);
  }
}

/**
 * Remove the box's staging. After an exec that threw (a timeout, a dropped
 * connection) the box may since have gone to sleep, and the cleanup exec
 * would wake it: it runs only when the fleet says the box runs. Quiet, short,
 * and never throws; a staging left behind is replaced by the next capture.
 */
async function cleanStaging(row: WorkbenchRow & { sandboxId: string }, afterThrow: boolean): Promise<void> {
  try {
    if (afterThrow && !(await runner.isRunning(row))) return;
    await runner.run(row, captureCleanupScript(row.id, runner.tmpDir), {
      cwd: '/', quiet: true, timeoutMs: CLEANUP_TIMEOUT_MS, diskRecovery: false,
    });
  } catch {
    // Best effort.
  }
}

async function sessionExists(row: WorkbenchRow): Promise<boolean> {
  return (await getWorkbench(row.id)) !== null;
}

function record(row: WorkbenchRow, reason: string, text: string, ok: boolean): void {
  recordWorkbenchEvent(row, 'changes_capture', `${reason}: ${text}`, ok);
}

/**
 * Put the new copy's time and etag on the row and tell the clients, so they
 * fetch it again. Null when the session is gone: its stored changes are then
 * removed, because the delete may have run before this copy was written.
 */
async function announce(row: WorkbenchRow, meta: ChangesMeta): Promise<WorkbenchRow | null> {
  const updated = await updateWorkbench(row.id, { changesAt: new Date(meta.takenAt), changesEtag: meta.etag });
  if (!updated) {
    await deleteAllChanges(row).catch((err) => console.warn(`[workbench] removing the stored changes of deleted ${row.id} failed:`, err));
    return null;
  }
  await emitWorkbenchUpdated(await publicWorkbench(updated));
  return updated;
}

/**
 * Read a staged object out of the box a part at a time. With `to`, each part
 * goes to storage and only the part count comes back; without, the parts are
 * kept and come back joined. The checksum is checked either way.
 */
async function readStaged(
  row: WorkbenchRow & { sandboxId: string },
  name: string,
  size: number,
  sha256: string,
  to: { generation: string; name: ChangesObjectName } | null,
): Promise<{ parts: number; body: Buffer | null }> {
  const path = capturedObjectPath(row.id, name, runner.tmpDir);
  const parts = Math.max(1, Math.ceil(size / CAPTURE_PART_BYTES));
  const hash = createHash('sha256');
  const kept: Buffer[] = [];
  for (let i = 0; i < parts; i++) {
    const offset = i * CAPTURE_PART_BYTES;
    const length = Math.min(CAPTURE_PART_BYTES, size - offset);
    const r = await runner.run(row, captureReadChunkScript(path, offset, length), {
      cwd: '/', quiet: true, timeoutMs: PART_TIMEOUT_MS, env: { TMPDIR: runner.tmpDir }, diskRecovery: false,
    });
    if (r.exitCode !== 0) throw new Error(`could not read the stored ${name}: ${r.stderr.trim().slice(-200)}`);
    if (r.truncated || r.stdoutBytes.length !== length) {
      throw new Error(`reading the stored ${name} returned ${r.stdoutBytes.length} of ${length} bytes`);
    }
    hash.update(r.stdoutBytes);
    if (to) await workObjectStore().put(objectPartKey(row, to.generation, to.name, i), r.stdoutBytes);
    else kept.push(r.stdoutBytes);
  }
  if (hash.digest('hex') !== sha256) throw new Error(`the ${name} read from the box does not match its checksum`);
  return { parts, body: to ? null : Buffer.concat(kept) };
}

/**
 * Where each file starts in a patch. `names` is git's `--name-status -z`
 * list and `offsets` the byte offset of each `diff --git` line, both in the
 * patch's own order. Null when they do not pair up one to one.
 */
export function patchIndex(names: Buffer, offsets: string, rawBytes: number): PatchIndexEntry[] | null {
  const fields = names.toString('utf8').split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  const files: Array<{ status: string; path: string; oldPath?: string }> = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!status) return null;
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = fields[i++];
      const path = fields[i++];
      if (oldPath === undefined || path === undefined) return null;
      files.push({ status: status[0], path, oldPath });
    } else {
      const path = fields[i++];
      if (path === undefined) return null;
      files.push({ status: status[0], path });
    }
  }
  const starts = offsets.split('\n').filter(Boolean).map(Number);
  if (starts.length !== files.length || starts.some((n) => !Number.isFinite(n))) return null;
  return files.map((f, i) => ({
    ...f,
    offset: starts[i],
    length: (i + 1 < starts.length ? starts[i + 1] : rawBytes) - starts[i],
  }));
}
