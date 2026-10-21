import {
  CODE_REVIEW_ACTIVE_PHASES,
  fleetAgentForModel,
  type CodeReviewPhase,
  type FleetAgent,
} from '@talyn/shared';
import { FLEET_HOP, nextHop } from '../cloudProviders/quotaFailover.js';
import {
  accountIdsFromHops,
  chooseFleetAccount,
  fleetAccountHop,
} from '../selfHosted/accountSelection.js';
import {
  agentLabel,
  exhaustedAgentFrom,
  noteExhaustedAgent,
  rateLimitedAgentFrom,
} from '../selfHosted/exhaustedQuota.js';
import { captureUnitFailedOver } from './analytics.js';
import {
  appendReviewEvent,
  getReview,
  requeueRun,
  runsForCycle,
  settleRun,
  type RunFailureCode,
  type RunRow,
} from './store.js';

/**
 * What a review unit does when its fleet run failed.
 *
 * - The same agent's next ACCOUNT is tried first: one that is not over the
 *   workspace's threshold and that no unit of this cycle hit a limit on. Such a
 *   move is recorded as `fleet:<agent>:<accountId>` in `failed_over_from`, so
 *   it does not mark the whole agent limited.
 *
 * The task path has this already (`selfHosted/poller.ts` `finalize` and
 * `quotaFailover.ts`). A review unit is not a `tasks` row and cannot use that
 * code, but it follows the same rules:
 *
 * - A rate limit moves ONE hop, to the workspace's other fleet agent, and
 *   writes no hold.
 * - An exhausted subscription is checked with the vendor and held for the
 *   workspace (`noteExhaustedAgent`), then moves the same one hop.
 * - Neither ever moves to PostHog Code. That provider accepts no spend cap, and
 *   a review is several units.
 *
 * A unit moves at most once. `failed_over_from` on its row records the move,
 * and a row that has it set settles on its next failure.
 */

export type LimitReason = Extract<RunFailureCode, 'usage_limit' | 'quota_exhausted'>;

export function isLimitReason(code: string | null | undefined): code is LimitReason {
  return code === 'usage_limit' || code === 'quota_exhausted';
}

function isFleetAgent(value: string | null | undefined): value is FleetAgent {
  return value === 'claude' || value === 'codex';
}

/**
 * The stored failure sentence, cut to 500 characters.
 *
 * The same cap `exhaustedQuota.ts` puts on the detail it stores. This is an
 * error sentence, not a log: it rides on every read of the unit's row, and the
 * vendor's reason is always in the first lines.
 */
export function capFailureDetail(detail: string | null | undefined): string | null {
  const text = typeof detail === 'string' ? detail.trim() : '';
  return text ? text.slice(0, 500) : null;
}

export interface FleetFailure {
  /** Null when the failure is not a vendor limit. */
  reason: LimitReason | null;
  /** The agent that was limited. Null exactly when `reason` is. */
  agent: FleetAgent | null;
}

/**
 * Whether a failed run died of a vendor limit, and on which agent.
 *
 * The agent comes from the MODEL the unit ran, not from the words. The text
 * detector answers "claude" for any sentence that names no vendor, and a wrong
 * name is not harmless: the unit would count Claude as tried and run again on
 * the agent that is limited. The model is what chose the vendor, so when the
 * two disagree the model is right. The words decide only WHETHER this is a
 * limit.
 */
export function classifyFleetFailure(
  detail: string | null,
  model: string | null | undefined
): FleetFailure {
  const exhausted = exhaustedAgentFrom(detail);
  const limited = exhausted ? null : rateLimitedAgentFrom(detail);
  const named = exhausted ?? limited;
  if (!named) return { reason: null, agent: null };
  return {
    reason: exhausted ? 'quota_exhausted' : 'usage_limit',
    agent: model ? fleetAgentForModel(model) : named,
  };
}

/**
 * The fleet agents this cycle already knows are limited, and why.
 *
 * Read from the cycle's own run rows, never from memory: a deploy would lose a
 * memory map, and the next unit would boot a microVM on the limited agent to
 * learn the same thing. Two facts name an agent. A unit that settled failed
 * with a limit code names the agent of the model it ran. A unit that moved
 * names the agent it moved from.
 */
export function limitedAgentsInCycle(runs: readonly RunRow[]): Map<FleetAgent, LimitReason> {
  const limited = new Map<FleetAgent, LimitReason>();
  for (const run of runs) {
    const reason = isLimitReason(run.failureCode) ? run.failureCode : null;
    const ran = run.provider === 'selfhosted' && run.model ? fleetAgentForModel(run.model) : null;
    if (isFleetAgent(run.failedOverFrom) && !limited.has(run.failedOverFrom)) {
      // The row's failure code is about the agent of the model on the row. It
      // describes the agent the unit moved FROM only until the second dispatch
      // writes a new model. After that the first reason is gone, and a rate
      // limit is the weaker claim, so it is the default.
      limited.set(
        run.failedOverFrom,
        reason && ran === run.failedOverFrom ? reason : 'usage_limit'
      );
    }
    if (run.status === 'failed' && reason && ran) limited.set(ran, reason);
  }
  return limited;
}

