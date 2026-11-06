import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import {
  canManageTeam,
  isTeamRole,
  MAX_SPACE_NAME_LENGTH,
  SPACE_COLOR_PATTERN,
  type CreateSpaceSessionRequest,
  type CreateSpaceSessionResponse,
  type Space,
  type SpaceItemCreator,
  type SpaceItemsResponse,
  type SpaceRepository,
  type SpaceSessionRow,
  type SpaceTaskRow,
  type Task,
  type TaskStatus,
  type TaskType,
  type Workbench,
  type WorkbenchAgent,
  type WorkbenchSandboxState,
  type WorkbenchStatus,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import {
  pullRequests as prTable,
  repositories as reposTable,
  spaceRepositories as spaceReposTable,
  spaces as spacesTable,
  tasks as tasksTable,
  users as usersTable,
  workbenchChats as chatsTable,
  workbenches as workbenchesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { githubAvatarUrl, TeamError } from '../billing/teams.js';
import { githubService, isGitHubAccessRefusal } from '../github.js';
import { prMonitorService } from '../prMonitor.js';
import { refreshWebhookIndex } from '../webhookIndex.js';
import { rowToTask, taskColumnsNoTranscript } from '../taskSerialize.js';
import { emitTaskUpdate } from '../websocket.js';
import { createWorkbench } from '../workbenches/create.js';
import { emitWorkbenchUpdated } from '../workbenches/emit.js';
import { publicWorkbench } from '../workbenches/prLink.js';
import type { ReadinessUser } from '../workbenches/readiness.js';
import { getWorkbench, isThread, updateWorkbench } from '../workbenches/store.js';
import { assertSpaceMember, filterViewable, ownsWorkspace, type AccessDeps, defaultAccessDeps } from './access.js';
import { assertTeamMember, resolveHomeWorkspace, SPACE_COLUMNS, toSpace } from './membership.js';

/**
 * Spaces: a team's containers for sessions and tasks. Each session or task in
 * a space still runs in its creator's own workspace. Every read is on the pool
 * with an explicit projection: no sandbox id, device, path, setting or
 * credential column leaves through here.
 */

/** How many live items a space list returns, and how many archived ones after them. */
export const SPACE_LIST_LIMIT = 200;
export const SPACE_ARCHIVED_LIMIT = 20;

const REPO_FULL_NAME = /^[\w.-]+\/[\w.-]+$/;

function validSpaceName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new TeamError(400, 'Give the space a name.');
  if (name.length > MAX_SPACE_NAME_LENGTH) {
    throw new TeamError(400, `A space name is at most ${MAX_SPACE_NAME_LENGTH} characters.`);
  }
  return name;
}

function validColor(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !SPACE_COLOR_PATTERN.test(raw)) {
    throw new TeamError(400, 'color must be a hex colour like "#4f46e5".');
  }
  return raw.toLowerCase();
}

function liveSpace<T extends { archivedAt: Date | null }>(space: T): T {
  if (space.archivedAt) throw new TeamError(409, 'This space is archived.');
  return space;
}

export async function createSpace(
  teamId: string,
  userId: string,
  body: { name?: unknown; color?: unknown }
): Promise<Space> {
  await assertTeamMember(teamId, userId);
  const name = validSpaceName(body.name);
  const color = validColor(body.color);
  const [row] = await getPoolDbClient()
    .insert(spacesTable)
    .values({ id: uuid(), teamId, name, color, createdByUserId: userId })
    .returning(SPACE_COLUMNS);
  return toSpace(row!);
}

export async function updateSpace(
  spaceId: string,
  userId: string,
  body: { name?: unknown; color?: unknown }
): Promise<Space> {
  liveSpace(await assertSpaceMember(userId, spaceId));
  const patch: { name?: string; color?: string | null } = {};
  if (body.name !== undefined) patch.name = validSpaceName(body.name);
  if (body.color !== undefined) patch.color = validColor(body.color);
  const [row] = await getPoolDbClient()
    .update(spacesTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(spacesTable.id, spaceId))
    .returning(SPACE_COLUMNS);
  return toSpace(row!);
}

