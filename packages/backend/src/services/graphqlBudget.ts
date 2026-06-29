import type { DebugGraphqlBudget } from '@fastowl/shared';

/** One observation read off GitHub's `rateLimit { … }` GraphQL field. */
export interface GraphqlBudgetObservation {
  /** Max points/hour for this account (`rateLimit.limit`). */
  limit: number;
  /** Points remaining in the current window (`rateLimit.remaining`). */
  remaining: number;
  /** ISO timestamp the window resets (`rateLimit.resetAt`). */
  resetAt: string;
  /** Point cost of the query that carried this reading (`rateLimit.cost`). */
  cost: number;
}

interface Entry extends GraphqlBudgetObservation {
  /** epoch ms this reading was recorded. */
  observedAt: number;
}

/**
 * Tracks the GitHub GraphQL points budget per rate-limit account, read off the
 * free `rateLimit { limit cost remaining resetAt }` field we add to batched
 * queries (asking for it costs 0 points). GraphQL is a per-account point bucket
 * — ≈5,000/hr, scaling to 12,500 (or 15,000 on Enterprise Cloud) — and an App
 * installation shares one bucket across every workspace on it.
 *
 * Source of truth for two consumers:
 *  - the proactive deferral: non-urgent loops (the reconcile sweep) skip an
 *    account whose budget has fallen into the reserve, so the remaining points
 *    stay available for webhook-driven refreshes, the merge queue, and
 *    user-triggered work until the window resets;
 *  - the Debug panel's GraphQL-budget readout.
 *
 * Deliberately pure (no service imports, no debug-bus dependency) so the
 * production gating never rides on the debug bus's enable flag.
 */
class GraphqlBudgetTracker {
  private byAccount = new Map<string, Entry>();

  /**
   * Pause non-urgent GraphQL for an account once its remaining points fall
   * below this floor. Leaves headroom for the work we never want to starve
   * (webhook refreshes, merge queue, manual refresh) until the window resets.
   */
  static readonly RESERVE_POINTS = 500;

  /**
   * Drop a reading once it's this old with no refresh — a disconnected or idle
   * account ages out of the panel instead of showing a frozen budget. Safely
   * longer than the window (1h) so a live account's card never flickers.
   */
  private static readonly STALE_MS = 90 * 60_000;

  /** Record the latest budget reading for an account. Ignores garbage limits. */
  record(accountKey: string, obs: GraphqlBudgetObservation, now = Date.now()): void {
    if (!Number.isFinite(obs.limit) || obs.limit <= 0) return;
    this.byAccount.set(accountKey, { ...obs, observedAt: now });
  }

  /**
   * True when an account's budget is in the reserve and the window hasn't yet
   * reset — the signal for non-urgent loops to skip this account this tick.
   * Returns false on an unknown account (never block on no data) and false once
   * the window has rolled over (points have refilled).
   */
  shouldDefer(accountKey: string, now = Date.now()): boolean {
    const e = this.byAccount.get(accountKey);
    if (!e) return false;
    if (now >= new Date(e.resetAt).getTime()) return false;
    return e.remaining < GraphqlBudgetTracker.RESERVE_POINTS;
  }

  /** Snapshot for the Debug panel — fresh entries only, with derived flags. */
  snapshot(now = Date.now()): DebugGraphqlBudget[] {
    const out: DebugGraphqlBudget[] = [];
    for (const [accountKey, e] of this.byAccount) {
      if (now - e.observedAt > GraphqlBudgetTracker.STALE_MS) {
        this.byAccount.delete(accountKey);
        continue;
      }
      const windowReset = now >= new Date(e.resetAt).getTime();
      out.push({
        accountKey,
        limit: e.limit,
        // Once the window has rolled over the bucket is full again, even though
        // our last reading predates the reset.
        remaining: windowReset ? e.limit : e.remaining,
        resetAt: e.resetAt,
        lastCost: e.cost,
        observedAt: new Date(e.observedAt).toISOString(),
        deferring: !windowReset && e.remaining < GraphqlBudgetTracker.RESERVE_POINTS,
      });
    }
    // Lowest budget first — the accounts closest to trouble lead.
    return out.sort((a, b) => a.remaining - b.remaining);
  }

  /** Test helper — drop all tracked budgets. */
  _reset(): void {
    this.byAccount.clear();
  }
}

export const graphqlBudget = new GraphqlBudgetTracker();
