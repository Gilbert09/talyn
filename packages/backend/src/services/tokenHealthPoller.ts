import { githubService, type TokenHealthCheck } from './github.js';
import { debugBus } from './debugBus.js';
import { TickGuard } from './tickGuard.js';

/**
 * GitHub token health poller — forensic instrumentation for the
 * disappearing-token investigation.
 *
 * Every tick it asks GitHub's app-authenticated check-token endpoint
 * (`POST /applications/{client_id}/token` — free, no user budget) whether each
 * stored token is still valid. The regular pollers only notice a revoked token
 * when a budgeted call happens to 401, which on a wedged or idle loop can lag
 * the actual revocation by hours — exactly the ambiguity that made the
 * Jun 8/10/11 incidents hard to autopsy. This pins the death to one tick.
 *
 * It also surfaces what GitHub knows about each token on first sighting:
 * the owning login (which GitHub account a workspace is actually connected
 * to) and any scheduled `expires_at` (would prove the OAuth app has token
 * expiration enabled). Pure observer — removal stays with the 401 path.
 */

const TICK_MS = 5 * 60_000;

export interface TrackerAction {
  level: 'log' | 'error';
  summary: string;
  action: 'token:health-first-check' | 'token:health-died';
  meta: Record<string, unknown>;
}

/**
 * Decides what a sequence of health checks is worth saying. Pure (no I/O):
 * first sighting of a fingerprint logs its GitHub-side identity once; a
 * valid→invalid transition logs loudly. Steady states stay quiet.
 */
export class TokenHealthTracker {
  private lastValid: Map<string, boolean> = new Map();

  observe(check: TokenHealthCheck, now: Date): TrackerAction | null {
    const key = `${check.workspaceId}:${check.fingerprint}`;
    const prior = this.lastValid.get(key);
    this.lastValid.set(key, check.valid);

    const ageMs = now.getTime() - new Date(check.storedCreatedAt).getTime();
    const age = Number.isFinite(ageMs) ? `${Math.round(ageMs / 3_600_000 * 10) / 10}h` : '?';

    if (prior === undefined && check.valid) {
      return {
        level: 'log',
        action: 'token:health-first-check',
        summary:
          `[github] workspace ${check.workspaceId}: token fp:${check.fingerprint} healthy — ` +
          `login=${check.login ?? 'unknown'} expires_at=${check.expiresAt ?? 'never'} ` +
          `github_created_at=${check.githubCreatedAt ?? 'unknown'} (stored ${age} ago)`,
        meta: {
          workspaceId: check.workspaceId,
          fingerprint: check.fingerprint,
          login: check.login ?? null,
          expiresAt: check.expiresAt ?? null,
        },
      };
    }
    if (!check.valid && prior !== false) {
      return {
        level: 'error',
        action: 'token:health-died',
        summary:
          `[github] workspace ${check.workspaceId}: token fp:${check.fingerprint} REVOKED ` +
          `per check-token (age ${age}, died within the last ${Math.round(TICK_MS / 60_000)}m` +
          `${prior === undefined ? ', already dead at first check' : ''})`,
        meta: {
          workspaceId: check.workspaceId,
          fingerprint: check.fingerprint,
          tokenAge: age,
          deadAtFirstCheck: prior === undefined,
        },
      };
    }
    return null;
  }
}

class TokenHealthPoller {
  private timer: NodeJS.Timeout | null = null;
  private guard = new TickGuard('tokenHealthPoller');
  private tracker = new TokenHealthTracker();

  init(): void {
    if (this.timer) return;
    console.log('Starting GitHub token health poller...');
    debugBus.registerPoller(
      'token_health',
      TICK_MS,
      "Checks each stored GitHub token against GitHub's app-authenticated check-token endpoint (free) so a server-side revocation is pinned to a 5-minute window instead of whenever a budgeted call next 401s.",
    );
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
    if (!this.guard.tryBegin()) return;
    const startedAt = Date.now();
    let checked = 0;
    let lastError: string | undefined;
    try {
      for (const workspaceId of githubService.getConnectedWorkspaces()) {
        try {
          const check = await githubService.checkTokenHealth(workspaceId);
          if (!check) continue;
          checked++;
          const act = this.tracker.observe(check, new Date());
          if (!act) continue;
          (act.level === 'error' ? console.error : console.log)(act.summary);
          debugBus.recordEvent({
            service: 'github',
            action: act.action,
            summary: act.summary,
            ok: act.level !== 'error',
            meta: act.meta,
          });
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
    } finally {
      this.guard.end();
      debugBus.pollerTick('token_health', {
        durationMs: Date.now() - startedAt,
        ok: !lastError,
        summary: `token health tick — ${checked} token${checked === 1 ? '' : 's'} checked`,
        error: lastError,
      });
    }
  }
}

export const tokenHealthPoller = new TokenHealthPoller();
