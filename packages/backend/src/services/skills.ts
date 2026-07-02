// Skills service — repo-skill discovery (GitHub contents API + cache),
// platform-skill CRUD helpers, and the per-workspace usage counters that
// order the desktop's skill picker.
//
// Repo skills live at `.claude/skills/<dir>/SKILL.md` on the repo's default
// branch. Discovery passes NO ref to the contents API on purpose — GitHub
// then resolves the repo's actual default branch. The repositories row's
// `defaultBranch` column is untrustworthy here: addWatchedRepo hardcodes
// 'main' and nothing corrects it, so a master-defaulted repo (e.g.
// posthog/posthog) would 404 on ?ref=main and report "no skills".
// Fork PRs need no special handling: a task's repositoryId always points at
// the watched base repo.

import { eq, sql } from 'drizzle-orm';
import {
  parseSkillFrontmatter,
  repoSkillKey,
  SKILL_MAX_BYTES,
  type SkillSummary,
  type SkillUsageEntry,
} from '@talyn/shared';
import { getDbClient } from '../db/client.js';
import { repositories as repositoriesTable, skillUsage as skillUsageTable } from '../db/schema.js';
import { githubService } from './github.js';
import { parseRepoUrl } from './repoIdentity.js';

const SKILLS_DIR = '.claude/skills';
const CACHE_TTL_MS = 10 * 60 * 1000;

export type RepoSkillStatus = 'ok' | 'none' | 'error';

export interface RepoSkill extends SkillSummary {
  source: 'repo';
  repositoryId: string;
  repoPath: string;
  /** Full SKILL.md text; null when the file exceeds SKILL_MAX_BYTES. */
  content: string | null;
}

export interface RepoSkillsResult {
  status: RepoSkillStatus;
  skills: RepoSkill[];
}

interface CacheEntry {
  fetchedAt: number;
  result: RepoSkillsResult;
}

// Keyed by repositoryId. In-memory on purpose: skill listings are small,
// refetching after a restart is one cheap contents call, and an explicit
// `refresh` bypass covers "I just pushed a skill".
const repoSkillCache = new Map<string, CacheEntry>();

/** Test hook. */
export function clearRepoSkillCache(): void {
  repoSkillCache.clear();
}

async function loadRepoIdentity(
  repositoryId: string,
  workspaceId: string
): Promise<{ owner: string; repo: string } | null> {
  const db = getDbClient();
  const rows = await db
    .select({
      id: repositoriesTable.id,
      workspaceId: repositoriesTable.workspaceId,
      url: repositoriesTable.url,
    })
    .from(repositoriesTable)
    .where(eq(repositoriesTable.id, repositoryId))
    .limit(1);
  const row = rows[0];
  if (!row || row.workspaceId !== workspaceId) return null;
  const identity = parseRepoUrl(row.url);
  if (!identity) return null;
  return { owner: identity.owner, repo: identity.repo };
}

async function fetchRepoSkills(
  workspaceId: string,
  repositoryId: string
): Promise<RepoSkillsResult> {
  const repo = await loadRepoIdentity(repositoryId, workspaceId);
  if (!repo) return { status: 'error', skills: [] };

  // ref deliberately omitted throughout — GitHub resolves the repo's real
  // default branch (see the header comment).
  const listing = await githubService.getDirectoryListing(
    workspaceId,
    repo.owner,
    repo.repo,
    SKILLS_DIR,
    undefined
  );
  if (listing === null) return { status: 'none', skills: [] };

  // Symlinked entries can be skill dirs too (getDirectoryListing follows
  // them; if one turns out to be a file, its listing is null and it's skipped).
  const dirs = listing.filter((e) => e.type === 'dir' || e.type === 'symlink');
  const skills = await Promise.all(
    dirs.map(async (dir): Promise<RepoSkill | null> => {
      const dirListing = await githubService.getDirectoryListing(
        workspaceId,
        repo.owner,
        repo.repo,
        dir.path,
        undefined
      );
      const skillFile = dirListing?.find((e) => e.type === 'file' && e.name === 'SKILL.md');
      if (!dirListing || !skillFile) return null;

      const file = await githubService.getFileContent(
        workspaceId,
        repo.owner,
        repo.repo,
        skillFile.path,
        undefined,
        SKILL_MAX_BYTES
      );
      if (!file) return null;

      const parsed = file.content !== null ? parseSkillFrontmatter(file.content) : null;
      const name = parsed?.name ?? dir.name;
      return {
        key: repoSkillKey(repo.owner, repo.repo, name),
        source: 'repo',
        name,
        description: parsed?.description ?? '',
        repositoryId,
        repoPath: skillFile.path,
        hasSupportingFiles: dirListing.some((e) => e.name !== 'SKILL.md'),
        contentSize: file.size,
        content: file.content,
      };
    })
  );

  return {
    status: 'ok',
    skills: skills.filter((s): s is RepoSkill => s !== null),
  };
}

