import { eq, sql } from 'drizzle-orm';
import type { CiWakeupOutcome } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { pullRequests } from '../../db/schema.js';
import { readLedgerFacts } from '../checkCounts.js';
import { sameCommit, settledOutcome } from '../ciSettle.js';
import { workspaceHasFeature } from '../featureFlags.js';
import { WorkbenchError } from './errors.js';
import type { WorkbenchRow } from './store.js';

/**
 * Session CI wake-ups: a wake-up that waits for the checks on the session's
 * pull request instead of a guessed time.
 *
 * The row is an ordinary wake-up whose `wake_at` is the latest it fires, plus
 * the pull request and the commit it waits on. Two paths fire it sooner, both
 * in `backgroundSweep.ts`: the `pr:checks` listener, when a flush for that
 * commit settles CI, and the sweep, which also notices a moved head, a merged
 * or closed pull request, and a flush the listener missed. When `wake_at`
 * comes first, the due sweep fires it and the outcome is read at fire time.
 *
 * It is the session form of a parked fix run (`ciPark.ts`), and uses the
 * same meaning of "settled". A session needs no suspend or resume: its box
 * already sleeps when idle, and the wake-up turn wakes it.
 */

/** The facts one decision needs: the wake-up's target and its pull request now. */
export interface CiWakeupFacts {
  ciHeadSha: string;
  ciPrHeadAtSchedule: string | null;
  prState: string | null;
  prHeadSha: string | null;
  owner: string | null;
  repo: string | null;
}

export type CiWakeupDecision =
  | { kind: 'wait' }
  | { kind: 'fire'; outcome: CiWakeupOutcome }
  | { kind: 'check_ci'; repoFullName: string; headSha: string };

/**
 * What to do with one CI wake-up before the check ledger is read. Pure.
 *
 * The PR row learns of the agent's own push from a webhook, so for a while
 * its head can still be the commit before the one the wake-up waits for. A
 * head equal to the head at schedule time is that stale value, not a push.
 */
export function decideCiWakeup(row: CiWakeupFacts): CiWakeupDecision {
  if (row.prState === 'merged') return { kind: 'fire', outcome: { kind: 'merged' } };
  if (row.prState === 'closed') return { kind: 'fire', outcome: { kind: 'closed' } };
  if (row.prState !== 'open') return { kind: 'wait' };
  const stale = Boolean(row.prHeadSha && row.ciPrHeadAtSchedule && row.prHeadSha === row.ciPrHeadAtSchedule);
  if (row.prHeadSha && !stale && !sameCommit(row.prHeadSha, row.ciHeadSha)) {
    return { kind: 'fire', outcome: { kind: 'head_moved', headSha: row.prHeadSha } };
  }
  if (!row.owner || !row.repo) return { kind: 'wait' };
  return { kind: 'check_ci', repoFullName: `${row.owner}/${row.repo}`, headSha: row.ciHeadSha };
}

export interface CiOutcomeDeps {
  readFacts?: typeof readLedgerFacts;
}

/**
 * The outcome now, or null while CI runs. `final` is the fire-time read of a
 * wake-up whose time came: then a run that has not settled is `timed_out`.
 * The ledger is read first even then: a settled answer beats "go and look".
 */
export async function ciOutcomeNow(
  row: CiWakeupFacts,
  final: boolean,
  deps: CiOutcomeDeps = {},
): Promise<CiWakeupOutcome | null> {
  const decision = decideCiWakeup(row);
  if (decision.kind === 'fire') return decision.outcome;
  if (decision.kind === 'check_ci') {
    const facts = await (deps.readFacts ?? readLedgerFacts)(decision.repoFullName, decision.headSha);
    const settled = settledOutcome(facts);
    if (settled) return settled;
  }
  return final ? { kind: 'timed_out' } : null;
}

/** The pull request facts of one wake-up, read at fire time. */
export async function ciFactsFor(wakeup: {
  ciPullRequestId: string;
  ciHeadSha: string;
  ciPrHeadAtSchedule: string | null;
}): Promise<CiWakeupFacts & { number: number | null }> {
  const [pr] = await getPoolDbClient()
    .select({
      state: pullRequests.state,
      headSha: sql<string | null>`${pullRequests.lastSummary} ->> 'headSha'`,
      owner: pullRequests.owner,
      repo: pullRequests.repo,
      number: pullRequests.number,
    })
    .from(pullRequests)
    .where(eq(pullRequests.id, wakeup.ciPullRequestId))
    .limit(1);
  return {
    ciHeadSha: wakeup.ciHeadSha,
    ciPrHeadAtSchedule: wakeup.ciPrHeadAtSchedule,
    prState: pr?.state ?? null,
    prHeadSha: pr?.headSha ?? null,
    owner: pr?.owner ?? null,
    repo: pr?.repo ?? null,
    number: pr?.number ?? null,
  };
}