/**
 * Archive a space: its creator or a team owner or admin. The sessions and
 * tasks in it stay where they are, in their owners' workspaces.
 */
export async function archiveSpace(spaceId: string, userId: string): Promise<void> {
  const space = await assertSpaceMember(userId, spaceId);
  if (space.archivedAt) return;
  const membership = await assertTeamMember(space.teamId, userId);
  const role = isTeamRole(membership.role) ? membership.role : 'member';
  if (space.createdByUserId !== userId && !canManageTeam(role)) {
    throw new TeamError(403, 'Only the space creator or a team owner or admin can archive it.');
  }
  await getPoolDbClient()
    .update(spacesTable)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(spacesTable.id, spaceId));
}

const SPACE_REPO_COLUMNS = {
  spaceId: spaceReposTable.spaceId,
  repoFullName: spaceReposTable.repoFullName,
  githubRepoId: spaceReposTable.githubRepoId,
  createdAt: spaceReposTable.createdAt,
} as const;

function toSpaceRepository(row: {
  spaceId: string;
  repoFullName: string;
  githubRepoId: number | null;
  createdAt: Date;
}): SpaceRepository {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

export async function listSpaceRepositories(spaceId: string, userId: string): Promise<SpaceRepository[]> {
  await assertSpaceMember(userId, spaceId);
  const rows = await getPoolDbClient()
    .select(SPACE_REPO_COLUMNS)
    .from(spaceReposTable)
    .where(eq(spaceReposTable.spaceId, spaceId))
    .orderBy(asc(spaceReposTable.repoFullName));
  return rows.map(toSpaceRepository);
}

/** A GitHub repository as the caller's own account sees it, or null when it cannot. */
export type LookupRepo = (
  userId: string,
  teamId: string,
  repoFullName: string
) => Promise<{ fullName: string; id: number } | null>;

export const lookupRepoForMember: LookupRepo = async (userId, teamId, repoFullName) => {
  const workspaceId = await resolveHomeWorkspace(teamId, userId);
  if (!workspaceId) return null;
  const [owner, repo] = repoFullName.split('/');
  try {
    const found = await githubService.getRepository(workspaceId, owner!, repo!);
    return found.full_name ? { fullName: found.full_name, id: found.id } : null;
  } catch (err) {
    if (isGitHubAccessRefusal(err)) return null;
    throw err;
  }
};

/** Add a repository to the space's picker. The caller's own GitHub account must read it. */
export async function addSpaceRepository(
  spaceId: string,
  userId: string,
  rawFullName: unknown,
  lookup: LookupRepo = lookupRepoForMember
): Promise<SpaceRepository> {
  const space = liveSpace(await assertSpaceMember(userId, spaceId));
  const requested = typeof rawFullName === 'string' ? rawFullName.trim() : '';
  if (!REPO_FULL_NAME.test(requested)) throw new TeamError(400, 'repoFullName must be "owner/name".');
  const found = await lookup(userId, space.teamId, requested);
  if (!found) {
    throw new TeamError(404, `Your GitHub account cannot read ${requested}, or it does not exist.`);
  }
  const db = getPoolDbClient();
  const existing = await db
    .select(SPACE_REPO_COLUMNS)
    .from(spaceReposTable)
    .where(
      and(
        eq(spaceReposTable.spaceId, spaceId),
        sql`lower(${spaceReposTable.repoFullName}) = lower(${found.fullName})`
      )
    )
    .limit(1);
  if (existing[0]) return toSpaceRepository(existing[0]);
  const [row] = await db
    .insert(spaceReposTable)
    .values({ spaceId, repoFullName: found.fullName, githubRepoId: found.id, addedByUserId: userId })
    .onConflictDoNothing()
    .returning(SPACE_REPO_COLUMNS);
  if (row) return toSpaceRepository(row);
  return (await listSpaceRepositories(spaceId, userId)).find((r) => r.repoFullName === found.fullName)!;
}

export async function removeSpaceRepository(spaceId: string, userId: string, repoFullName: string): Promise<void> {
  liveSpace(await assertSpaceMember(userId, spaceId));
  await getPoolDbClient()
    .delete(spaceReposTable)
    .where(
      and(
        eq(spaceReposTable.spaceId, spaceId),
        sql`lower(${spaceReposTable.repoFullName}) = lower(${repoFullName})`
      )
    );
}

/** The repository name as stored in the space, matched without case, or null. */
async function spaceRepoName(spaceId: string, repoFullName: string): Promise<string | null> {
  const [row] = await getPoolDbClient()
    .select({ repoFullName: spaceReposTable.repoFullName })
    .from(spaceReposTable)
    .where(
      and(
        eq(spaceReposTable.spaceId, spaceId),
        sql`lower(${spaceReposTable.repoFullName}) = lower(${repoFullName})`
      )
    )
    .limit(1);
  return row?.repoFullName ?? null;
}

// ---------- Listings ----------

/**
 * What the space sidebar reads for a session. Deliberately no sandbox id,
 * fleet host, device, local path, settings, source or work-save column.
 */
export const SPACE_SESSION_COLUMNS = {
  id: workbenchesTable.id,
  spaceId: workbenchesTable.spaceId,
  workspaceId: workbenchesTable.workspaceId,
  name: workbenchesTable.name,
  title: workbenchesTable.title,
  status: workbenchesTable.status,
  sandboxState: workbenchesTable.sandboxState,
  repoFullName: workbenchesTable.repoFullName,
  branch: workbenchesTable.branch,
  baseBranch: workbenchesTable.baseBranch,
  agent: workbenchesTable.agent,
  model: workbenchesTable.model,
  lastActivityAt: workbenchesTable.lastActivityAt,
  archivedAt: workbenchesTable.archivedAt,
  createdAt: workbenchesTable.createdAt,
  updatedAt: workbenchesTable.updatedAt,
  running: sql<boolean>`EXISTS (SELECT 1 FROM ${chatsTable} WHERE ${chatsTable.workbenchId} = ${workbenchesTable.id} AND ${chatsTable.status} = 'running' AND ${chatsTable.closedAt} IS NULL)`,
  prNumber: prTable.number,
  prState: prTable.state,
  prOwner: prTable.owner,
  prRepo: prTable.repo,
  creatorUserId: workspacesTable.ownerId,
  creatorLogin: usersTable.githubUsername,
  creatorGithubId: usersTable.githubUserId,
} as const;

/** The query behind a space's session list: live ones, or the recent archived ones. */
export function spaceSessionsQuery(spaceId: string, archived: boolean) {
  return getPoolDbClient()
    .select(SPACE_SESSION_COLUMNS)
    .from(workbenchesTable)
    .innerJoin(workspacesTable, eq(workspacesTable.id, workbenchesTable.workspaceId))
    .innerJoin(usersTable, eq(usersTable.id, workspacesTable.ownerId))
    .leftJoin(prTable, eq(prTable.id, workbenchesTable.pullRequestId))
    .where(
      and(
        eq(workbenchesTable.spaceId, spaceId),
        eq(workbenchesTable.kind, 'session'),
        archived ? isNotNull(workbenchesTable.archivedAt) : isNull(workbenchesTable.archivedAt)
      )
    )
    .orderBy(
      archived
        ? desc(workbenchesTable.archivedAt)
        : desc(sql`coalesce(${workbenchesTable.lastActivityAt}, ${workbenchesTable.updatedAt})`)
    )
    .limit(archived ? SPACE_ARCHIVED_LIMIT : SPACE_LIST_LIMIT);
}

export const SPACE_TASK_COLUMNS = {
  id: tasksTable.id,
  spaceId: tasksTable.spaceId,
  workspaceId: tasksTable.workspaceId,
  type: tasksTable.type,
  status: tasksTable.status,
  title: tasksTable.title,
  branch: tasksTable.branch,
  repoFullName: reposTable.name,
  createdAt: tasksTable.createdAt,
  updatedAt: tasksTable.updatedAt,
  completedAt: tasksTable.completedAt,
  prNumber: prTable.number,
  prState: prTable.state,
  prOwner: prTable.owner,
  prRepo: prTable.repo,
  creatorUserId: workspacesTable.ownerId,
  creatorLogin: usersTable.githubUsername,
  creatorGithubId: usersTable.githubUserId,
} as const;

export function spaceTasksQuery(spaceId: string) {
  return getPoolDbClient()
    .select(SPACE_TASK_COLUMNS)
    .from(tasksTable)
    .innerJoin(workspacesTable, eq(workspacesTable.id, tasksTable.workspaceId))
    .innerJoin(usersTable, eq(usersTable.id, workspacesTable.ownerId))
    .leftJoin(reposTable, eq(reposTable.id, tasksTable.repositoryId))
    .leftJoin(prTable, eq(prTable.id, tasksTable.pullRequestId))
    .where(eq(tasksTable.spaceId, spaceId))
    .orderBy(desc(tasksTable.updatedAt))
    .limit(SPACE_LIST_LIMIT);
}

function creatorOf(row: { creatorUserId: string; creatorLogin: string | null; creatorGithubId: number | null }): SpaceItemCreator {
  return {
    userId: row.creatorUserId,
    githubLogin: row.creatorLogin,
    avatarUrl: row.creatorGithubId ? githubAvatarUrl(row.creatorGithubId) : null,
  };
}

function prOf(row: { prNumber: number | null; prState: string | null; prOwner: string | null; prRepo: string | null }) {
  if (row.prNumber === null || !row.prOwner || !row.prRepo) return null;
  return {
    number: row.prNumber,
    state: row.prState ?? 'open',
    url: `https://github.com/${row.prOwner}/${row.prRepo}/pull/${row.prNumber}`,
  };
}

type SessionQueryRow = Awaited<ReturnType<typeof spaceSessionsQuery>>[number];
type TaskQueryRow = Awaited<ReturnType<typeof spaceTasksQuery>>[number];

function toSessionRow(row: SessionQueryRow): SpaceSessionRow {
  return {
    id: row.id,
    spaceId: row.spaceId!,
    workspaceId: row.workspaceId,
    name: row.name,
    title: row.title,
    status: (row.archivedAt ? 'archived' : row.status) as WorkbenchStatus,
    sandboxState: row.sandboxState as WorkbenchSandboxState,
    running: Boolean(row.running),
    repoFullName: row.repoFullName,
    branch: row.branch,
    baseBranch: row.baseBranch,
    agent: row.agent as WorkbenchAgent,
    model: row.model,
    pullRequest: prOf(row),
    creator: creatorOf(row),
    lastActivityAt: row.lastActivityAt ? row.lastActivityAt.toISOString() : null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toTaskRow(row: TaskQueryRow): SpaceTaskRow {
  return {
    id: row.id,
    spaceId: row.spaceId!,
    workspaceId: row.workspaceId,
    type: row.type as TaskType,
    status: row.status as TaskStatus,
    title: row.title,
    repoFullName: row.repoFullName,
    branch: row.branch,
    pullRequest: prOf(row),
    creator: creatorOf(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

/** Every member's sessions in the space: live first, then the recent archived ones. */
export async function listSpaceSessions(
  spaceId: string,
  userId: string,
  deps: AccessDeps = defaultAccessDeps
): Promise<SpaceItemsResponse<SpaceSessionRow>> {
  await assertSpaceMember(userId, spaceId);
  const [live, archived] = await Promise.all([spaceSessionsQuery(spaceId, false), spaceSessionsQuery(spaceId, true)]);
  const { visible, hiddenCount } = await filterViewable(userId, [...live, ...archived], deps);
  return { items: visible.map(toSessionRow), hiddenCount };
}

export async function listSpaceTasks(
  spaceId: string,
  userId: string,
  deps: AccessDeps = defaultAccessDeps
): Promise<SpaceItemsResponse<SpaceTaskRow>> {
  await assertSpaceMember(userId, spaceId);
  const rows = await spaceTasksQuery(spaceId);
  const { visible, hiddenCount } = await filterViewable(userId, rows, deps);
  return { items: visible.map(toTaskRow), hiddenCount };
}

// ---------- Create and move ----------

/** The repository row for `fullName` in the workspace, matched without case. */
async function workspaceRepositoryId(workspaceId: string, fullName: string): Promise<string | null> {
  const [row] = await getPoolDbClient()
    .select({ id: reposTable.id })
    .from(reposTable)
    .where(and(eq(reposTable.workspaceId, workspaceId), sql`lower(${reposTable.name}) = lower(${fullName})`))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Start a session in a space as the caller. It runs in the caller's home
 * workspace for the team, on their subscription, GitHub and billing. When that
 * workspace does not watch the repository yet, Talyn adds it first, by the
 * same path as "Add repository".
 */
export async function createSessionInSpace(
  spaceId: string,
  actor: ReadinessUser,
  body: Partial<CreateSpaceSessionRequest>,
  sentAt = new Date().toISOString()
): Promise<CreateSpaceSessionResponse> {
  const space = liveSpace(await assertSpaceMember(actor.id, spaceId));
  const requested = typeof body.repoFullName === 'string' ? body.repoFullName.trim() : '';
  if (!REPO_FULL_NAME.test(requested)) throw new TeamError(400, 'repoFullName must be "owner/name".');
  const repoFullName = await spaceRepoName(spaceId, requested);
  if (!repoFullName) throw new TeamError(400, `${requested} is not a repository of this space.`);
  const workspaceId = await resolveHomeWorkspace(space.teamId, actor.id);
  if (!workspaceId) {
    throw new TeamError(409, 'You need a workspace of your own to start a session in a space.');
  }

  let repositoryId = await workspaceRepositoryId(workspaceId, repoFullName);
  let addedRepository = false;
  if (!repositoryId) {
    const [owner, repo] = repoFullName.split('/');
    const watched = await prMonitorService.addWatchedRepo(workspaceId, owner!, repo!);
    void refreshWebhookIndex().catch(() => undefined);
    repositoryId = watched.id;
    addedRepository = true;
  }

  const workbench = await createWorkbench(
    {
      workspaceId,
      repositoryId,
      runtime: 'sandbox',
      agent: body.agent as WorkbenchAgent,
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.baseBranch !== undefined ? { baseBranch: body.baseBranch } : {}),
      ...(body.branch !== undefined ? { branch: body.branch } : {}),
      ...(body.internetAccess !== undefined ? { internetAccess: body.internetAccess } : {}),
      spaceId,
    },
    actor,
    sentAt
  );
  return { workbench, workspaceId, addedRepository };
}

/** The target space for a move, checked against the item owner's teams. Null is Personal. */
async function moveTarget(userId: string, spaceId: unknown): Promise<string | null> {
  if (spaceId === null) return null;
  if (typeof spaceId !== 'string' || !spaceId) throw new TeamError(400, 'spaceId must be a space id or null.');
  liveSpace(await assertSpaceMember(userId, spaceId));
  return spaceId;
}

/** Move a session into a space, or back to Personal. Only its owner can. */
export async function moveWorkbenchToSpace(userId: string, workbenchId: string, spaceId: unknown): Promise<Workbench> {
  const row = await getWorkbench(workbenchId);
  if (!row || !(await ownsWorkspace(userId, row.workspaceId))) throw new TeamError(404, 'Session not found');
  if (isThread(row)) throw new TeamError(400, 'A thread cannot move to a space.');
  const target = await moveTarget(userId, spaceId);
  const updated = await updateWorkbench(row.id, { spaceId: target });
  if (!updated) throw new TeamError(404, 'Session not found');
  const data = await publicWorkbench(updated);
  await emitWorkbenchUpdated(data);
  return data;
}

/** Move a task into a space, or back to Personal. Only its owner can. */
export async function moveTaskToSpace(userId: string, taskId: string, spaceId: unknown): Promise<Task> {
  const db = getPoolDbClient();
  const [row] = await db
    .select({ workspaceId: tasksTable.workspaceId })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  if (!row || !(await ownsWorkspace(userId, row.workspaceId))) throw new TeamError(404, 'Task not found');
  const target = await moveTarget(userId, spaceId);
  const [updated] = await db
    .update(tasksTable)
    .set({ spaceId: target, updatedAt: new Date() })
    .where(eq(tasksTable.id, taskId))
    .returning(taskColumnsNoTranscript);
  const task = rowToTask(updated!);
  emitTaskUpdate(task.workspaceId, task.id, { spaceId: task.spaceId, updatedAt: task.updatedAt });
  return task;
}
