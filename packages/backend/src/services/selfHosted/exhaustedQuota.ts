import type { FleetAgent } from '@talyn/shared';
import {
  readSelfHostedConfig,
  patchSelfHostedConfig,
  type ExhaustedQuotaRecord,
} from './credentials.js';
import { verifyAgentQuota } from './quotaProbe.js';
import { debugBus } from '../debugBus.js';

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

/**
 * How the task explains a move the vendor would NOT confirm.
 *
 * Deliberately not {@link failoverSummary}: that one tells the user their
 * subscription is spent and to go and top it up, which on 2026-09-21 was false
 * for every run for a day — the credential answered a probe at the same minute
 * it was refusing runs. Saying so plainly is the point. The work still moved,
 * because it is still wanted and the other agent can do it, but nobody should
 * be sent to a billing page over it.
 */
export function unconfirmedRefusalSummary(from: FleetAgent, to: string): string {
  return (
    `${agentLabel(from)} refused this run, but the same credential answered a check moments ` +
    `later — so this is not a spent subscription. The run moved to ${to} while that is looked ` +
    `into; your ${agentLabel(from)} usage was not held back.`
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

// ---------------------------------------------------------------------------
// When it comes back, and remembering until then
// ---------------------------------------------------------------------------

/**
 * The instant the vendor said the quota returns, or null when it did not say.
 *
 * NEVER invents one. A guessed reset is worse than no reset: it is stored, it
 * is believed, and it silently keeps work off a subscription that came back
 * hours ago. The caller treats null as "we do not know" and re-probes on the
 * vendor's published cadence instead — see {@link probeAfter}.
 *
 * Three shapes, because the sentence reaches us through the fleet's own error
 * string and may be prose, a JSON field, or an HTTP hint:
 *   - `resetsAt` / `resets_at` as epoch seconds or an ISO instant
 *   - `retry-after: <seconds>` / `try again in <n> seconds`
 *   - an epoch in `unified-reset`, which is the header Anthropic sends
 */
export function resetInstantFrom(
  detail: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (typeof detail !== 'string' || !detail) return null;

  const iso = /"?resets?_?At"?\s*[:=]\s*"([0-9T:\-+.Z]{10,})"/i.exec(detail)?.[1];
  if (iso) {
    const at = new Date(iso);
    if (!Number.isNaN(at.getTime())) return at.toISOString();
  }

  const epoch =
    /"?(?:resets?_?At|unified[-_]reset)"?\s*[:=]\s*"?(\d{9,13})"?/i.exec(detail)?.[1];
  if (epoch) {
    // Seconds or milliseconds — 13 digits is milliseconds, 10 is seconds.
    const n = Number(epoch);
    const ms = epoch.length > 11 ? n : n * 1000;
    const at = new Date(ms);
    if (!Number.isNaN(at.getTime())) return at.toISOString();
  }

  const after = /(?:retry[-\s]?after|try again in)\D{0,12}?(\d{1,7})\s*(second|minute|hour)?/i.exec(
    detail,
  );
  if (after) {
    const n = Number(after[1]);
    const unit = (after[2] ?? 'second').toLowerCase();
    const ms = n * (unit.startsWith('hour') ? 3_600_000 : unit.startsWith('minute') ? 60_000 : 1000);
    if (ms > 0) return new Date(now.getTime() + ms).toISOString();
  }

  return null;
}

/**
 * How long to hold a spent agent back before trying it again.
 *
 * # What this number is for, which is not what it used to be for
 *
 * It exists to collapse a BURST into one discovery. A webhook fan-out, a
 * merge-queue pass or a loop firing several tasks can dispatch many runs in
 * the same few seconds, and without a hold each one boots its own microVM to
 * be told the same thing. That is the whole cost being avoided, and a burst is
 * over in minutes.
 *
 * It is NOT an estimate of when the quota returns. It used to be five hours,
 * on the reasoning that both vendors meter consumer subscriptions on a rolling
 * five-hour window. The word doing the damage there is ROLLING: such a window
 * frees capacity continuously as old usage ages out, so a subscription refused
 * at 08:00 can be perfectly usable at 08:20. Observed on 2026-09-21 — Claude
 * reported "out of extra usage" at 08:00:33, the quota was back well before
 * the 13:00 probe, and a 10:00 loop ran on Codex having never asked Claude.
 *
 * # Why minutes rather than hours
 *
 * The two ways of being wrong are not remotely symmetric, and the old number
 * optimised the cheap one:
 *
 *   - Too short costs ONE extra microVM boot per dispatch. The fleet is our
 *     own hardware, so that is seconds of CPU and no metered spend at all.
 *   - Too long runs the user's work on a vendor they did not choose, silently,
 *     for hours — and on a subscription product the vendor IS the choice.
 *
 * So the hold buys back the burst and nothing more. A still-spent quota simply
 * re-arms it on the next refusal, which is the same one-boot cost again.
 */
const PROBE_AFTER_MS = 5 * 60 * 1000;

/**
 * When a record stops holding its agent back: the EARLIER of our own probe and
 * whatever instant the vendor named.
 *
 * `resetsAt` can now only ever shorten the hold. It used to win outright, but
 * a vendor naming a later instant is describing a FULL window reset, which on
 * a rolling limit is pessimistic for exactly the reason above — capacity comes
 * back before the window formally rolls. We would rather spend a boot finding
 * that out than sit out the difference.
 */
export function probeAfter(record: { at: string; resetsAt?: string }): number {
  const observed = new Date(record.at).getTime();
  const ours = Number.isNaN(observed) ? 0 : observed + PROBE_AFTER_MS;
  if (!record.resetsAt) return ours;
  const vendor = new Date(record.resetsAt).getTime();
  return Number.isNaN(vendor) ? ours : Math.min(ours, vendor);
}

/** Whether this record still holds its agent back at `now`. */
export function isHeldBack(
  record: { at: string; resetsAt?: string } | undefined,
  now: Date = new Date(),
): boolean {
  return record ? now.getTime() < probeAfter(record) : false;
}

/**
 * How the hold reads on a refusal.
 *
 * Names {@link probeAfter}, not `resetsAt`. It used to quote the vendor's
 * instant, which since that stopped deciding the hold would have been a time
 * the agent was NOT waiting for — and a refusal that names the wrong moment is
 * worse than one that names none.
 */
export function heldBackReason(agent: FleetAgent, record: { at: string; resetsAt?: string }): string {
  const retry = new Date(probeAfter(record)).toISOString();
  return `${agentLabel(agent)} usage is exhausted; retrying it after ${retry}.`;
}

// ---------------------------------------------------------------------------
// The durable record
// ---------------------------------------------------------------------------

/**
 * Remember that `agent` is spent for this workspace — once the vendor has
 * CONFIRMED it.
 *
 * Stored on the fleet integration row, not in memory: the in-memory version
 * dies at the next deploy, which for this repo is every push to main, and a
 * loop firing hourly would then re-discover the same exhaustion all day.
 *
 * # Why the sentence is no longer enough on its own
 *
 * This used to write the hold straight from the words the failed run came back
 * with, and on 2026-09-21 those words were false about the account they named.
 * Anthropic refused every fleet run with "You're out of extra usage. Add more
 * at claude.ai/settings/usage" while the same stored credential answered 200
 * (`unified-status: allowed`) to a one-token request — from a laptop, from the
 * fleet host, and through the fleet harness's own request builder. Something
 * in the sandbox path is turning a good subscription request into a refusal;
 * until that is found, believing the sentence costs a day of somebody's work
 * running on a vendor they did not choose, plus a notification telling them to
 * go and buy usage they already have.
 *
 * So the vendor is ASKED (`verifyAgentQuota`) before the hold is written, and
 * `available` means no hold and no failover. `unknown` — an unreachable
 * vendor, a credential we cannot read, an unrecognised refusal, or any agent
 * the probe cannot speak for — still writes it: being unsure must not be more
 * decisive than being told, in either direction.
 *
 * Returns whether the agent is actually being held back, so the caller can
 * decide whether moving the work is warranted at all.
 *
 * Best-effort by construction — this runs on the failure path of a run that
 * has already died, and throwing here would replace a useful error with a
 * useless one.
 */
export async function noteExhaustedAgent(
  workspaceId: string,
  agent: FleetAgent,
  detail: string | null,
): Promise<boolean> {
  const verdict = await verifyAgentQuota(workspaceId, agent).catch(() => 'unknown' as const);
  if (verdict === 'available') {
    console.warn(
      `[exhaustedQuota] ${workspaceId}: a run reported ${agentLabel(agent)} usage exhausted, ` +
        'but the vendor served a probe on the same credential — not holding the agent back. ' +
        `Run's words: ${(detail ?? '').slice(0, 200)}`,
    );
    debugBus.recordEvent({
      service: 'fleet',
      action: 'quota_exhaustion_unconfirmed',
      summary:
        `${agentLabel(agent)} reported exhausted by a run, but the vendor answered a probe — ` +
        'no hold written',
      workspaceId,
      ok: false,
    });
    return false;
  }
  try {
    const config = await readSelfHostedConfig(workspaceId);
    const record: ExhaustedQuotaRecord = {
      at: new Date().toISOString(),
      ...(resetInstantFrom(detail) ? { resetsAt: resetInstantFrom(detail)! } : {}),
      ...(detail ? { detail: detail.slice(0, 500) } : {}),
    };
    await patchSelfHostedConfig(workspaceId, {
      quotaExhausted: { ...(config?.quotaExhausted ?? {}), [agent]: record },
    });
  } catch (err) {
    console.error(`[exhaustedQuota] could not record ${agent} exhaustion:`, err);
  }
  return true;
}

/**
 * Forget that `agent` was spent — it just ran something successfully, or the
 * user reconnected it.
 *
 * The success path matters as much as the failure one. Without it a hold set
 * at 09:00 keeps its agent out until the probe window elapses even though the
 * 09:05 probe proved it was back, which is the failure mode of every cache
 * that only ever learns bad news.
 */
export async function clearExhaustedAgent(
  workspaceId: string,
  agent: FleetAgent,
): Promise<void> {
  try {
    const config = await readSelfHostedConfig(workspaceId);
    const held = config?.quotaExhausted;
    if (!held?.[agent]) return;
    const next = { ...held };
    delete next[agent];
    await patchSelfHostedConfig(workspaceId, {
      // `undefined` DELETES the key in patchSelfHostedConfig, which is what an
      // empty map should become — a row carrying `quotaExhausted: {}` reads as
      // a workspace that has a hold recorded, just an empty one.
      quotaExhausted: Object.keys(next).length ? next : undefined,
    });
  } catch (err) {
    console.error(`[exhaustedQuota] could not clear ${agent} exhaustion:`, err);
  }
}

/**
 * Which of this workspace's fleet agents are currently held back, and why.
 *
 * A record whose probe window has elapsed is NOT returned — the next dispatch
 * should try that agent again. The stale row is left on disk rather than
 * cleaned up here: this is read on the dispatch path, and a read that writes
 * turns every dispatch into a write.
 */
export async function heldBackAgents(
  workspaceId: string,
  now: Date = new Date(),
): Promise<Partial<Record<FleetAgent, ExhaustedQuotaRecord>>> {
  const config = await readSelfHostedConfig(workspaceId).catch(() => null);
  const held = config?.quotaExhausted ?? {};
  const out: Partial<Record<FleetAgent, ExhaustedQuotaRecord>> = {};
  for (const agent of ['claude', 'codex'] as FleetAgent[]) {
    const record = held[agent];
    if (record && isHeldBack(record, now)) out[agent] = record;
  }
  return out;
}
