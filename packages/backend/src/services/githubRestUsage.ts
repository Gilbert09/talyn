/**
 * Which REST endpoints spend an account's `core` budget.
 *
 * GitHub tells us how much of the budget is left, never what spent it. On
 * 2026-10-22 one user's budget ran dry at about 4,500 calls an hour and nothing
 * in the logs said which loop was making them: the Debug panel had the detail,
 * in memory, for one replica, for the last few hundred events. This counts every
 * REST call per account by endpoint SHAPE and logs the top shapes for any
 * account on pace to spend half its budget, so the answer is in the logs the
 * next time.
 *
 * No timer: the window closes on the first call after it has run its length,
 * so an idle backend logs nothing and a busy one reports about every window.
 */

/** How long one counting window runs before it is reported and reset. */
export const REST_USAGE_WINDOW_MS = 5 * 60_000;

/**
 * Report an account once its pace reaches this many calls an hour: a fifth of
 * the 5,000 an hour GitHub gives a user. Other tools spend the same budget (the
 * `gh` CLI, local agents), so Talyn's share can drain it while it stays well
 * under half. At 2,500 this never logged on 2026-10-22 while the account spent
 * about 2,700 an hour.
 */
export const REST_USAGE_REPORT_PER_HOUR = 1_000;

/** Endpoint shapes named in one report line; the rest are summed. */
const SHAPES_PER_LINE = 10;

/**
 * The shape of a REST endpoint, so one loop's calls across many PRs count as
 * one line: the query is dropped, the owner and repo after `/repos/` become
 * `:owner/:repo`, numbers become `:n`, and commit SHAs become `:sha`.
 */
export function endpointShape(method: string, endpoint: string): string {
  const path = endpoint.split('?')[0] ?? '';
  const segments = path.split('/');
  const out = segments.map((segment, i) => {
    if (segments[i - 1] === 'repos') return ':owner';
    if (segments[i - 2] === 'repos') return ':repo';
    if (/^\d+$/.test(segment)) return ':n';
    if (/^[0-9a-f]{40}$/i.test(segment)) return ':sha';
    return segment;
  });
  return `${method.toUpperCase()} ${out.join('/')}`;
}

export class RestUsageCounter {
  private windowStart: number;
  private counts = new Map<string, Map<string, number>>();

  constructor(
    now: number = Date.now(),
    private readonly windowMs: number = REST_USAGE_WINDOW_MS,
    private readonly reportPerHour: number = REST_USAGE_REPORT_PER_HOUR
  ) {
    this.windowStart = now;
  }

  /**
   * Count one call. Returns the report lines for the window it closed, if this
   * call closed one (the call itself counts in the NEW window).
   */
  record(accountKey: string, shape: string, now: number = Date.now()): string[] {
    const lines = now - this.windowStart >= this.windowMs ? this.close(now) : [];
    const byShape = this.counts.get(accountKey) ?? new Map<string, number>();
    byShape.set(shape, (byShape.get(shape) ?? 0) + 1);
    this.counts.set(accountKey, byShape);
    return lines;
  }

  private close(now: number): string[] {
    const elapsed = now - this.windowStart;
    const lines: string[] = [];
    for (const [account, byShape] of this.counts) {
      const total = [...byShape.values()].reduce((a, b) => a + b, 0);
      const perHour = Math.round((total * 3_600_000) / elapsed);
      if (perHour < this.reportPerHour) continue;
      lines.push(describeUsage(account, byShape, total, perHour, elapsed));
    }
    this.counts.clear();
    this.windowStart = now;
    return lines;
  }
}

export function describeUsage(
  account: string,
  byShape: Map<string, number>,
  total: number,
  perHour: number,
  elapsedMs: number
): string {
  const ranked = [...byShape].sort((a, b) => b[1] - a[1]);
  const named = ranked.slice(0, SHAPES_PER_LINE).map(([shape, n]) => `${shape} ${n}`);
  const rest = ranked.slice(SHAPES_PER_LINE).reduce((n, [, c]) => n + c, 0);
  if (rest > 0) named.push(`${ranked.length - SHAPES_PER_LINE} other shapes ${rest}`);
  return (
    `[github-rest] ${account}: ~${perHour}/h (${total} calls in ${(elapsedMs / 60_000).toFixed(1)} min): ` +
    named.join(', ')
  );
}

export const githubRestUsage = new RestUsageCounter();
