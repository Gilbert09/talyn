// Does the external merge queue on this branch take a whole stack at once?
//
// trunk.io does: enqueue any rung of a GitHub native stack and it tests and
// lands that rung plus every rung beneath it atomically, in one round of CI.
// That is the difference between a four-deep stack costing one ~40-minute test
// cycle on posthog/posthog and costing four, plus a retarget and often a paid
// rebase run between each pair. So the batch is the default and Talyn tries it
// first.
//
// But the capability is a per-repo CONFIGURATION — trunk's stacked-PR support
// against GitHub's stacked-PR preview, both of which an org can have off — and
// when it is off the provider says so in its own comment: "GitHub considers
// this PR to be a part of a stack — … our merge queue will be unable to merge
// this PR" (parsed as `rejected` in @talyn/shared). This module is where that
// refusal is remembered, so the second stack in a repo without the feature
// takes the serial drain immediately instead of re-earning the refusal.
//
// Shaped like `repoMergeGate` / `repoQueueHealth` / `repoSigning`: a reading
// that DECAYS and re-earns itself, never a permanent verdict. A repo that
// turns the feature on must start batching on its own, with no restart in the
// recovery path — the same argument Session 77 made for the merge gate.
//
// Scoped (repo, landing branch) and NOT workspace-scoped: whether trunk batches
// stacks on `master` is a property of the repo's queue, not of who is looking
// at it — the argument `externalQueueState` and `repoQueueHealth` both make.

import { debugBus } from './debugBus.js';

/**
 * How long a refusal suppresses batching.
 *
 * Long, because the thing it records is a configuration rather than a blip:
 * re-earning it costs a pointless submission that the provider answers with a
 * refusal comment, and on a repo that genuinely has the feature off, every
 * stack would pay that. A day is short enough that turning the feature ON is
 * noticed the same day without anyone restarting the backend.
 */
export const BATCH_REFUSAL_TTL_MS = 24 * 60 * 60_000;

interface Refusal {
  /** Epoch ms the refusal was observed. */
  at: number;
  /** The provider's own sentence, for the timeline and the block reason. */
  evidence: string;
}

const refusals = new Map<string, Refusal>();

function keyOf(owner: string, repo: string, landingBranch: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}:${landingBranch}`;
}

/**
 * Record that the provider refused to merge a PR *because* it is part of a
 * stack. Called from the decision pipeline when the parsed queue state is
 * `rejected` on a PR that is a native stack member.
 *
 * Narrow on purpose: a `rejected` on an UNSTACKED PR says nothing about
 * batching (it is the provider refusing that one PR) and must never reach
 * here, or a single unrelated refusal would switch a healthy repo back to the
 * serial drain for a day.
 */
export function noteStackBatchRefused(
  owner: string,
  repo: string,
  landingBranch: string,
  evidence: string
): void {
  const key = keyOf(owner, repo, landingBranch);
  const already = refusals.get(key);
  refusals.set(key, { at: Date.now(), evidence });
  if (already && Date.now() - already.at < BATCH_REFUSAL_TTL_MS) return;
  debugBus.recordEvent({
    service: 'merge_queue',
    action: 'stack-batch:refused',
    ok: false,
    summary:
      `${owner}/${repo} (${landingBranch}) refused a stack submission — ` +
      'falling back to draining the stack one PR at a time',
    meta: { evidence },
  });
}

/**
 * Clear the refusal for a repo. Called when the provider is observed ACCEPTING
 * a stack submission, so a repo that gets the feature switched on stops paying
 * the TTL the moment it proves itself.
 */
export function noteStackBatchAccepted(owner: string, repo: string, landingBranch: string): void {
  refusals.delete(keyOf(owner, repo, landingBranch));
}

/**
 * May Talyn hand this repo's stacks to the external queue as one batch?
 *
 * Optimistic: unknown reads as YES. The downside of guessing wrong is one
 * refusal comment on one PR, which this module then remembers; the downside of
 * guessing the other way is every stack in every repo silently taking N times
 * as long as it needs to, with nothing to say why.
 */
export function stackBatchingAllowed(
  owner: string,
  repo: string,
  landingBranch: string
): boolean {
  const key = keyOf(owner, repo, landingBranch);
  const refusal = refusals.get(key);
  if (!refusal) return true;
  if (Date.now() - refusal.at >= BATCH_REFUSAL_TTL_MS) {
    refusals.delete(key);
    return true;
  }
  return false;
}

/** Test seam. */
export function _resetStackBatching(): void {
  refusals.clear();
}
