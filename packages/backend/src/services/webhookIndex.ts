import { getPoolDbClient } from '../db/client.js';
import { repositories as repositoriesTable } from '../db/schema.js';

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

/** Force a rebuild now (called after a repo is added/removed or on install events). */
export async function refreshWebhookIndex(): Promise<void> {
  await build();
}

/** Every workspace watching `owner/repo`. Ensures freshness first. */
export async function targetsForRepo(fullName: string): Promise<WatchTarget[]> {
  await ensureFresh();
  return index.get(fullName.toLowerCase()) ?? [];
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
