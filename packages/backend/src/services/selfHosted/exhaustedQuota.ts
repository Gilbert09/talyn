import type { FleetAgent } from '@talyn/shared';

/**
 * Learning, at run time, that a workspace's own subscription has nothing left.
 *
 * The fleet runs on the user's Claude or Codex subscription, and neither vendor
 * exposes "how much is left" to a server. The only place the truth appears is
 * the failure itself: the sandbox boots, the agent's FIRST API call is refused,
 * and the run dies having done nothing. So the failure is the feed — the same
 * shape as `withdrawnModels.ts` next door, learned by observation because
 * there is no endpoint to ask.
 *
 * What makes this worth acting on rather than just reporting: the work is still
 * wanted, and the workspace usually has somewhere else to run it. A Claude
 * subscription that is spent says nothing about a connected Codex one, and
 * nothing at all about PostHog Code. Failing the task outright spends the
 * user's attention on a decision the backend can make.
 *
 * # Exhausted is not rate-limited
 *
 * These are two different failures and only one of them is worth moving for.
 * A rate limit clears by waiting — the fleet reports those as `rate_limited`
 * and they are the same subscription's answer a few minutes later. An
 * exhausted quota clears only when a person buys more or a billing period
 * rolls over, and every retry against it burns another sandbox boot.
 *
 * Matching is therefore PINNED to sentences that mean "a human must act", not
 * to anything that merely mentions a limit. A looser rule would move work off
 * a subscription that was about to be fine, which on the last hop means
 * spending metered credits to avoid a twenty-minute wait.
 */

/**
 * Anthropic's own sentences, verbatim.
 *
 * `out of extra usage` is what a spent Claude subscription says (observed on a
 * live run, 2026-09-20, as a 400 `invalid_request_error`). `credit balance is
 * too low` is the Console-key equivalent for a workspace that pasted a key
 * rather than signing in. Both require somebody to go and top up.
 *
 * Deliberately NOT here: `rate_limit_error`, "usage limit reached" and the
 * five-hour window messages. Those resolve themselves.
 */
const ANTHROPIC_EXHAUSTED = [
  /out of extra usage/i,
  /credit balance is too low/i,
] as const;

/**
 * OpenAI's equivalents.
 *
 * `insufficient_quota` and "exceeded your current quota" are the documented
 * API-key strings. The ChatGPT-subscription path that Codex-on-the-fleet
 * actually uses has NOT been observed failing this way yet, so this list is
 * the weaker half of the pair: if a Codex exhaustion arrives worded some other
 * way it will be missed and the task will fail exactly as it does today.
 * That is the right way to be wrong here — a missed failover costs one run, a
 * false one moves work off a working subscription.
 */
const OPENAI_EXHAUSTED = [
  /insufficient_quota/i,
  /exceeded your current quota/i,
] as const;

/**
 * The agent whose subscription a failure says is spent, or null when the
 * failure is about anything else.
 *
 * One-sided on purpose: anything unrecognised is left alone and settles as an
 * ordinary failure.
 */
export function exhaustedAgentFrom(detail: string | null | undefined): FleetAgent | null {
  if (typeof detail !== 'string' || !detail) return null;
  if (ANTHROPIC_EXHAUSTED.some((re) => re.test(detail))) return 'claude';
  if (OPENAI_EXHAUSTED.some((re) => re.test(detail))) return 'codex';
  return null;
}

/**
 * How the task explains itself after a move. Names the vendor that ran out AND
 * where the work went, because the alternative — a run that quietly used a
 * different vendor than the one picked — is the kind of thing nobody can
 * reconstruct a week later.
 */
export function failoverSummary(from: FleetAgent, to: string): string {
  return (
    `${agentLabel(from)} usage was exhausted, so this run moved to ${to}. ` +
    `Your default agent is unchanged — a spent quota is not a preference.`
  );
}

/** What the task says when there is nowhere left to move it. */
export function exhaustedDeadEndSummary(from: FleetAgent): string {
  return (
    `${agentLabel(from)} usage is exhausted and no other provider is connected to move this ` +
    `run to. Add usage for ${agentLabel(from)}, or connect another agent or provider.`
  );
}

export function agentLabel(agent: FleetAgent): string {
  return agent === 'codex' ? 'Codex' : 'Claude';
}
