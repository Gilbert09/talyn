import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  DEVELOPER_ACTIVITY_CATEGORIES,
  type ApiResponse,
  type DebugEvent,
  type DeveloperActivity,
  type DeveloperActivityCategory,
  type DeveloperActivityEvent,
  type DeveloperAgent,
  type DeveloperAgents,
  type DeveloperRateLimitBucket,
  type DeveloperRateLimits,
  type FleetAgent,
} from '@talyn/shared';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { debugBus } from '../services/debugBus.js';
import {
  GitHubNotConnectedError,
  githubService,
  type GitHubRateLimit,
} from '../services/github.js';
import { githubRateGate } from '../services/githubRateGate.js';
import { graphqlBudget } from '../services/graphqlBudget.js';
import { workspaceMayUseFleet } from '../services/cloudProviders/fleetAccess.js';
import { fleetAgentStatus } from '../services/selfHosted/credentials.js';
import { heldBackAgents, probeAfter } from '../services/selfHosted/exhaustedQuota.js';

/**
 * Settings → Developer: an account's OWN internals.
 *
 * The Debug panel left the product because it showed every account's activity.
 * This router is the per-account replacement, so the rule for every handler is
 * the same: the account comes from `req.user.id` and from nowhere else. No
 * route reads an `owner` or `userId` parameter. A `workspaceId` must pass
 * `requireWorkspaceAccess`, which 404s a workspace the caller does not own.
 *
 * There is no WebSocket stream. The tab polls these routes.
 */

/** Buckets shown to a person, in display order. `code_search` is not on every account. */
const BUCKET_ORDER = ['core', 'search', 'graphql', 'code_search'] as const;

/**
 * How long one GitHub `/rate_limit` answer is reused per workspace.
 *
 * The tab polls every 10 seconds and a person can have several tabs or both
 * apps open. Ten seconds makes all of them share one GitHub call per poll
 * interval, and the numbers on screen are never older than one interval.
 */
export const RATE_LIMIT_CACHE_MS = 10_000;

const rateLimitCache = new Map<
  string,
  { expiresAt: number; fetchedAt: string; result: Promise<GitHubRateLimit> }
>();

/** Test helper: drop the cached GitHub answers. */
export function _resetDeveloperCaches(): void {
  rateLimitCache.clear();
}

async function cachedRateLimit(
  workspaceId: string
): Promise<{ rateLimit: GitHubRateLimit; fetchedAt: string }> {
  const now = Date.now();
  // Expired entries leave here, so the map holds only workspaces polled in
  // the last ten seconds.
  for (const [key, entry] of rateLimitCache) {
    if (entry.expiresAt <= now) rateLimitCache.delete(key);
  }
  let entry = rateLimitCache.get(workspaceId);
  if (!entry) {
    const created = {
      expiresAt: now + RATE_LIMIT_CACHE_MS,
      fetchedAt: new Date(now).toISOString(),
      result: githubService.getRateLimit(workspaceId),
    };
    entry = created;
    rateLimitCache.set(workspaceId, created);
    // A failure must not answer the next poll. Only this entry is removed, in
    // case a newer one has replaced it.
    created.result.catch(() => {
      if (rateLimitCache.get(workspaceId) === created) rateLimitCache.delete(workspaceId);
    });
  }
  return { rateLimit: await entry.result, fetchedAt: entry.fetchedAt };
}

export function toBuckets(rateLimit: GitHubRateLimit): DeveloperRateLimitBucket[] {
  const out: DeveloperRateLimitBucket[] = [];
  for (const resource of BUCKET_ORDER) {
    const r = rateLimit.resources?.[resource];
    if (!r) continue;
    out.push({
      resource,
      limit: r.limit,
      remaining: r.remaining,
      used: r.used,
      resetAt: new Date(r.reset * 1000).toISOString(),
    });
  }
  return out;
}

const USER_CATEGORIES: ReadonlySet<string> = new Set(DEVELOPER_ACTIVITY_CATEGORIES);

