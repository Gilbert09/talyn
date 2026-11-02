import { createHash } from 'node:crypto';
import type { WorkbenchChanges } from '@talyn/shared';
import type { WorkbenchRow } from './store.js';
import { WorkStorageUnavailableError, workObjectStore } from './workStorage.js';

/**
 * The last changed-files list Talyn read from a session's box, kept in Talyn's
 * storage next to the saved work (see `workCheckpoint.ts`):
 *
 *   <workspaceId>/<workbenchId>/changes/snapshot.json
 *
 * A suspended box cannot change, so this copy is still right while the box
 * sleeps, and the Changes tab can show it without waking the box. It is in
 * storage and not in a column: the list can be large, and `WORKBENCH_COLUMNS`
 * is read on every hot path.
 */

interface StoredSnapshot {
  version: 1;
  takenAt: string;
  changes: WorkbenchChanges;
}

type SnapshotRow = Pick<WorkbenchRow, 'workspaceId' | 'id'>;

export function changesSnapshotKey(row: SnapshotRow): string {
  return `${row.workspaceId}/${row.id}/changes/snapshot.json`;
}

/** The hash of the last list this process wrote, per workbench, so an unchanged poll does not upload again. */
const lastWritten = new Map<string, string>();
/** Writes per workbench run one at a time, in call order. */
const writing = new Map<string, Promise<void>>();

function hashOf(changes: WorkbenchChanges): string {
  return createHash('sha256').update(JSON.stringify(changes)).digest('hex');
}

async function put(row: SnapshotRow, changes: WorkbenchChanges, hash: string): Promise<void> {
  if (lastWritten.get(row.id) === hash) return;
  const body: StoredSnapshot = { version: 1, takenAt: new Date().toISOString(), changes };
  try {
    await workObjectStore().put(changesSnapshotKey(row), Buffer.from(JSON.stringify(body)));
    lastWritten.set(row.id, hash);
  } catch (err) {
    lastWritten.delete(row.id);
    if (err instanceof WorkStorageUnavailableError) return;
    console.warn(`[workbench] storing the changes snapshot of ${row.id} failed:`, err);
  }
}

/** Store the list a read of the box just produced. Best effort: never throws. */
export function writeChangesSnapshot(
  row: Pick<WorkbenchRow, 'workspaceId' | 'id' | 'runtime' | 'kind'>,
  changes: WorkbenchChanges,
): Promise<void> {
  if (row.runtime !== 'sandbox' || row.kind === 'thread') return Promise.resolve();
  const hash = hashOf(changes);
  const next = (writing.get(row.id) ?? Promise.resolve()).then(() => put(row, changes, hash));
  writing.set(row.id, next);
  void next.finally(() => {
    if (writing.get(row.id) === next) writing.delete(row.id);
  });
  return next;
}

/** The stored list with the time it was taken, or null when there is none or storage is not usable. */
export async function readChangesSnapshot(row: SnapshotRow): Promise<WorkbenchChanges | null> {
  try {
    const raw = await workObjectStore().get(changesSnapshotKey(row));
    if (!raw) return null;
    const stored = JSON.parse(raw.toString('utf8')) as StoredSnapshot;
    if (stored.version !== 1 || !Array.isArray(stored.changes?.files) || typeof stored.takenAt !== 'string') return null;
    return { ...stored.changes, snapshotAt: stored.takenAt };
  } catch (err) {
    if (!(err instanceof WorkStorageUnavailableError)) {
      console.warn(`[workbench] reading the changes snapshot of ${row.id} failed:`, err);
    }
    return null;
  }
}

/** Remove the stored list. Called when the session is deleted. */
export async function deleteChangesSnapshot(row: SnapshotRow): Promise<void> {
  lastWritten.delete(row.id);
  try {
    await workObjectStore().remove([changesSnapshotKey(row)]);
  } catch (err) {
    if (!(err instanceof WorkStorageUnavailableError)) throw err;
  }
}

/** Tests start each case with no memory of earlier writes. */
export function resetChangesSnapshotsForTests(): void {
  lastWritten.clear();
  writing.clear();
}