/** The account a `fleet:<agent>:<accountId>` move came from, or null for an agent move. */
export function movedFromAccount(failedOverFrom: string | null | undefined): string | null {
  return failedOverFrom ? (accountIdsFromHops([failedOverFrom])[0] ?? null) : null;
}

/**
 * The fleet ACCOUNTS this cycle knows are limited: a unit that settled failed
 * with a limit code on a recorded account, and an account a unit moved away from.
 */
export function limitedAccountsInCycle(runs: readonly RunRow[]): Set<string> {
  const accounts = new Set<string>();
  for (const run of runs) {
    const movedFrom = movedFromAccount(run.failedOverFrom);
    if (movedFrom) accounts.add(movedFrom);
    if (run.status === 'failed' && isLimitReason(run.failureCode) && run.fleetAccountId) {
      accounts.add(run.fleetAccountId);
    }
  }
  return accounts;
}

/**
 * The agents a new unit of this cycle must avoid, once account-level knowledge
 * is counted: an agent still limited by `limitedAgentsInCycle`, unless every
 * limit seen on it was on a known account and it has another account that is
 * free. A limit with no account recorded keeps the whole agent avoided.
 */
export async function limitedAgentsAfterAccounts(
  workspaceId: string,
  runs: readonly RunRow[]
): Promise<Map<FleetAgent, LimitReason>> {
  const limited = limitedAgentsInCycle(runs);
  if (limited.size === 0) return limited;
  const accounts = limitedAccountsInCycle(runs);
  for (const agent of [...limited.keys()]) {
    const unknownAccount = runs.some((run) => {
      if (run.provider !== 'selfhosted' || !run.model) return false;
      if (fleetAgentForModel(run.model) !== agent) return false;
      const limitFailure = run.status === 'failed' && isLimitReason(run.failureCode);
      return limitFailure && !run.fleetAccountId;
    }) || runs.some((run) => run.failedOverFrom === agent);
    if (unknownAccount) continue;
    const free = await chooseFleetAccount(workspaceId, agent, {
      avoidAccountIds: [...accounts],
    }).catch(() => null);
    if (free) limited.delete(agent);
  }
  return limited;
}

/**
 * The workspace's other fleet agent, when a unit may move to it.
 *
 * `nextHop` is the task path's own rule: connected, not waiting for a
 * reconnect, not held for the workspace. `fleetOnly` stops it before the
 * metered providers.
 */
export async function eligibleFleetAgent(
  workspaceId: string,
  exclude: Iterable<FleetAgent>,
  avoidAccountIds: Iterable<string> = []
): Promise<FleetAgent | null> {
  const tried = new Set<string>([...exclude].map(FLEET_HOP));
  // Placeholder agent: only the account id is read back from the hop.
  for (const id of avoidAccountIds) tried.add(fleetAccountHop('claude', id));
  const hop = await nextHop(workspaceId, tried, { fleetOnly: true }).catch(() => null);
  return hop?.kind === 'fleet' ? hop.agent : null;
}

/** The timeline line for a move to another account of the same agent. */
export function accountFailoverMessage(agent: FleetAgent, toLabel: string, reason: LimitReason): string {
  return reason === 'quota_exhausted'
    ? `One ${agentLabel(agent)} account's usage is exhausted, so this reviewer moved to ${toLabel}.`
    : `One ${agentLabel(agent)} account reported a usage limit, so this reviewer moved to ${toLabel}.`;
}

/** The timeline line for a move. */
export function failoverMessage(from: FleetAgent, to: FleetAgent, reason: LimitReason): string {
  return reason === 'quota_exhausted'
    ? `${agentLabel(from)} usage is exhausted, so this reviewer moved to ${agentLabel(to)}.`
    : `${agentLabel(from)} reported a usage limit, so this reviewer moved to ${agentLabel(to)}.`;
}

function stoppedMessage(agent: FleetAgent, reason: LimitReason): string {
  return reason === 'quota_exhausted'
    ? `${agentLabel(agent)} usage is exhausted, so this reviewer stopped.`
    : `${agentLabel(agent)} reported a usage limit, so this reviewer stopped.`;
}

/**
 * Settle a fleet unit whose run FAILED, or move it to the other agent.
 *
 * Returns 'moved' when the unit waits for a second dispatch, and 'settled'
 * when it is finished. The caller schedules the review's evaluation in both
 * cases: a move needs a dispatch, and a settle may end the phase.
 */