/**
 * The `meta` keys a user may read.
 *
 * `meta` is free-form at every recording site, so the user surface names what
 * it passes on and drops the rest. Each key below was read at its call sites:
 * all of them describe the caller's own request, workflow or queue entry.
 * Not listed on purpose: `workspaceId`, `accountKey`, `fingerprint`,
 * `replacedFingerprint` and `login` (identifiers of an account or a
 * credential), and internal row ids (`entryId`, `workflowId`, `runId`).
 */
const META_KEYS: ReadonlySet<string> = new Set([
  'status',
  'bytes',
  'error',
  'event',
  'actions',
  'attempts',
  'code',
  'state',
  'via',
  'label',
  'command',
  'headSha',
  'reason',
  'problems',
]);

function isPrimitive(v: unknown): v is string | number | boolean | null {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

/** Primitives, lists of primitives, and lists of flat records. Nothing deeper. */
function safeMetaValue(v: unknown): unknown {
  if (isPrimitive(v)) return v;
  if (!Array.isArray(v)) return undefined;
  const items: unknown[] = [];
  for (const item of v) {
    if (isPrimitive(item)) {
      items.push(item);
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const flat: Record<string, unknown> = {};
      for (const [k, value] of Object.entries(item)) {
        if (isPrimitive(value)) flat[k] = value;
      }
      items.push(flat);
    }
  }
  return items;
}

/**
 * A debug event as its own account may read it. Built field by field, so a
 * field added to `DebugEvent` later does not reach users by default.
 * `ownerId` and `ownerLabel` never leave.
 */
export function toUserDebugEvent(event: DebugEvent): DeveloperActivityEvent {
  let meta: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(event.meta ?? {})) {
    if (!META_KEYS.has(key)) continue;
    const safe = safeMetaValue(value);
    if (safe === undefined) continue;
    (meta ??= {})[key] = safe;
  }
  return {
    id: event.id,
    timestamp: event.timestamp,
    category: event.category as DeveloperActivityCategory,
    service: event.service,
    action: event.action,
    ok: event.ok,
    summary: event.summary,
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(meta ? { meta } : {}),
  };
}

/**
 * The caller's events in the allowlisted categories, oldest first.
 *
 * The comparison is a plain `===` on the owner id. It does not go through
 * `matchesOwnerFilter`, whose `all` and `system` values widen the match. An
 * event with no owner is backend-internal and is never returned.
 */
export function eventsForUser(userId: string): DebugEvent[] {
  if (!userId) return [];
  return debugBus
    .getEvents()
    .filter((e) => e.ownerId === userId && USER_CATEGORIES.has(e.category));
}

/** The default page: enough rows to fill the list without a second request. */
const DEFAULT_ACTIVITY_LIMIT = 200;

async function gateWorkspace(req: Request, res: Response): Promise<string | null> {
  const workspaceId = req.query.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId) {
    res.status(400).json({ success: false, error: 'workspaceId is required' });
    return null;
  }
  try {
    await requireWorkspaceAccess(req, workspaceId);
  } catch (err) {
    handleAccessError(err, res);
    return null;
  }
  return workspaceId;
}

const iso = (ms: number): string | null => (ms > 0 ? new Date(ms).toISOString() : null);

