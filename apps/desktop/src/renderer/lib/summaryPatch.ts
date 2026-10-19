import type { PRSummaryShape } from './api';

// Written together by the backend on every checks write, so they are dropped
// together when stale — keeping a newer `checks` beside an older verdict is
// how a pill contradicts itself.
const CHECK_KEYS = ['checks', 'ciStatus', 'humanGates', 'blockingReason', 'checksAt'] as const;

/**
 * Structural equality for the JSON values a `pull_request:updated` echo
 * carries. Every echo is a freshly parsed object, so a reference check alone
 * would call every echo a change and re-render every row it touches.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && jsonEqual(ao[k], bo[k]));
}

/**
 * Merge a `pull_request:updated` summary into the one held.
 *
 * Merge, don't replace: an incremental echo carries only the changed slice
 * (e.g. `{ checks }`). And refuse a checks slice OLDER than the held one:
 * broadcasts cross replicas through Redis, so a partial from one replica can
 * land after a newer full write from another.
 *
 * Returns `held` itself when the patch changes nothing, so a caller can tell
 * "no change" by reference. An absent patch is "no change" too: the merge
 * queue's position broadcast sends no summary at all.
 */
export function mergeSummaryPatch(
  held: PRSummaryShape | undefined,
  patch: Partial<PRSummaryShape> | undefined
): PRSummaryShape {
  if (!patch) return held ?? ({} as PRSummaryShape);
  let fresh: Partial<PRSummaryShape> = patch;
  const heldAt = held?.checksAt;
  const patchAt = patch.checksAt;
  if (typeof heldAt === 'number' && typeof patchAt === 'number' && patchAt < heldAt) {
    fresh = { ...patch };
    for (const key of CHECK_KEYS) delete fresh[key];
  }
  if (held) {
    const heldRecord = held as unknown as Record<string, unknown>;
    const freshRecord = fresh as Record<string, unknown>;
    if (Object.keys(freshRecord).every((k) => jsonEqual(heldRecord[k], freshRecord[k]))) {
      return held;
    }
  }
  return { ...held, ...fresh } as PRSummaryShape;
}
