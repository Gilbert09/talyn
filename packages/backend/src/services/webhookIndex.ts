import { and, eq, inArray, ne } from 'drizzle-orm';
import { getPoolDbClient } from '../db/client.js';
import { repositories as repositoriesTable, pullRequests as pullRequestsTable } from '../db/schema.js';
import { githubService, GitHubAuthorizationUnavailableError } from './github.js';

/**
 * In-memory map: a repo's `owner/repo` full-name → every watching workspace.
 *
 * One webhook delivery for `posthog/posthog` must fan out to EVERY workspace
 * watching that repo (the same repo can be tracked across workspaces/owners),
 * and the receiver needs an O(1) "does anyone care about this repo?" check on
 * the hot path. Both read this index. It's refreshed on a short interval and on
 * demand (after a repo is added/removed), so a freshly-watched repo starts
 * matching within a tick — and a delivery for an untracked repo is dropped
 * cheaply at the receiver.
 *
 * AUTHORIZATION IS PART OF THE BUILD, not part of a delivery. That placement is
 * the whole performance story of this file, so it is worth stating plainly.
 *
 * Watching a repo is not permission to read it: the `repositories` row survives
 * a user losing access, so every recipient has to be re-checked against GitHub.
 * That check used to run per delivery, per candidate workspace — and
 * `canAccessRepository` caches its DECISION but re-reads the credential from
 * `integrations` every call, deliberately (github.ts `resolveAuth`). With 17
 * workspaces watching PostHog/posthog and its check firehose arriving at
 * 8-20/s, that was ~136 credential reads a second, and the webhook queue ran 56
 * minutes behind — far enough behind that Redis was trimming deliveries off the
 * back of the stream.
 *
 * Doing it here instead costs the same work once per REFRESH_INTERVAL_MS across
 * all repos, and it is not a weaker guarantee — it is a stronger one. The
 * decision cache in `canAccessRepository` has a 60s TTL, so asking per delivery
 * never bought per-delivery freshness anyway; it bought a credential read. This
 * index rebuilds every 30s, so a revoked workspace now drops out of the fan-out
 * SOONER than it did before, for none of the cost.
 */

export interface WatchTarget {
  workspaceId: string;
  repositoryId: string;
  owner: string;
  repo: string;
}

const REFRESH_INTERVAL_MS = 30_000;

/**
 * How many authorization checks may be in flight while rebuilding.
 *
 * Each is a `canAccessRepository` — a cached decision over a fresh credential
 * read, so the uncached ones cost a GitHub round trip. Bounded because a
 * rebuild covers every watched repo at once and an unbounded fan-out here would
 * be the same stampede this file exists to remove, just moved.
 */
const AUTH_CONCURRENCY = 8;

interface RepoEntry {
  /** Everyone whose `repositories` row names this repo. */
  candidates: WatchTarget[];
  /** Of those, the ones GitHub confirmed at build time. */
  authorized: WatchTarget[];
  /** How many could not be asked — a credential outage, not a refusal. */
  unavailable: number;
}

let index = new Map<string, RepoEntry>();
let lastBuiltAt = 0;
let building: Promise<void> | null = null;

