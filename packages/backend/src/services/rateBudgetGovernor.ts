import type { GitHubRateLimitResource } from './github.js';
import { githubRateGate } from './githubRateGate.js';

/**
 * Adaptive-polling governor.
 *
 * Fed the authoritative `/rate_limit` snapshot per account, it computes how much
 * to *stretch* poll cadence so we glide under the per-account budget instead of
 * slamming into it. The pollers multiply their base interval by
 * {@link delayFactor}.
 *
 * The model is deliberately cost-free — it needs no estimate of how many
 * requests a tick spends. It compares the fraction of budget *consumed* against
 * the fraction of the reset window *elapsed*: if we've burned more of the budget
 * than time has passed, we're ahead of pace and slow down proportionally. As
 * the window resets (`remaining` snaps back), the factor naturally returns to 1.
 *
 * Buckets have different reset windows (`search` is per-minute, `core`/`graphql`
 * per-hour); the most-constrained bucket wins.
 */

/** Reset-window length per bucket, in seconds. Buckets not listed are ignored. */
const WINDOW_SECONDS: Record<string, number> = {
  core: 3600,
  graphql: 3600,
  search: 60,
};

/** Fraction of each window's budget we aim to still have unspent at reset. */
const RESERVE = 0.15;

/** Hardest slowdown we'll apply — caps both the math and a fully-blocked account. */
export const MAX_FACTOR = 8;

/** Floor on spendable headroom so approaching the reserve can't divide by 0. */
const EPS = 0.01;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Slowdown factor (≥1) for a single bucket.
 *
 * The model paces *remaining budget against remaining time*, not used-vs-elapsed
 * — that distinction matters most exactly when a bucket nears empty. We track a
 * straight "safe line" for budget-left: full at the window's start, falling to
 * {@link RESERVE} at reset. While we're on or above that line, no throttle. Once
 * we dip below it we're spending too fast to make it to reset with our reserve
 * intact, so we stretch cadence by how far ahead of pace we are — and as the
 * remaining budget approaches the reserve, the spendable headroom (the divisor)
 * collapses, so a near-empty bucket pauses hard. At/below the reserve we pin to
 * {@link MAX_FACTOR}: there's effectively nothing left to spend, so stop hitting
 * it until it resets (every request would fail and risk a secondary limit).
 *
 * Exported for unit testing.
 */
export function bucketFactor(
  resource: string,
  r: GitHubRateLimitResource,
  now: number = Date.now(),
): number {
  const windowSeconds = WINDOW_SECONDS[resource];
  if (!windowSeconds) return 1;
  if (!Number.isFinite(r.limit) || r.limit <= 0) return 1;

  const secondsUntilReset = r.reset - now / 1000;
  if (secondsUntilReset <= 0) return 1; // window has reset (or stale) — no constraint

  const fractionTimeLeft = clamp(secondsUntilReset / windowSeconds, 0, 1);
  // Reconcile used vs remaining the same way the cards do: GitHub can report a
  // stale-high `remaining` just after a reset, so take the conservative read.
  const used = clamp(
    Math.max(Number.isFinite(r.used) ? r.used : 0, r.limit - r.remaining),
    0,
    r.limit,
  );
  const fractionBudgetLeft = (r.limit - used) / r.limit;

  // At or below the reserve there's nothing safe left to spend — pause hard.
  if (fractionBudgetLeft <= RESERVE) return MAX_FACTOR;

  // The safe lower bound on budget-left at this point in the window.
  const target = RESERVE + (1 - RESERVE) * fractionTimeLeft;
  if (fractionBudgetLeft >= target) return 1; // on or above the safe line

  // Behind the line: stretch by how far ahead of pace we are. `spendable` shrinks
  // toward 0 as we approach the reserve, blowing the factor up to MAX_FACTOR.
  const spendable = Math.max(fractionBudgetLeft - RESERVE, EPS);
  return clamp(fractionTimeLeft / spendable, 1, MAX_FACTOR);
}

class RateBudgetGovernor {
  /** accountKey → latest per-bucket resources from `/rate_limit`. */
  private state = new Map<string, Record<string, GitHubRateLimitResource>>();

  /** Store the latest snapshot for an account. */
  update(accountKey: string, resources: Record<string, GitHubRateLimitResource>): void {
    this.state.set(accountKey, resources);
  }

  /**
   * How much to stretch poll cadence for an account: the max factor across its
   * buckets, or {@link MAX_FACTOR} if it's currently gated by a hard backoff.
   */
  delayFactor(accountKey: string, now: number = Date.now()): number {
    if (githubRateGate.isBlocked(accountKey)) return MAX_FACTOR;
    const resources = this.state.get(accountKey);
    if (!resources) return 1;
    let factor = 1;
    for (const [resource, r] of Object.entries(resources)) {
      if (!r) continue;
      factor = Math.max(factor, bucketFactor(resource, r, now));
    }
    return factor;
  }

  /** Max factor across several accounts — used to pace a loop that spans them. */
  maxDelayFactor(accountKeys: Iterable<string>, now: number = Date.now()): number {
    let factor = 1;
    for (const key of accountKeys) factor = Math.max(factor, this.delayFactor(key, now));
    return factor;
  }

  /** Test helper — drop all stored snapshots. */
  _reset(): void {
    this.state.clear();
  }
}

export const rateBudgetGovernor = new RateBudgetGovernor();