export async function settleFailedFleetUnit(
  run: RunRow,
  input: { detail: string | null | undefined; fallbackCode: RunFailureCode }
): Promise<'moved' | 'settled'> {
  const detail = capFailureDetail(input.detail);
  const review = await getReview(run.reviewId);
  const phase = (review?.phase ?? 'reviewing') as CodeReviewPhase;
  const failure = classifyFleetFailure(detail, run.model);

  if (!failure.reason || !failure.agent) {
    await settleRun(run.id, {
      status: 'failed',
      failureCode: input.fallbackCode,
      failureDetail: detail,
    });
    await appendReviewEvent(run.reviewId, {
      toPhase: phase,
      trigger: 'poller',
      code: input.fallbackCode,
      message: 'One reviewer could not finish its run.',
      detail: { kind: run.kind, lens: run.lens, failureDetail: detail },
    });
    return 'settled';
  }

  const agent = failure.agent;
  let reason = failure.reason;
  if (reason === 'quota_exhausted') {
    // The same call the task path makes. It asks the vendor, and writes the
    // workspace hold only when the vendor agrees. A rate limit writes no hold:
    // the subscription is fine and works again without anybody acting.
    // With the account known, only that account is held.
    const confirmed = await noteExhaustedAgent(
      run.workspaceId,
      agent,
      detail,
      run.fleetAccountId ?? undefined
    );
    // The vendor served a probe on this credential, so the subscription is not
    // spent. The unit still moves, but it must not tell anyone to add usage.
    if (!confirmed) reason = 'usage_limit';
  }

  // Only a unit of the cycle the review is still running may move. A requeued
  // unit of a finished cycle has nothing to dispatch it.
  const live =
    review !== null &&
    review.cycle === run.cycle &&
    CODE_REVIEW_ACTIVE_PHASES.includes(review.phase as CodeReviewPhase);

  let target: FleetAgent | null = null;
  if (live && !run.failedOverFrom) {
    const cycleRuns = await runsForCycle(run.reviewId, run.cycle);
    const limitedAccounts = limitedAccountsInCycle(cycleRuns);

    // The same agent's next account first. Only with the failed account known:
    // without it the next choice could be the same account again.
    if (run.fleetAccountId) {
      limitedAccounts.add(run.fleetAccountId);
      const sameAgent = await chooseFleetAccount(run.workspaceId, agent, {
        ...(run.model ? { model: run.model } : {}),
        avoidAccountIds: [...limitedAccounts],
      }).catch(() => null);
      if (
        sameAgent &&
        (await requeueRun(run.id, {
          failedOverFrom: fleetAccountHop(agent, run.fleetAccountId),
          failureCode: reason,
          failureDetail: detail,
        }))
      ) {
        await appendReviewEvent(run.reviewId, {
          toPhase: phase,
          trigger: 'poller',
          code: 'unit_failed_over',
          message: accountFailoverMessage(agent, sameAgent.label, reason),
          detail: {
            kind: run.kind,
            lens: run.lens,
            from: agent,
            to: agent,
            fromAccountId: run.fleetAccountId,
            toAccountId: sameAgent.id,
            reason,
          },
        });
        captureUnitFailedOver(run.workspaceId, {
          from_agent: agent,
          to_agent: agent,
          reason,
          kind: run.kind,
          lens: run.lens,
          cycle: run.cycle,
          at: 'failure',
        });
        return 'moved';
      }
    }

    // Every agent this cycle knows is limited is excluded, not only the one
    // that just failed. A unit must not move onto an agent another unit has
    // just been refused by.
    const limited = limitedAgentsInCycle(cycleRuns);
    limited.set(agent, reason);
    target = await eligibleFleetAgent(run.workspaceId, limited.keys(), limitedAccounts);
  }

  if (
    target &&
    (await requeueRun(run.id, { failedOverFrom: agent, failureCode: reason, failureDetail: detail }))
  ) {
    await appendReviewEvent(run.reviewId, {
      toPhase: phase,
      trigger: 'poller',
      code: 'unit_failed_over',
      message: failoverMessage(agent, target, reason),
      detail: { kind: run.kind, lens: run.lens, from: agent, to: target, reason },
    });
    captureUnitFailedOver(run.workspaceId, {
      from_agent: agent,
      to_agent: target,
      reason,
      kind: run.kind,
      lens: run.lens,
      cycle: run.cycle,
      at: 'failure',
    });
    return 'moved';
  }

  await settleRun(run.id, { status: 'failed', failureCode: reason, failureDetail: detail });
  await appendReviewEvent(run.reviewId, {
    toPhase: phase,
    trigger: 'poller',
    code: reason,
    message: stoppedMessage(agent, reason),
    detail: { kind: run.kind, lens: run.lens, agent, failureDetail: detail },
  });
  return 'settled';
}