/**
 * Skills discovered in a watched repo, cached for CACHE_TTL_MS. On a GitHub
 * failure a stale cache entry is served rather than dropped — a rate-limited
 * tick shouldn't blank the picker.
 */
export async function listRepoSkills(
  workspaceId: string,
  repositoryId: string,
  opts: { refresh?: boolean } = {}
): Promise<RepoSkillsResult> {
  const cached = repoSkillCache.get(repositoryId);
  if (!opts.refresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.result;
  }
  try {
    const result = await fetchRepoSkills(workspaceId, repositoryId);
    repoSkillCache.set(repositoryId, { fetchedAt: Date.now(), result });
    return result;
  } catch (err) {
    console.warn(
      `[skills] repo skill discovery failed for ${repositoryId}: ${err instanceof Error ? err.message : String(err)}`
    );
    if (cached) return cached.result;
    return { status: 'error', skills: [] };
  }
}

/** A single repo skill's content, cache-first with fetch-through. */
export async function getRepoSkillContent(
  workspaceId: string,
  repositoryId: string,
  name: string
): Promise<RepoSkill | null> {
  const listed = await listRepoSkills(workspaceId, repositoryId);
  const hit = listed.skills.find((s) => s.name === name);
  if (hit) return hit;
  if (listed.status === 'ok' || listed.status === 'none') {
    // Fresh listing didn't have it — maybe pushed since the cache filled.
    const refreshed = await listRepoSkills(workspaceId, repositoryId, { refresh: true });
    return refreshed.skills.find((s) => s.name === name) ?? null;
  }
  return null;
}

/** Usage stats for every skill key the workspace has run, for picker ordering. */
export async function getSkillUsage(
  workspaceId: string
): Promise<Record<string, SkillUsageEntry>> {
  const db = getDbClient();
  const rows = await db
    .select({
      skillKey: skillUsageTable.skillKey,
      usageCount: skillUsageTable.usageCount,
      lastUsedAt: skillUsageTable.lastUsedAt,
    })
    .from(skillUsageTable)
    .where(eq(skillUsageTable.workspaceId, workspaceId));
  const out: Record<string, SkillUsageEntry> = {};
  for (const row of rows) {
    out[row.skillKey] = { count: row.usageCount, lastUsedAt: row.lastUsedAt.toISOString() };
  }
  return out;
}

/** Bump a skill's usage counter (fire-and-forget from task creation). */
export async function bumpSkillUsage(workspaceId: string, skillKey: string): Promise<void> {
  const db = getDbClient();
  const now = new Date();
  await db
    .insert(skillUsageTable)
    .values({ workspaceId, skillKey, usageCount: 1, lastUsedAt: now })
    .onConflictDoUpdate({
      target: [skillUsageTable.workspaceId, skillUsageTable.skillKey],
      set: {
        usageCount: sql`${skillUsageTable.usageCount} + 1`,
        lastUsedAt: now,
      },
    });
}
