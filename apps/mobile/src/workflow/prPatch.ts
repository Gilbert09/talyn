import type { MergeQueuePublic, PRRow, PRState, PRSummaryShape } from '@talyn/client/native';

/** A `pull_request:updated` payload. Mirrors web `PullRequestUpdatePayload`. */
export interface PullRequestUpdate {
  id: string;
  taskId?: string | null;
  state: PRState;
  /** May be partial: an incremental checks echo carries only the changed slice. */
  lastSummary?: Partial<PRSummaryShape>;
  reviewRequested?: boolean;
  reviewRequestedFirstSeenAt?: string | null;
  reviewHiddenAt?: string | null;
  authored?: boolean;
  watching?: boolean;
  autoKeepMergeable?: boolean;
  autoMergeState?: PRRow['autoMergeState'];
  mergeQueued?: boolean;
  mergeQueue?: MergeQueuePublic | null;
  codeReview?: PRRow['codeReview'];
}

const CHECK_KEYS = ['checks', 'ciStatus', 'humanGates', 'blockingReason', 'checksAt'] as const;

export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => jsonEqual(value, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && jsonEqual(left[key], right[key]));
}

/** Merge a partial summary into the held one. A checks slice older than the held one is dropped. */
export function mergeSummaryPatch(held: PRSummaryShape, patch: Partial<PRSummaryShape> | undefined): PRSummaryShape {
  if (!patch) return held;
  let fresh: Partial<PRSummaryShape> = patch;
  if (typeof held.checksAt === 'number' && typeof patch.checksAt === 'number' && patch.checksAt < held.checksAt) {
    fresh = { ...patch };
    for (const key of CHECK_KEYS) delete fresh[key];
  }
  const heldRecord = held as unknown as Record<string, unknown>;
  if (Object.entries(fresh).every(([key, value]) => jsonEqual(heldRecord[key], value))) return held;
  return { ...held, ...fresh };
}

const ROW_FIELDS = ['state', 'summary', 'taskId', 'reviewRequested', 'reviewRequestedFirstSeenAt', 'reviewHiddenAt', 'authored', 'watching',
  'autoKeepMergeable', 'autoMergeState', 'mergeQueued', 'mergeQueue', 'codeReview'] as const satisfies readonly (keyof PRRow)[];

/** Merge one echo into a held row. Returns `row` itself when nothing changed. Absent fields keep ours; `null` clears. */
export function mergeRowUpdate(row: PRRow, update: PullRequestUpdate): PRRow {
  const next: PRRow = {
    ...row,
    state: update.state,
    summary: mergeSummaryPatch(row.summary, update.lastSummary),
    taskId: update.taskId ?? row.taskId,
    reviewRequested: update.reviewRequested ?? row.reviewRequested,
    reviewRequestedFirstSeenAt: update.reviewRequestedFirstSeenAt ?? row.reviewRequestedFirstSeenAt,
    reviewHiddenAt: update.reviewHiddenAt !== undefined ? update.reviewHiddenAt : row.reviewHiddenAt,
    authored: update.authored ?? row.authored,
    watching: update.watching ?? row.watching,
    autoKeepMergeable: update.autoKeepMergeable ?? row.autoKeepMergeable,
    autoMergeState: update.autoMergeState !== undefined ? update.autoMergeState : row.autoMergeState,
    mergeQueued: update.mergeQueued ?? row.mergeQueued,
    mergeQueue: update.mergeQueue !== undefined ? update.mergeQueue : row.mergeQueue,
    codeReview: update.codeReview !== undefined ? update.codeReview : row.codeReview,
  };
  return ROW_FIELDS.some((key) => !jsonEqual(row[key], next[key])) ? next : row;
}

/**
 * Apply an echo to the open-PR list. Returns the same array when nothing changed.
 * `refetch` is true for an open PR the list does not hold: it cannot be built from the echo.
 */
export function applyPrUpdate(rows: PRRow[], update: PullRequestUpdate): { rows: PRRow[]; refetch: boolean } {
  const index = rows.findIndex((row) => row.id === update.id);
  if (index === -1) return { rows, refetch: update.state === 'open' };
  if (update.state !== 'open') return { rows: rows.filter((row) => row.id !== update.id), refetch: false };
  const merged = mergeRowUpdate(rows[index], update);
  if (merged === rows[index]) return { rows, refetch: false };
  const next = rows.slice();
  next[index] = merged;
  return { rows: next, refetch: false };
}

/**
 * Keep the held row object for each fetched row that did not change, so a list
 * refetch re-renders only the rows that moved. Returns `held` itself when nothing changed.
 */
export function reuseRows(held: PRRow[] | undefined, fresh: PRRow[]): PRRow[] {
  if (!held?.length) return fresh;
  const byId = new Map(held.map((row) => [row.id, row]));
  let same = held.length === fresh.length;
  const rows = fresh.map((row, index) => {
    const prior = byId.get(row.id);
    const kept = prior && jsonEqual(prior, row) ? prior : row;
    if (kept !== held[index]) same = false;
    return kept;
  });
  return same ? held : rows;
}
