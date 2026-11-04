import { isResuming } from './sandboxRuntime.js';
import { readFleetRecord, type FleetRead } from './sandboxStatus.js';
import type { WorkbenchRow } from './store.js';

/**
 * Where a read of a session's work comes from: the box, or what Talyn stored.
 *
 * Only the fleet's record can say that a box sleeps. Talyn never writes
 * `suspended` into `sandbox_state`: an asleep ready session keeps `running`
 * there. So the row alone cannot decide, and an exec on a sleeping box wakes
 * it. The fleet's `GET /v1/sandboxes/{id}` never wakes a box, and
 * `readFleetRecord` caches it for a few seconds.
 *
 * A box that is not running cannot change, so a stored copy of its work is
 * still correct.
 */

export type StoredReadReason =
  /** The fleet suspended the box. */
  | 'asleep'
  /** The box is waking (Talyn resumes it, or the fleet starts it). */
  | 'waking'
  | 'archived'
  /** The box is gone, or the fleet no longer runs it. */
  | 'lost'
  /** The session has no box yet. */
  | 'starting'
  /** The fleet did not answer. A stored copy answers; with none, the read goes on to the box. */
  | 'fleet_unreachable';

export type ReadSource = { live: true } | { live: false; reason: StoredReadReason };

const LIVE: ReadSource = { live: true };

function fromFleet(read: FleetRead): ReadSource | null {
  if (!read.ok) return { live: false, reason: 'fleet_unreachable' };
  const status = read.sandbox?.status;
  if (read.terminal || read.retired || status === 'failed' || status === 'stopped' || status === 'cancelled') {
    return { live: false, reason: 'lost' };
  }
  switch (status) {
    case 'idle':
    case 'busy':
      return null;
    case 'suspended':
      return { live: false, reason: 'asleep' };
    case 'queued':
    case 'starting':
      return { live: false, reason: 'waking' };
    default:
      return { live: false, reason: 'fleet_unreachable' };
  }
}

/** True when an idle record says the box went to sleep after the record was read. */
function sleptSince(read: FleetRead, now: number): boolean {
  if (!read.ok || read.sandbox?.status !== 'idle') return false;
  const last = read.sandbox.lastRequestAt ? Date.parse(read.sandbox.lastRequestAt) : NaN;
  const ttl = read.sandbox.idleTtlSec;
  return Number.isFinite(last) && last > 0 && typeof ttl === 'number' && ttl > 0 && last + ttl * 1000 <= now;
}

/**
 * Decide the source of a read that did not ask for `live`. A session that is
 * not ready for another reason (a move, a start) goes to the box path, which
 * waits for the move or refuses with `not_ready`, as before.
 */
export async function chooseReadSource(row: WorkbenchRow, now = Date.now()): Promise<ReadSource> {
  if (row.runtime !== 'sandbox') return LIVE;
  if (row.archivedAt) return { live: false, reason: 'archived' };
  if (row.sandboxState === 'lost') return { live: false, reason: 'lost' };
  if (row.sandboxState !== 'running') return { live: false, reason: row.sandboxState === 'suspended' ? 'asleep' : 'starting' };
  if (row.status !== 'ready' || !row.sandboxId) return LIVE;
  if (isResuming(row.sandboxId)) return { live: false, reason: 'waking' };
  const box = { workspaceId: row.workspaceId, fleetHost: row.fleetHost, sandboxId: row.sandboxId };
  let read = await readFleetRecord(box, now);
  // A cached "idle" can be up to ten seconds old. Past its idle time the box
  // may sleep now, and an exec would wake it: ask the fleet again.
  if (sleptSince(read, now)) read = await readFleetRecord(box, now, { fresh: true });
  return fromFleet(read) ?? LIVE;
}
