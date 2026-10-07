import { fleetAgentForModel, type FleetAgent } from '@talyn/shared';
import { fleetAgentStatus } from '../selfHosted/credentials.js';
import { agentLabel, resetInstantFrom } from '../selfHosted/exhaustedQuota.js';
import { runsForCycle, type ReviewRow, type RunRow } from './store.js';
import { isLimitReason, type LimitReason } from './unitFailover.js';

/**
 * What a cycle says when a vendor's usage limit stopped its reviewers.
 *
 * `decide` produces the cycle's failure message and stays pure, so it cannot
 * know which agents the workspace has connected. It names the CAUSE with a
 * code, and this module writes the sentence, because the useful advice depends
 * on the other agent: connect it, reconnect it, or wait.
 */

export interface LimitedAgentFact {
  agent: FleetAgent;
  reason: LimitReason;
  /** The instant the vendor named, or null. Never a guess. */
  resetsAt: Date | null;
}

const OTHER: Record<FleetAgent, FleetAgent> = { claude: 'codex', codex: 'claude' };

/**
 * A wait as a person says it: "about 5 days".
 *
 * Minutes below one hour, hours below two days, days after that. Each unit is
 * used while its count is still a number somebody can plan with.
 */
export function aboutDuration(ms: number): string {
  const plural = (n: number, unit: string) => `about ${n} ${unit}${n === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return plural(hours, 'hour');
  return plural(Math.round(ms / 86_400_000), 'day');
}

function cause(fact: LimitedAgentFact): string {
  return fact.reason === 'quota_exhausted'
    ? `${agentLabel(fact.agent)} usage is exhausted`
    : `${agentLabel(fact.agent)} reported a usage limit`;
}

/** The sentence. Pure, so every combination can be asserted without a database. */
export function usageLimitCycleMessage(input: {
  limited: LimitedAgentFact[];
  connectedAgents: FleetAgent[];
  reauthAgents: FleetAgent[];
  now: Date;
}): string {
  const { limited, now } = input;
  const first = limited[0];
  if (!first) return 'A usage limit stopped every reviewer. Try again later.';

  // The earliest instant any limited agent comes back: the review can run as
  // soon as one of them does. Only an instant the vendor named, and only while
  // it is still ahead.
  const resets = limited
    .map((f) => f.resetsAt?.getTime() ?? NaN)
    .filter((t) => Number.isFinite(t) && t > now.getTime());
  const wait = resets.length ? aboutDuration(Math.min(...resets) - now.getTime()) : null;

  // Adding usage only helps a spent subscription. A rate limit ends without it.
  const spent = limited.filter((f) => f.reason === 'quota_exhausted');
  const topUp = spent.length ? `add usage for ${spent.map((f) => agentLabel(f.agent)).join(' or ')}` : null;
  const retry = wait ? `try again in ${wait}` : 'try again later';
  const sentence = (parts: (string | null)[]) => {
    const kept = parts.filter((p): p is string => Boolean(p));
    const text =
      kept.length > 2
        ? `${kept.slice(0, -1).join(', ')}, or ${kept[kept.length - 1]}`
        : kept.join(', or ');
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
  };

  const second = limited[1];
  if (second) {
    const both =
      first.reason === 'usage_limit' && second.reason === 'usage_limit'
        ? `${agentLabel(first.agent)} and ${agentLabel(second.agent)} both reported a usage limit`
        : `${cause(first)} and ${cause(second)}`;
    return `${both}. ${sentence([topUp, retry])}`;
  }

  const other = OTHER[first.agent];
  if (!input.connectedAgents.includes(other)) {
    return (
      `${cause(first)} and no other agent is connected to run the review. ` +
      sentence([topUp, retry, `connect ${agentLabel(other)}`])
    );
  }
  if (input.reauthAgents.includes(other)) {
    return (
      `${cause(first)} and ${agentLabel(other)} needs to be reconnected. ` +
      sentence([topUp, retry, `reconnect ${agentLabel(other)} in Settings`])
    );
  }
  return (
    `${cause(first)} and ${agentLabel(other)} could not take the review. ` +
    sentence([topUp, retry])
  );
}

/**
 * Which agents a cycle's failed units say were limited.
 *
 * The agent is the one the unit's model ran. The reset instant is read from
 * the unit's stored detail, counted from when the unit settled: the vendor says
 * "in 7194 min", and that was true then, not now.
 */
export function limitedAgentFacts(runs: readonly RunRow[]): LimitedAgentFact[] {
  const facts = new Map<FleetAgent, LimitedAgentFact>();
  for (const run of runs) {
    if (run.status !== 'failed' || !isLimitReason(run.failureCode) || !run.model) continue;
    const agent = fleetAgentForModel(run.model);
    const iso = resetInstantFrom(run.failureDetail, run.settledAt ?? new Date());
    const fact: LimitedAgentFact = {
      agent,
      reason: run.failureCode,
      resetsAt: iso ? new Date(iso) : null,
    };
    const known = facts.get(agent);
    // The first unit to name an agent decides. A later one only adds a reset
    // instant the first did not carry.
    if (!known) facts.set(agent, fact);
    else if (!known.resetsAt && fact.resetsAt) known.resetsAt = fact.resetsAt;
  }
  return [...facts.values()];
}

const GENERIC = 'No reviewer finished, so there is nothing to show yet.';

/**
 * The message a failing cycle stores.
 *
 * Returns `fallback` unchanged for every code but three, and reads nothing for
 * them. For a limit code it writes the full sentence. For the generic
 * `no_reviewer_finished` it adds the limit sentence only when a limit stopped
 * more than half of the failed units, because a minority cause is not the
 * reason the review failed.
 */
export async function cycleFailureMessage(
  review: ReviewRow,
  code: string,
  fallback: string,
  now: Date = new Date()
): Promise<string> {
  if (!isLimitReason(code) && code !== 'no_reviewer_finished') return fallback;
  try {
    const failed = (await runsForCycle(review.id, review.cycle)).filter(
      (r) => r.status === 'failed'
    );
    const limited = limitedAgentFacts(failed);
    if (!limited.length) return fallback;
    const stopped = failed.filter((r) => isLimitReason(r.failureCode)).length;
    if (!isLimitReason(code) && stopped * 2 <= failed.length) return fallback;

    const status = await fleetAgentStatus(review.workspaceId);
    const message = usageLimitCycleMessage({ limited, ...status, now });
    return isLimitReason(code) ? message : `${GENERIC} ${message}`;
  } catch (err) {
    console.warn(`[code-review] could not write the failure message for ${review.id}:`, err);
    return fallback;
  }
}
