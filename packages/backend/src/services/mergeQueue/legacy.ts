// Merge queue v2 — the public WS/REST payload.
//
// This file used to carry a second job: mapping every entry down to the
// four-status shape v1 emitted, and mirroring it into
// pull_requests.merge_queue_state, so desktop builds predating the v2 payload
// kept a working queue badge through the rollout. That shim was removed on
// 2026-09-01 — the v2 desktop surface shipped with the cutover, and 44 releases
// of a nightly auto-updating app have gone out since. `merge_queue_entries` is
// now the only source of queue state.

import type { ExternalQueueState } from '@talyn/shared';
import type { EntrySnapshot } from './types.js';

/**
 * The provider state as clients get it. `pending_failure` goes out as
 * `testing`, the state trunk showed just before it.
 *
 * Desktop builds older than Session 118 crash on a state they don't know:
 * their `externalQueueStateLabel` has no default case, so it returns nothing
 * and the PR pill and the queue table call `.toLowerCase()` on it. The backend
 * deploys on every push while installed apps update on idle, so those builds
 * would get this state first. Drop the mapping once they have aged out, the
 * way the v1 shim this file used to carry was retired. Builds from Session
 * 118 on fall back to a generic label for any state newer than themselves.
 */
function publicExternalState(state: ExternalQueueState): ExternalQueueState {
  return state === 'pending_failure' ? 'testing' : state;
}

/** The v2 payload richer clients render (new badges, budgets, head scope). */
export function toPublicMergeQueue(
  entry: EntrySnapshot,
  position: number
): Record<string, unknown> {
  return {
    status: entry.status,
    position,
    blockedCode: entry.blockedCode,
    reason: entry.blockedReason ?? undefined,
    /** Which flavor the in-flight fix run is — lets the UI label a 'fixing'
     *  entry as Re-signing vs Fixing and pick the matching budget. */
    fixKind: entry.fixKind ?? undefined,
    headShaShort: entry.headSha ? entry.headSha.slice(0, 7) : undefined,
    budgets: {
      fixRuns: [entry.fixAttempts, 3],
      checkReruns: [entry.rerunAttempts, 3],
      resigns: [entry.resignAttempts, 3],
    },
    autoMerge: entry.automergeArmedBy
      ? { armed: true, armedBy: entry.automergeArmedBy }
      : { armed: false },
    /** Merge stack: the PR this one is, or was, stacked on. The client derives
     *  stack membership itself from the open rows' branches; this is the piece
     *  it can't — the parent of a PR already retargeted off that branch. */
    stackParentNumber: entry.stackParentNumber ?? undefined,
    /** Merge stack, batch submission: the PR whose submission to the external
     *  queue is carrying this one. The client cannot derive it — the covering
     *  rung is chosen server-side and the covered rung has no signal of its
     *  own — and it is the difference between the badge reading "waiting for
     *  #123 to merge" and "in the queue, with #123". */
    stackCoveredBy: entry.externalCoveredBy ?? undefined,
    /** External merge queue (trunk.io / GitHub native): how the PR was handed
     *  over, how many submissions this head has spent, and where the provider
     *  itself says the PR is. `state` is the authoritative channel — read off
     *  the provider's own comment — and is present even when the submission
     *  bookkeeping isn't (a PR someone submitted outside Talyn). */
    external:
      entry.externalSubmitVia || entry.externalState
        ? {
            ...(entry.externalSubmitVia
              ? { via: entry.externalSubmitVia, submits: [entry.submitAttempts, 3] }
              : {}),
            ...(entry.externalState ? { state: publicExternalState(entry.externalState) } : {}),
          }
        : undefined,
  };
}