/** Same parse as prMonitor.getWatchedRepos — owner/repo out of the stored URL. */
function parseFullName(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com[/:]([\w-]+)\/([\w.-]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
}

/** Run `task` over `items`, at most `limit` at a time, in order-independent fashion. */
async function mapBounded<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

async function build(): Promise<void> {
  const db = getPoolDbClient();
  const rows = await db
    .select({
      id: repositoriesTable.id,
      workspaceId: repositoriesTable.workspaceId,
      url: repositoriesTable.url,
    })
    .from(repositoriesTable);

  const next = new Map<string, RepoEntry>();
  for (const row of rows) {
    const parsed = parseFullName(row.url);
    if (!parsed) continue;
    const key = `${parsed.owner}/${parsed.repo}`.toLowerCase();
    const entry = next.get(key) ?? { candidates: [], authorized: [], unavailable: 0 };
    entry.candidates.push({
      workspaceId: row.workspaceId,
      repositoryId: row.id,
      owner: parsed.owner,
      repo: parsed.repo,
    });
    next.set(key, entry);
  }

  // Historical task creation allowed cross-workspace PR links. Repo-ID-based
  // writes must not reach them. ONE probe for every watched repo, rather than
  // the same join re-run per delivery with a different id list.
  const allRepositoryIds = rows.map((r) => r.id);
  const blocked = new Set<string>();
  if (allRepositoryIds.length > 0) {
    const malformed = await db
      .selectDistinct({ id: repositoriesTable.id })
      .from(repositoriesTable)
      .innerJoin(pullRequestsTable, eq(pullRequestsTable.repositoryId, repositoriesTable.id))
      .where(and(
        inArray(repositoriesTable.id, allRepositoryIds),
        ne(pullRequestsTable.workspaceId, repositoriesTable.workspaceId),
      ));
    for (const row of malformed) blocked.add(row.id);
  }

  const entries = [...next.values()];
  await mapBounded(entries, AUTH_CONCURRENCY, async (entry) => {
    for (const target of entry.candidates) {
      if (blocked.has(target.repositoryId)) continue;
      try {
        if (await githubService.canAccessRepository(target.workspaceId, target.owner, target.repo)) {
          entry.authorized.push(target);
        }
      } catch (err) {
        if (!(err instanceof GitHubAuthorizationUnavailableError)) throw err;
        // A credential outage is not a refusal. Counted so `targetsForRepo` can
        // tell "nobody may see this" from "nobody could be asked".
        entry.unavailable += 1;
      }
    }
  });

  index = next;
  lastBuiltAt = Date.now();
}

/**
 * Ensure the index is fresh, WITHOUT making a delivery wait for it.
 *
 * Stale-while-revalidate, and deliberately so: the index is a 30-second view by
 * construction, so blocking a delivery on a rebuild trades real latency for
 * freshness the caller was never promised. Only the very first build blocks,
 * because there is nothing to serve until it finishes.
 *
 * A failed rebuild leaves the previous index in place and does NOT advance
 * `lastBuiltAt`, so the next call tries again; `building` keeps that from
 * becoming a retry storm.
 */
async function ensureFresh(): Promise<void> {
  const stale = Date.now() - lastBuiltAt >= REFRESH_INTERVAL_MS || lastBuiltAt === 0;
  if (!stale) return;
  if (!building) {
    building = build()
      .catch((err: unknown) => {
        console.error('[webhooks] index rebuild failed — serving the previous view:', err);
      })
      .finally(() => {
        building = null;
      });
  }
  if (lastBuiltAt === 0) await building;
}

/** Synchronous membership check for the hot receiver path (may be slightly stale). */
export function isRepoWatchedSync(fullName: string): boolean {
  return index.has(fullName.toLowerCase());
}

/**
 * Every watched repo's `owner/repo` full name (lowercased). Used by the
 * head-SHA reseeder to mark even zero-open-PR repos as authoritatively known.
 *
 * Deliberately every WATCHED repo, not every authorized one: the reseeder is
 * answering "is this repo one we know about", which is not a permission
 * question and must not change when one workspace's credential lapses.
 */
export function allWatchedRepoFullNames(): string[] {
  return [...index.keys()];
}

/** Force a rebuild now (called after a repo is added/removed or on install events). */
export async function refreshWebhookIndex(): Promise<void> {
  await build();
}

/**
 * Every workspace that may receive this repo's deliveries, already authorized.
 *
 * One workspace that cannot answer must not silence the others. A workspace
 * whose credential was merely unavailable at build time is SKIPPED while the
 * authorized ones proceed; the delivery is only parked for a retry when NO
 * workspace could be authorized and at least one of them failed to answer.
 * The all-or-nothing version turned a single revoked authorization into a
 * stalled webhook lane for every workspace watching the same repository.
 */
export async function targetsForRepo(fullName: string): Promise<WatchTarget[]> {
  await ensureFresh();
  const entry = index.get(fullName.toLowerCase());
  if (!entry) return [];
  // Every answer was a non-answer: keep the delivery rather than drop it.
  if (entry.authorized.length === 0 && entry.unavailable > 0) {
    throw new GitHubAuthorizationUnavailableError();
  }
  return entry.authorized;
}

/** Prime the index at boot. */
export async function initWebhookIndex(): Promise<void> {
  await build();
}

/** Test helper. */
export function _resetWebhookIndex(): void {
  index = new Map();
  lastBuiltAt = 0;
  building = null;
}
