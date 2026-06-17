import { sql, eq } from 'drizzle-orm';
import { getPoolDbClient } from '../db/client.js';
import { pullRequests as pullRequestsTable } from '../db/schema.js';
import { getRedis, isRedisEnabled } from './redis.js';
import { allWatchedRepoFullNames } from './webhookIndex.js';
import { debugBus } from './debugBus.js';
import { TickGuard } from './tickGuard.js';

/**
 * Redis-backed index of the head SHAs of every tracked OPEN PR, per repo.
 *
 * Purpose: let the webhook receiver drop the dominant slice of the firehose —
 * `check_run`/`check_suite` events whose commit is NOT the head of any PR we
 * track — BEFORE they're enqueued and before they cost a single DB round-trip.
 * On a monorepo like posthog/posthog the vast majority of checks run on CI
 * *merge commits*, never a PR head, so they could never update a pill count;
 * forwarding them only to no-op in `ingestCheckRun` was the bulk of the worker's
 * load (see docs + webhookWorker's check_run path).
 *
 * Why Redis, not in-process memory: the receiver and the data-plane that knows
 * PR heads may run on different replicas. The set must be shared, so the answer
 * is the same on whichever replica receives the delivery.
 *
 * ── Data model (per repo `owner/repo`, lowercased) ────────────────────────────
 *  • `wh:heads:<repo>`        SET of current open-PR head SHAs. REPLACED wholesale
 *                             on each reseed (authoritative, bounded — closed PRs'
 *                             heads drop out).
 *  • `wh:heads:recent:<repo>` SET of heads the receiver has seen on a live
 *                             `pull_request` event, short TTL. NEVER touched by
 *                             reseed. This closes the brand-new-PR race: a PR's
 *                             head is droppable-safe the instant its `opened`
 *                             event lands, even before the worker writes the row
 *                             and before the next reseed picks it up.
 *  • `wh:heads:ready:<repo>`  marker (TTL) saying "we have an authoritative view
 *                             of this repo". The filter only DROPS when this is
 *                             present; otherwise it fails OPEN (enqueues), so a
 *                             cold cache / dead reseeder / Redis hiccup never
 *                             drops real work.
 *
 * ── Edge cases, and how each is covered ───────────────────────────────────────
 *  • Brand-new PR, checks arrive before its row exists → `recent` set (receiver
 *    notes the head off the `pull_request` payload) keeps it forwarded.
 *  • Force-push (synchronize) → new head noted into `recent`; the old head ages
 *    out of `recent` and is gone from the main set at the next reseed. Late
 *    checks on the superseded SHA may slip through for one reseed window and
 *    simply no-op downstream (the PR's current head ≠ that SHA).
 *  • PR close/merge → its head leaves the main set at the next reseed; meanwhile
 *    any straggler check no-ops downstream (PR no longer `open`).
 *  • Repo with ZERO open PRs → reseed still marks it `ready` with an empty set,
 *    so ALL its check events are dropped (the ideal — nothing to update).
 *  • Repo not yet seeded / Redis down / no head SHA on payload → fail OPEN.
 *  • Two open PRs sharing a head SHA → a SET de-dupes naturally; membership means
 *    "≥1 tracked open PR has this head", which is exactly the forward condition.
 *
 * The reconcile sweep (5-min full refresh) remains the ultimate backstop, so any
 * transient miss self-heals regardless.
 */

const SET_PREFIX = 'wh:heads:';
const RECENT_PREFIX = 'wh:heads:recent:';
const READY_PREFIX = 'wh:heads:ready:';

const RESEED_INTERVAL_MS = 60_000;
// `ready` must outlive the reseed interval so a single skipped tick doesn't flip
// a healthy repo to fail-open; a dead reseeder lets it expire → fail-open.
const READY_TTL_SEC = 180;
// Main set lives a few cycles past `ready` so a brief reseed gap keeps matching.
const SET_TTL_SEC = 600;
// A freshly-opened PR head stays force-forwarded long enough to span the gap
// between its `opened` event and the reseed that folds it into the main set.
const RECENT_TTL_SEC = 180;

const setKey = (repo: string) => `${SET_PREFIX}${repo.toLowerCase()}`;
const recentKey = (repo: string) => `${RECENT_PREFIX}${repo.toLowerCase()}`;
const readyKey = (repo: string) => `${READY_PREFIX}${repo.toLowerCase()}`;
const normSha = (sha: string) => sha.trim().toLowerCase();

