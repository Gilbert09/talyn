import type { PRSummaryShape } from './api';

// Written together by the backend on every checks write, so they are dropped
// together when stale — keeping a newer `checks` beside an older verdict is
// how a pill contradicts itself.
const CHECK_KEYS = ['checks', 'ciStatus', 'humanGates', 'blockingReason', 'checksAt'] as const;

/**
 * Merge a `pull_request:updated` summary into the one held.
 *
 * Merge, don't replace: an incremental echo carries only the changed slice
 * (e.g. `{ checks }`). And refuse a checks slice OLDER than the held one:
 * broadcasts cross replicas through Redis, so a partial from one replica can
 * land after a newer full write from another.
 */
export function mergeSummaryPatch(
  held: PRSummaryShape | undefined,
  patch: Partial<PRSummaryShape>
): PRSummaryShape {
  const heldAt = held?.checksAt;
  const patchAt = patch.checksAt;
  if (typeof heldAt === 'number' && typeof patchAt === 'number' && patchAt < heldAt) {
    const fresh: Partial<PRSummaryShape> = { ...patch };
    for (const key of CHECK_KEYS) delete fresh[key];
    return { ...held, ...fresh } as PRSummaryShape;
  }
  return { ...held, ...patch } as PRSummaryShape;
}