export function developerRoutes(): Router {
  const router = Router();

  router.get('/rate-limits', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;

    const disconnected: DeveloperRateLimits = {
      connected: false,
      login: null,
      scopes: [],
      github: [],
      graphqlBudget: null,
      secondaryGate: { restUntil: null, graphqlUntil: null },
      fetchedAt: null,
    };
    const status = githubService.getConnectionStatus(workspaceId);
    if (!status.connected) {
      return res.json({ success: true, data: disconnected } as ApiResponse<DeveloperRateLimits>);
    }

    let fetched: { rateLimit: GitHubRateLimit; fetchedAt: string };
    try {
      fetched = await cachedRateLimit(workspaceId);
    } catch (err) {
      if (err instanceof GitHubNotConnectedError) {
        return res.json({ success: true, data: disconnected } as ApiResponse<DeveloperRateLimits>);
      }
      return res.status(502).json({
        success: false,
        error: err instanceof Error ? err.message : 'GitHub did not answer',
      });
    }

    // The key GitHub traffic for this workspace is tracked under. The key
    // itself stays here: it can be a token digest.
    const accountKey = githubService.accountKeyFor(workspaceId);
    const budget = graphqlBudget.snapshot().find((b) => b.accountKey === accountKey);
    const data: DeveloperRateLimits = {
      connected: true,
      login: githubService.cachedViewerLogin(workspaceId),
      scopes: status.scopes ?? [],
      github: toBuckets(fetched.rateLimit),
      graphqlBudget: budget
        ? {
            limit: budget.limit,
            remaining: budget.remaining,
            resetAt: budget.resetAt,
            lastCost: budget.lastCost,
            observedAt: budget.observedAt,
            deferring: budget.deferring,
          }
        : null,
      secondaryGate: {
        restUntil: iso(githubRateGate.blockedUntil(accountKey, 'rest')),
        graphqlUntil: iso(githubRateGate.blockedUntil(accountKey, 'graphql')),
      },
      fetchedAt: fetched.fetchedAt,
    };
    res.json({ success: true, data } as ApiResponse<DeveloperRateLimits>);
  });

  router.get('/activity', (req, res) => {
    const userId = assertUser(req).id;
    // An unknown or missing category means every allowlisted one. It never
    // means every category.
    const raw = req.query.category;
    const category =
      typeof raw === 'string' && USER_CATEGORIES.has(raw)
        ? (raw as DeveloperActivityCategory)
        : undefined;
    const limitRaw = Number(req.query.limit);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_ACTIVITY_LIMIT;

    let events = eventsForUser(userId);
    if (category === 'error') {
      // Every failure, whatever its category. The bus files only failed
      // webhooks and poll ticks under `error` itself, so matching the category
      // alone would hide a failed request from the Errors filter.
      events = events.filter((e) => !e.ok);
    } else if (category) {
      events = events.filter((e) => e.category === category);
    }
    const page = events.slice(-limit).reverse().map(toUserDebugEvent);

    const byService: Record<string, number> = {};
    let failed = 0;
    for (const e of page) {
      byService[e.service] = (byService[e.service] ?? 0) + 1;
      if (!e.ok) failed += 1;
    }
    const data: DeveloperActivity = {
      events: page,
      counts: { total: page.length, failed, byService },
      buffer: debugBus.bufferInfo(),
    };
    res.json({ success: true, data } as ApiResponse<DeveloperActivity>);
  });

  router.get('/agents', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    // The same gate `GET /cloud-providers` applies before it lists fleet agents.
    if (!(await workspaceMayUseFleet(workspaceId))) {
      return res.json({ success: true, data: { agents: [] } } as ApiResponse<DeveloperAgents>);
    }
    // Both readers return presence and timestamps. Neither returns a key, a
    // token or any encrypted field.
    const [status, held] = await Promise.all([
      fleetAgentStatus(workspaceId),
      heldBackAgents(workspaceId),
    ]);
    const agents: DeveloperAgent[] = status.connectedAgents.map((agent: FleetAgent) => {
      // A rejected sign-in comes first: a reconnect is the only fix, and a
      // usage hold on a dead grant is no longer the useful fact.
      if (status.reauthAgents.includes(agent)) return { agent, state: 'reauth' };
      const record = held[agent];
      if (!record) return { agent, state: 'ready' };
      return {
        agent,
        state: 'held',
        hold: {
          heldSince: record.at,
          retryAfter: new Date(probeAfter(record)).toISOString(),
          detail: record.detail ?? null,
        },
      };
    });
    res.json({ success: true, data: { agents } } as ApiResponse<DeveloperAgents>);
  });

  return router;
}