/** `owner/repo#123`, or plain words when the pull request is gone. */
export function prRef(facts: { owner: string | null; repo: string | null; number: number | null }): string {
  return facts.owner && facts.repo && facts.number !== null ? `${facts.owner}/${facts.repo}#${facts.number}` : 'the pull request';
}

/** The turn a CI wake-up sends. */
export function ciWakeupPrompt(input: {
  reason: string;
  createdBy: string;
  createdAt: Date;
  ref: string;
  headSha: string;
  outcome: CiWakeupOutcome;
}): string {
  const short = input.headSha.slice(0, 12);
  const { outcome, ref } = input;
  let what: string;
  switch (outcome.kind) {
    case 'passing':
      what = `CI finished on ${short} of ${ref}, and no required check failed.`;
      break;
    case 'failing':
      what = outcome.checks.length > 0
        ? `CI finished on ${short} of ${ref}. These required checks failed: ${outcome.checks.map((c) => `\`${c}\``).join(', ')}. Read their logs and fix the cause.`
        : `CI finished on ${short} of ${ref}, and some checks failed. Read the failing checks and fix the cause.`;
      break;
    case 'head_moved':
      what = `The head of ${ref} moved from ${short} to ${outcome.headSha.slice(0, 12)} before CI finished. Somebody pushed. Fetch the branch before you push again, and do not overwrite their commits. To wait for CI on the new head, schedule a new CI wake-up.`;
      break;
    case 'timed_out':
      what = `CI on ${short} of ${ref} did not finish before the wake-up's time. Read the check status yourself.`;
      break;
    case 'merged':
      what = `${ref} merged while you waited for CI.`;
      break;
    case 'closed':
      what = `${ref} closed while you waited for CI.`;
      break;
  }
  const who = input.createdBy === 'user' ? 'the person' : 'you';
  return [
    `[Talyn] CI wake-up ${who} scheduled at ${input.createdAt.toISOString()}: ${input.reason}`,
    what,
    'Continue the work, or report to the person.',
  ].join('\n');
}

/** A full commit id: SHA-1 (40) or SHA-256 (64) hex. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export interface CiTarget {
  ciPullRequestId: string;
  ciHeadSha: string;
  ciPrHeadAtSchedule: string | null;
}

/**
 * Check that a session can wait for CI, and name what it waits on: the
 * session's linked, open pull request, at the commit given or else its head.
 */
export async function resolveCiTarget(row: WorkbenchRow, headSha: unknown): Promise<CiTarget> {
  if (!(await workspaceHasFeature('sessionCiWait', row.workspaceId)).enabled) {
    throw new WorkbenchError('Waiting for CI is not available in this workspace. Schedule a timed wake-up instead.', 403, 'ci_wait_unavailable');
  }
  let given: string | null = null;
  if (headSha !== undefined && headSha !== null && headSha !== '') {
    if (typeof headSha !== 'string' || !FULL_SHA.test(headSha.trim())) {
      throw new WorkbenchError('headSha must be a full commit id. Get it with `git rev-parse HEAD`.', 400, 'bad_request');
    }
    given = headSha.trim().toLowerCase();
  }
  if (!row.pullRequestId) {
    throw new WorkbenchError('This session has no pull request, so there is no CI to wait for. Open the pull request first.', 409, 'no_pull_request');
  }
  const facts = await ciFactsFor({ ciPullRequestId: row.pullRequestId, ciHeadSha: given ?? '', ciPrHeadAtSchedule: null });
  if (facts.prState !== 'open') {
    throw new WorkbenchError(`The session's pull request is ${facts.prState ?? 'gone'}, so there is no CI to wait for.`, 409, 'pull_request_not_open');
  }
  const target = given ?? facts.prHeadSha;
  if (!target) {
    throw new WorkbenchError('Talyn does not know the head of the pull request yet. Give headSha.', 409, 'no_head_sha');
  }
  return { ciPullRequestId: row.pullRequestId, ciHeadSha: target, ciPrHeadAtSchedule: facts.prHeadSha };
}