// One round-trip: -1 = repo not seeded (caller fails open), 1 = head is tracked
// (main or recent set), 0 = seeded and absent (caller may drop).
const LOOKUP_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then return 1 end
if redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 1 then return 1 end
return 0`;

/**
 * Should this check delivery be DROPPED at the receiver? True ONLY when we have
 * an authoritative view of the repo AND the head SHA is provably not a tracked
 * open PR's head. Fails OPEN (returns false) on anything uncertain — no head,
 * Redis disabled/erroring, or repo not yet seeded.
 */
export async function shouldDropByHeadSha(
  repoFullName: string,
  headSha: string | undefined | null,
): Promise<boolean> {
  if (!isRedisEnabled() || !headSha || !repoFullName) return false;
  const redis = getRedis();
  if (!redis) return false;
  const repo = repoFullName.toLowerCase();
  try {
    const res = (await redis.eval(
      LOOKUP_LUA,
      3,
      readyKey(repo),
      setKey(repo),
      recentKey(repo),
      normSha(headSha),
    )) as number;
    return res === 0;
  } catch {
    return false; // never drop real work on a Redis hiccup
  }
}

/**
 * Record a head SHA the receiver saw on a live `pull_request` event into the
 * short-TTL `recent` set, so checks for a just-opened/just-pushed PR are
 * forwarded immediately — before its row exists or the next reseed runs.
 * Best-effort.
 */
export async function noteHeadSha(
  repoFullName: string,
  headSha: string | undefined | null,
): Promise<void> {
  if (!isRedisEnabled() || !headSha || !repoFullName) return;
  const redis = getRedis();
  if (!redis) return;
  const key = recentKey(repoFullName);
  try {
    await redis.sadd(key, normSha(headSha));
    await redis.expire(key, RECENT_TTL_SEC);
  } catch {
    /* best-effort */
  }
}

/**
 * Replace every watched repo's head-SHA set from the DB (the source of truth),
 * and mark each repo `ready`. Runs on a short interval + once at boot. Returns a
 * small summary for the debug tile.
 *
 * Egress: selects only `owner`, `repo`, and `last_summary ->> 'headSha'` — the
 * blob never ships (matches the project's egress discipline).
 */
export async function reseedHeadShas(): Promise<{ repos: number; heads: number }> {
  if (!isRedisEnabled()) return { repos: 0, heads: 0 };
  const redis = getRedis();
  if (!redis) return { repos: 0, heads: 0 };

  const db = getPoolDbClient();
  const rows = await db
    .select({
      owner: pullRequestsTable.owner,
      repo: pullRequestsTable.repo,
      headSha: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'headSha'`,
    })
    .from(pullRequestsTable)
    .where(eq(pullRequestsTable.state, 'open'));

  const byRepo = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.headSha) continue;
    const key = `${r.owner}/${r.repo}`.toLowerCase();
    let set = byRepo.get(key);
    if (!set) {
      set = new Set();
      byRepo.set(key, set);
    }
    set.add(normSha(r.headSha));
  }

  // Include every watched repo — even those with zero open PRs — so they get a
  // `ready` marker with an empty set and ALL their check events are dropped.
  const repos = new Set<string>([
    ...allWatchedRepoFullNames().map((r) => r.toLowerCase()),
    ...byRepo.keys(),
  ]);

  const pipe = redis.multi();
  let heads = 0;
  for (const repo of repos) {
    const shas = [...(byRepo.get(repo) ?? [])];
    heads += shas.length;
    pipe.del(setKey(repo));
    if (shas.length > 0) {
      pipe.sadd(setKey(repo), ...shas);
      pipe.expire(setKey(repo), SET_TTL_SEC);
    }
    pipe.set(readyKey(repo), '1', 'EX', READY_TTL_SEC);
  }
  await pipe.exec();
  return { repos: repos.size, heads };
}

/** Background reseeder: keeps the Redis head-SHA index fresh. */
class WebhookHeadIndex {
  private timer: NodeJS.Timeout | null = null;
  private guard = new TickGuard('webhook_head_index', 5 * 60_000);

  async init(): Promise<void> {
    if (!isRedisEnabled()) return;
    debugBus.registerPoller(
      'webhook_head_index',
      RESEED_INTERVAL_MS,
      "Reseeds the Redis index of tracked open-PR head SHAs that lets the receiver drop CI checks for commits no PR head points at.",
    );
    // Prime once so the receiver has an authoritative view ASAP. Before this
    // first reseed, repos are unseeded → the filter fails open (enqueues).
    await this.tick();
    const schedule = () => {
      this.timer = setTimeout(() => {
        void this.tick().finally(schedule);
      }, RESEED_INTERVAL_MS);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    };
    schedule();
  }

  private async tick(): Promise<void> {
    if (!this.guard.tryBegin()) return;
    const startedAt = Date.now();
    let summary = 'webhook_head_index';
    let ok = true;
    let error: string | undefined;
    try {
      const { repos, heads } = await reseedHeadShas();
      summary = `webhook_head_index — ${repos} repo${repos === 1 ? '' : 's'}, ${heads} head${heads === 1 ? '' : 's'}`;
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message : String(err);
      console.error('[webhookHeadIndex] reseed failed:', error);
    } finally {
      this.guard.end();
      debugBus.pollerTick('webhook_head_index', {
        durationMs: Date.now() - startedAt,
        ok,
        error,
        summary,
      });
    }
  }

  shutdown(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export const webhookHeadIndex = new WebhookHeadIndex();
