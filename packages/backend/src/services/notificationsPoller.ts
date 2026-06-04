import { githubService } from './github.js';
import { prMonitorService } from './prMonitor.js';
import { debugBus } from './debugBus.js';

/**
 * GitHub Notifications poller — the low-latency live channel.
 *
 * `GET /notifications` is the authenticated user's activity feed: comments,
 * reviews, review-requests, CI completions, state changes — scoped to threads
 * they participate in, which is exactly our authored / review-requested PRs.
 * It needs no repo admin (unlike webhooks) and is designed for polling
 * (conditional requests give free 304s; X-Poll-Interval sets the cadence).
 *
 * We use each notification as a *trigger* — "PR #N had activity, refetch it
 * now" — and hand off to `prMonitorService.refreshPr`, which reuses the same
 * GraphQL + upsert pipeline as the poll loop (so it emits pull_request:updated
 * and ingests inbox deltas). Conflicts are NOT signalled by notifications, so
 * the baseline poll remains the conflict catcher + reliability backstop.
 */

// We wake on a short base tick but only actually hit GitHub per the workspace's
// own next-due time (X-Poll-Interval, floored at 60 s).
const BASE_TICK_MS = 30_000;
const MIN_POLL_INTERVAL_MS = 60_000;

interface WorkspaceState {
  /** Opaque Last-Modified header for the conditional request. */
  lastModified: string | null;
  /** ISO cursor bounding the payload to recently-updated threads. */
  since: string | null;
  /** Earliest time we're allowed to poll this workspace again. */
  nextPollAt: number;
}

class NotificationsPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private states = new Map<string, WorkspaceState>();

  init(): void {
    if (this.timer) return;
    console.log('Starting GitHub notifications poller...');
    debugBus.registerPoller('notifications', BASE_TICK_MS);
    this.timer = setInterval(() => void this.tick(), BASE_TICK_MS);
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
    let polled = 0;
    try {
      const now = Date.now();
      for (const workspaceId of githubService.getConnectedWorkspaces()) {
        const state = this.states.get(workspaceId);
        if (state && state.nextPollAt > now) continue;
        polled++;
        await this.pollWorkspace(workspaceId).catch((err) => {
          const msg = err instanceof Error ? err.message : 'unknown error';
          console.error(`notifications: workspace ${workspaceId.slice(0, 8)} failed:`, msg);
        });
      }
    } finally {
      this.running = false;
      debugBus.pollerTick('notifications', {
        durationMs: Date.now() - startedAt,
        ok: true,
        summary: `notifications tick — ${polled} workspace${polled === 1 ? '' : 's'} due`,
      });
    }
  }

  private async pollWorkspace(workspaceId: string): Promise<void> {
    const prev = this.states.get(workspaceId);
    // Bound the next payload to threads updated since just before this fetch,
    // so we don't miss activity that lands mid-request.
    const startedAt = new Date().toISOString();
    const res = await githubService.listNotifications(workspaceId, {
      since: prev?.since ?? undefined,
      ifModifiedSince: prev?.lastModified ?? undefined,
    });
    const interval = Math.max((res.pollInterval ?? 60) * 1000, MIN_POLL_INTERVAL_MS);
    const nextPollAt = Date.now() + interval;

    if (res.status === 304) {
      // Nothing changed — keep the cursor, just back off until next due.
      this.states.set(workspaceId, {
        lastModified: res.lastModified ?? prev?.lastModified ?? null,
        since: prev?.since ?? null,
        nextPollAt,
      });
      return;
    }

    const watched = new Set(
      (await prMonitorService.getWatchedRepos(workspaceId)).map((r) => r.fullName.toLowerCase())
    );
    for (const n of res.notifications) {
      if (n.subject?.type !== 'PullRequest') continue;
      const fullName = n.repository?.full_name;
      if (!fullName || !watched.has(fullName.toLowerCase())) continue;
      const number = parsePrNumber(n.subject.url);
      if (number === null) continue;
      const [owner, repo] = fullName.split('/');
      await prMonitorService.refreshPr(workspaceId, owner, repo, number).catch(() => {});
    }

    this.states.set(workspaceId, {
      lastModified: res.lastModified ?? null,
      since: startedAt,
      nextPollAt,
    });
  }

  /** Test/admin entry point — poll one workspace now, ignoring next-due. */
  async forcePollWorkspace(workspaceId: string): Promise<void> {
    await this.pollWorkspace(workspaceId);
  }

  /** Test helper — drop all per-workspace cursor state. */
  _reset(): void {
    this.states.clear();
  }
}

/** Pull the PR number out of a notification subject API URL (…/pulls/123). */
export function parsePrNumber(url: string | null): number | null {
  if (!url) return null;
  const m = /\/pulls\/(\d+)(?:$|[?#])/.exec(url);
  return m ? Number.parseInt(m[1], 10) : null;
}

export const notificationsPoller = new NotificationsPoller();
