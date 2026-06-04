import type { DebugRateLimitState } from '@fastowl/shared';
import { githubService, type GitHubRateLimit } from './github.js';
import { debugBus } from './debugBus.js';

/**
 * GitHub rate-limit poller — keeps the Debug panel's rate-limit cards honest.
 *
 * Rather than scraping `x-ratelimit-*` off whatever requests happen to fly by
 * (which made the `core` bucket look frozen — the steady poll is GraphQL- and
 * search-heavy and rarely touches `core` — and collapsed multiple accounts'
 * independent budgets into one flipping number), we poll GitHub's dedicated
 * `GET /rate_limit` endpoint on a fixed cadence. It returns EVERY resource
 * bucket at once, is authoritative, and crucially does NOT itself count against
 * any budget — so polling it is free.
 *
 * Cards are keyed by `<login> · <resource>` so each connected GitHub account
 * gets its own set (the user-scoped OAuth budget is shared across a single
 * account's workspaces, so same-account workspaces dedupe to one card set).
 */

const TICK_MS = 30_000;

// Always show these primary buckets even when idle; other resources only
// surface once they've actually been used, to keep the panel uncluttered.
const PRIMARY_RESOURCES = new Set(['core', 'graphql', 'search']);

const RESOURCE_INFO: Record<string, string> = {
  core: 'GitHub REST API — primary request budget per account (5000/hr, or 15000 for a GitHub App / Enterprise), resets hourly.',
  graphql: 'GitHub GraphQL API — point budget per account (5000 points/hr), resets hourly. A whole batched PR query usually costs ~1 point.',
  search: 'GitHub Search API — a much smaller budget (30/min authenticated). The PR poller spends this on its authored / review-requested searches.',
  code_search: 'GitHub Code Search API — a small budget (10/min).',
  integration_manifest: 'GitHub App manifest conversion budget.',
  source_import: 'Source import budget (100/min).',
  code_scanning_upload: 'Code-scanning SARIF upload budget.',
  dependency_snapshots: 'Dependency-graph snapshot submission budget (100/min).',
  audit_log: 'Audit-log API budget.',
};

/**
 * Map a `/rate_limit` payload to the debug-bus card inputs for one account.
 * Pure (no I/O) so it can be unit-tested. Skips zero-limit buckets and any
 * non-primary resource that hasn't been used yet.
 */
export function bucketsFor(
  login: string,
  rl: GitHubRateLimit,
): Array<Omit<DebugRateLimitState, 'observedAt'>> {
  const out: Array<Omit<DebugRateLimitState, 'observedAt'>> = [];
  for (const [resource, r] of Object.entries(rl.resources ?? {})) {
    if (!r || !Number.isFinite(r.limit) || r.limit <= 0) continue;
    if (!PRIMARY_RESOURCES.has(resource) && r.used <= 0) continue;
    // GitHub's `/rate_limit` snapshot can report `used` and `remaining`
    // that don't reconcile (`used + remaining != limit`) — most visibly on
    // the `graphql` bucket just after its point window resets, where
    // `remaining` snaps back to the full limit while `used` still reflects
    // the previous window. Showing both raw produces a contradictory card
    // (a 100% bar next to "2,249 used"). Reconcile to the conservative
    // reading — the larger of the two consumption signals — so the bar and
    // the used count always agree and a stale-high `remaining` can't paint a
    // falsely-full bar.
    const used = Math.min(
      r.limit,
      Math.max(0, Number.isFinite(r.used) ? r.used : 0, r.limit - r.remaining),
    );
    out.push({
      name: `${login} · ${resource}`,
      description: RESOURCE_INFO[resource] ?? `GitHub '${resource}' API budget, resets hourly.`,
      limit: r.limit,
      remaining: r.limit - used,
      used,
      resetAt: new Date(r.reset * 1000).toISOString(),
      resource,
    });
  }
  return out;
}

class RateLimitPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  init(): void {
    if (this.timer) return;
    console.log('Starting GitHub rate-limit poller...');
    debugBus.registerPoller(
      'rate_limit',
      TICK_MS,
      "Polls GitHub's GET /rate_limit (free — doesn't count against any budget) per connected account and publishes every resource bucket to the Debug panel's rate-limit cards.",
    );
    // Kick once immediately so the cards populate without waiting a full tick.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    // Dedupe by label so the same account across multiple workspaces is only
    // fetched (and carded) once per tick.
    const seenLabels = new Set<string>();
    let accounts = 0;
    let lastError: string | undefined;
    try {
      for (const workspaceId of githubService.getConnectedWorkspaces()) {
        // Resolve a card label, preferring the GitHub login so same-account
        // workspaces dedupe to one card set. Crucially, its failure must NOT
        // skip the account: getViewerLogin costs a budgeted `/user` call that
        // fails exactly when the account is rate-limited (or right after a
        // restart drops the in-memory login cache) — which is precisely when
        // these cards matter most. The `/rate_limit` fetch below is free and
        // available even when rate-limited, so we always attempt it and fall
        // back to a workspace label when the login can't be resolved.
        const login = await githubService.getViewerLogin(workspaceId).catch(() => null);
        const label = login ?? `workspace ${workspaceId.slice(0, 8)}`;
        if (seenLabels.has(label)) continue;
        try {
          const rl = await githubService.getRateLimit(workspaceId);
          for (const bucket of bucketsFor(label, rl)) debugBus.recordRateLimit(bucket);
          seenLabels.add(label);
          accounts++;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
    } finally {
      this.running = false;
      debugBus.pollerTick('rate_limit', {
        durationMs: Date.now() - startedAt,
        ok: !lastError,
        summary: `rate-limit tick — ${accounts} account${accounts === 1 ? '' : 's'}`,
        error: lastError,
      });
    }
  }
}

export const rateLimitPoller = new RateLimitPoller();
