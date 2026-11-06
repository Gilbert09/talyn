import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import { spaces as spacesTable, workspaces as workspacesTable } from '../../db/schema.js';
import { githubService } from '../github.js';
import { TeamError } from '../billing/teams.js';
import {
  memberTeamIds as loadMemberTeamIds,
  resolveHomeWorkspace,
  SPACE_COLUMNS,
  type SpaceRow,
} from './membership.js';

/**
 * Who may see what in a space. Every space route and the workbench member
 * read path ask this service; none of them compare `owner_id` themselves.
 *
 * An item is visible to its owner (the owner of its workspace) and to a member
 * of the item's space's team whose own GitHub account can read the item's
 * repository. The repository check stops a private repo's transcript and diff
 * from reaching a teammate without access to it.
 */

export interface ViewableItem {
  workspaceId: string;
  spaceId: string | null;
  repoFullName: string | null;
}

export interface AccessDeps {
  ownedWorkspaceIds(userId: string): Promise<Set<string>>;
  memberTeamIds(userId: string): Promise<string[]>;
  /** spaceId to teamId, for the spaces that exist. */
  spaceTeams(spaceIds: string[]): Promise<Map<string, string>>;
  canReadRepo(userId: string, teamId: string, repoFullName: string): Promise<boolean>;
}

const REPO_READ_TTL_MS = 5 * 60_000;
const repoReadCache = new Map<string, { allowed: boolean; at: number }>();

export function resetRepoReadCacheForTests(): void {
  repoReadCache.clear();
}

/**
 * Whether the user's own GitHub account can read the repository, asked through
 * their home workspace for the team. Cached per user and repository for five
 * minutes. A GitHub fault answers no and is not cached.
 */
export async function canUserReadRepo(userId: string, teamId: string, repoFullName: string): Promise<boolean> {
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(repoFullName);
  if (!match) return false;
  const key = `${userId}\n${repoFullName.toLowerCase()}`;
  const cached = repoReadCache.get(key);
  if (cached && Date.now() - cached.at < REPO_READ_TTL_MS) return cached.allowed;
  const workspaceId = await resolveHomeWorkspace(teamId, userId);
  if (!workspaceId) return false;
  let allowed: boolean;
  try {
    allowed = await githubService.canAccessRepository(workspaceId, match[1]!, match[2]!);
  } catch (err) {
    console.warn(`[spaces] repository read check for ${repoFullName} failed:`, err);
    return false;
  }
  repoReadCache.set(key, { allowed, at: Date.now() });
  return allowed;
}

export const defaultAccessDeps: AccessDeps = {
  async ownedWorkspaceIds(userId) {
    const rows = await getPoolDbClient()
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(eq(workspacesTable.ownerId, userId));
    return new Set(rows.map((r) => r.id));
  },
  memberTeamIds: loadMemberTeamIds,
  async spaceTeams(spaceIds) {
    if (spaceIds.length === 0) return new Map();
    const rows = await getPoolDbClient()
      .select({ id: spacesTable.id, teamId: spacesTable.teamId })
      .from(spacesTable)
      .where(inArray(spacesTable.id, spaceIds));
    return new Map(rows.map((r) => [r.id, r.teamId]));
  },
  canReadRepo: canUserReadRepo,
};

/**
 * A view check for one user. It loads the user's workspaces and teams once,
 * so a list of N items costs one repo check per distinct repository.
 */
export function createViewer(
  userId: string,
  deps: AccessDeps = defaultAccessDeps
): (item: ViewableItem) => Promise<boolean> {
  let owned: Promise<Set<string>> | null = null;
  let teams: Promise<Set<string>> | null = null;
  const spaceTeam = new Map<string, Promise<string | null>>();
  const repoRead = new Map<string, Promise<boolean>>();

  return async (item) => {
    owned ??= deps.ownedWorkspaceIds(userId);
    if ((await owned).has(item.workspaceId)) return true;
    if (!item.spaceId || !item.repoFullName) return false;
    const spaceId = item.spaceId;
    if (!spaceTeam.has(spaceId)) {
      spaceTeam.set(spaceId, deps.spaceTeams([spaceId]).then((m) => m.get(spaceId) ?? null));
    }
    const teamId = await spaceTeam.get(spaceId)!;
    if (!teamId) return false;
    teams ??= deps.memberTeamIds(userId).then((ids) => new Set(ids));
    if (!(await teams).has(teamId)) return false;
    const repoKey = `${teamId}\n${item.repoFullName.toLowerCase()}`;
    if (!repoRead.has(repoKey)) repoRead.set(repoKey, deps.canReadRepo(userId, teamId, item.repoFullName));
    return repoRead.get(repoKey)!;
  };
}

export async function canViewItem(
  userId: string,
  item: ViewableItem,
  deps: AccessDeps = defaultAccessDeps
): Promise<boolean> {
  return createViewer(userId, deps)(item);
}

/** The items the user may see, and how many they may not. */
export async function filterViewable<T extends ViewableItem>(
  userId: string,
  items: readonly T[],
  deps: AccessDeps = defaultAccessDeps
): Promise<{ visible: T[]; hiddenCount: number }> {
  const view = createViewer(userId, deps);
  const allowed = await Promise.all(items.map((item) => view(item)));
  const visible = items.filter((_, i) => allowed[i]);
  return { visible, hiddenCount: items.length - visible.length };
}

/** Whether the user owns this workspace. */
export async function ownsWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const [row] = await getPoolDbClient()
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(and(eq(workspacesTable.id, workspaceId), eq(workspacesTable.ownerId, userId)))
    .limit(1);
  return Boolean(row);
}

/** The spaces of every team the user belongs to. Archived spaces are left out. */
export async function spacesFor(userId: string): Promise<SpaceRow[]> {
  const teamIds = await loadMemberTeamIds(userId);
  if (teamIds.length === 0) return [];
  return getPoolDbClient()
    .select(SPACE_COLUMNS)
    .from(spacesTable)
    .where(and(inArray(spacesTable.teamId, teamIds), isNull(spacesTable.archivedAt)));
}

/** The space, when the user is in its team. A 404 otherwise, archived or not. */
export async function assertSpaceMember(userId: string, spaceId: string): Promise<SpaceRow> {
  const [space] = await getPoolDbClient()
    .select(SPACE_COLUMNS)
    .from(spacesTable)
    .where(eq(spacesTable.id, spaceId))
    .limit(1);
  if (!space || !(await loadMemberTeamIds(userId)).includes(space.teamId)) {
    throw new TeamError(404, 'Space not found');
  }
  return space;
}
