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
 */

export interface WatchTarget {
  workspaceId: string;
  repositoryId: string;
  owner: string;
  repo: string;
}

const REFRESH_INTERVAL_MS = 30_000;

let index = new Map<string, WatchTarget[]>();
let lastBuiltAt = 0;
let building: Promise<void> | null = null;

/** Same parse as prMonitor.getWatchedRepos — owner/repo out of the stored URL. */
function parseFullName(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com[/:]([\w-]+)\/([\w.-]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
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

  const next = new Map<string, WatchTarget[]>();
  for (const row of rows) {
    const parsed = parseFullName(row.url);
    if (!parsed) continue;
    const key = `${parsed.owner}/${parsed.repo}`.toLowerCase();
    const list = next.get(key) ?? [];
    list.push({
      workspaceId: row.workspaceId,
      repositoryId: row.id,
      owner: parsed.owner,
      repo: parsed.repo,
    });
    next.set(key, list);
  }
  index = next;
  lastBuiltAt = Date.now();
}

/** Ensure the index is fresh (rebuild if older than the refresh interval). */
async function ensureFresh(): Promise<void> {
  if (Date.now() - lastBuiltAt < REFRESH_INTERVAL_MS && lastBuiltAt > 0) return;
  if (!building) {
    building = build().finally(() => {
      building = null;
    });
  }
  await building;
}

/** Synchronous membership check for the hot receiver path (may be slightly stale). */
export function isRepoWatchedSync(fullName: string): boolean {
  return index.has(fullName.toLowerCase());
}

/**
 * Every watched repo's `owner/repo` full name (lowercased). Used by the
 * head-SHA reseeder to mark even zero-open-PR repos as authoritatively known.
 */
export function allWatchedRepoFullNames(): string[] {
  return [...index.keys()];
}

/** Force a rebuild now (called after a repo is added/removed or on install events). */
export async function refreshWebhookIndex(): Promise<void> {
  await build();
}

/**
 * Check each recipient now, including historical records and delayed check flushes.
 *
 * One workspace that cannot answer must not silence the others. A workspace
 * whose credential is merely unavailable is SKIPPED for this delivery while the
 * authorized ones proceed; the delivery is only parked for a retry when NO
 * workspace could be authorized and at least one of them failed to answer.
 * The all-or-nothing version turned a single revoked authorization into a
 * stalled webhook lane for every workspace watching the same repository.
 */
export async function targetsForRepo(fullName: string): Promise<WatchTarget[]> {
  let candidates: WatchTarget[];
  let blocked: Set<string>;
  try {
    await ensureFresh();
    candidates = index.get(fullName.toLowerCase()) ?? [];
    if (candidates.length === 0) return [];
    // Historical task creation allowed cross-workspace PR links. Repo-ID-based writes must not reach them.
    const malformed = await getPoolDbClient()
      .selectDistinct({ id: repositoriesTable.id })
      .from(repositoriesTable)
      .innerJoin(pullRequestsTable, eq(pullRequestsTable.repositoryId, repositoriesTable.id))
      .where(and(
        inArray(repositoriesTable.id, candidates.map((t) => t.repositoryId)),
        ne(pullRequestsTable.workspaceId, repositoriesTable.workspaceId),
      ));
    blocked = new Set(malformed.map((r) => r.id));
  } catch (err) {
    // The index or the malformed-link probe failed. No candidate list, so no
    // decision is possible for anyone. Log the cause: this used to park
    // deliveries for 80 minutes with the real error discarded.
    console.error(`[webhooks] target lookup failed for ${fullName}:`, err);
    throw new GitHubAuthorizationUnavailableError();
  }

  const authorized: WatchTarget[] = [];
  let unavailable = 0;
  for (const target of candidates) {
    if (blocked.has(target.repositoryId)) continue;
    try {
      if (await githubService.canAccessRepository(target.workspaceId, target.owner, target.repo)) {
        authorized.push(target);
      }
    } catch (err) {
      if (!(err instanceof GitHubAuthorizationUnavailableError)) throw err;
      unavailable++;
      console.warn(
        `[webhooks] ${fullName}: workspace ${target.workspaceId} could not be authorized — skipped for this delivery`
      );
    }
  }
  // Every answer was a non-answer: keep the delivery rather than drop it.
  if (authorized.length === 0 && unavailable > 0) throw new GitHubAuthorizationUnavailableError();
  return authorized;
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
