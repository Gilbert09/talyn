import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import {
  canManageTeam,
  isTeamRole,
  MAX_TEAM_NAME_LENGTH,
  type Space,
  type SpacesTeam,
  type TeamMember,
  type TeamMemberSource,
  type TeamRole,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import {
  spaces as spacesTable,
  teamMembers as teamMembersTable,
  teams as teamsTable,
  users as usersTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { ensureGithubUserId } from '../githubIdentity.js';
import {
  githubAvatarUrl,
  isValidGithubLogin,
  normaliseGithubLogin,
  TeamError,
  type ResolveGithubAccount,
} from '../billing/teams.js';

/**
 * Team membership for Teams and Spaces. Every read and write is on the pool:
 * `team_members` and `spaces` are backend-only tables. Authorization is
 * explicit in each function. A team the caller is not in is a 404, so a
 * stranger cannot learn that a team id exists.
 */

const MEMBER_COLUMNS = {
  id: teamMembersTable.id,
  teamId: teamMembersTable.teamId,
  githubUserId: teamMembersTable.githubUserId,
  userId: teamMembersTable.userId,
  githubLogin: teamMembersTable.githubLogin,
  avatarUrl: teamMembersTable.avatarUrl,
  role: teamMembersTable.role,
  source: teamMembersTable.source,
  homeWorkspaceId: teamMembersTable.homeWorkspaceId,
  createdAt: teamMembersTable.createdAt,
} as const;

export type MemberRow = Pick<typeof teamMembersTable.$inferSelect, keyof typeof MEMBER_COLUMNS>;

export const SPACE_COLUMNS = {
  id: spacesTable.id,
  teamId: spacesTable.teamId,
  name: spacesTable.name,
  color: spacesTable.color,
  createdByUserId: spacesTable.createdByUserId,
  archivedAt: spacesTable.archivedAt,
  createdAt: spacesTable.createdAt,
  updatedAt: spacesTable.updatedAt,
} as const;

export type SpaceRow = Pick<typeof spacesTable.$inferSelect, keyof typeof SPACE_COLUMNS>;

/**
 * `SPACE_COLUMNS` plus the inline image. Access checks run on every space
 * request and WebSocket recheck, so they use `SPACE_COLUMNS` and never read
 * the image. Only the reads that answer with a `Space` use this.
 */
export const SPACE_DETAIL_COLUMNS = { ...SPACE_COLUMNS, image: spacesTable.image } as const;

export type SpaceDetailRow = Pick<typeof spacesTable.$inferSelect, keyof typeof SPACE_DETAIL_COLUMNS>;

export function toSpace(row: SpaceDetailRow): Space {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    color: row.color,
    image: row.image,
    createdByUserId: row.createdByUserId,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function roleOf(row: Pick<MemberRow, 'role'>): TeamRole {
  return isTeamRole(row.role) ? row.role : 'member';
}

function sourceOf(row: Pick<MemberRow, 'source'>): TeamMemberSource {
  return row.source === 'seat' ? 'seat' : 'invite';
}

/** The caller's GitHub identity. The id comes from the sign-in, never from user metadata. */
export async function callerGithubIdentity(
  userId: string
): Promise<{ githubUserId: number | null; githubLogin: string | null }> {
  const [user] = await getPoolDbClient()
    .select({ githubUserId: usersTable.githubUserId, githubLogin: usersTable.githubUsername })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const githubUserId = user?.githubUserId ?? (await ensureGithubUserId(userId));
  return { githubUserId: githubUserId ?? null, githubLogin: user?.githubLogin ?? null };
}

/**
 * The rows that are the caller's: their claimed rows, and rows for their
 * GitHub id that nobody has claimed yet. A row another account claimed stays
 * that account's.
 */
export function mineCondition(userId: string, githubUserId: number | null) {
  return githubUserId === null
    ? eq(teamMembersTable.userId, userId)
    : or(
        eq(teamMembersTable.userId, userId),
        and(isNull(teamMembersTable.userId), eq(teamMembersTable.githubUserId, githubUserId))
      );
}

/** Fill `user_id` on the invites that name the caller's GitHub id. */
export async function claimMemberships(userId: string, githubUserId: number | null): Promise<void> {
  if (githubUserId === null) return;
  await getPoolDbClient()
    .update(teamMembersTable)
    .set({ userId })
    .where(and(eq(teamMembersTable.githubUserId, githubUserId), isNull(teamMembersTable.userId)));
}

/** The ids of every team the user belongs to. */
export async function memberTeamIds(userId: string): Promise<string[]> {
  const { githubUserId } = await callerGithubIdentity(userId);
  const rows = await getPoolDbClient()
    .select({ teamId: teamMembersTable.teamId })
    .from(teamMembersTable)
    .where(mineCondition(userId, githubUserId));
  return [...new Set(rows.map((r) => r.teamId))];
}

/** The caller's own membership row in a team, or null. */
export async function myMembership(teamId: string, userId: string): Promise<MemberRow | null> {
  const { githubUserId } = await callerGithubIdentity(userId);
  const [row] = await getPoolDbClient()
    .select(MEMBER_COLUMNS)
    .from(teamMembersTable)
    .where(and(eq(teamMembersTable.teamId, teamId), mineCondition(userId, githubUserId)))
    .limit(1);
  return row ?? null;
}

/** 404 for a team the caller is not in. */
export async function assertTeamMember(teamId: string, userId: string): Promise<MemberRow> {
  const row = await myMembership(teamId, userId);
  if (!row) throw new TeamError(404, 'Team not found');
  return row;
}

/** 404 for a stranger, 403 for a member who is not an owner or admin. */
export async function assertTeamManager(teamId: string, userId: string): Promise<MemberRow> {
  const row = await assertTeamMember(teamId, userId);
  if (!canManageTeam(roleOf(row))) {
    throw new TeamError(403, 'Only a team owner or admin can do this.');
  }
  return row;
}

/** The user's workspaces, oldest first. */
async function ownedWorkspaceIds(userId: string): Promise<string[]> {
  const rows = await getPoolDbClient()
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(eq(workspacesTable.ownerId, userId))
    .orderBy(asc(workspacesTable.createdAt), asc(workspacesTable.id));
  return rows.map((r) => r.id);
}

/** The stored home when the user still owns it, else their oldest workspace. */
export function pickHomeWorkspace(stored: string | null, owned: readonly string[]): string | null {
  if (stored && owned.includes(stored)) return stored;
  return owned[0] ?? null;
}

/** The caller's workspace that hosts and pays for their work in this team. */
export async function resolveHomeWorkspace(teamId: string, userId: string): Promise<string | null> {
  const membership = await myMembership(teamId, userId);
  if (!membership) return null;
  return pickHomeWorkspace(membership.homeWorkspaceId, await ownedWorkspaceIds(userId));
}

function validTeamName(rawName: string): string {
  const name = rawName.trim();
  if (!name) throw new TeamError(400, 'Give the team a name.');
  if (name.length > MAX_TEAM_NAME_LENGTH) {
    throw new TeamError(400, `A team name is at most ${MAX_TEAM_NAME_LENGTH} characters.`);
  }
  return name;
}

/**
 * Create a free team with the caller as its owner. No billing: a team buys
 * seats only through `/billing/team`.
 */
export async function createSpacesTeam(userId: string, rawName: string): Promise<SpacesTeam> {
  const name = validTeamName(rawName);
  const { githubUserId, githubLogin } = await callerGithubIdentity(userId);
  if (githubUserId === null || !githubLogin) {
    throw new TeamError(
      409,
      'Talyn does not know your GitHub account yet. Sign out and sign in again with GitHub, then try again.'
    );
  }
  const id = uuid();
  const home = (await ownedWorkspaceIds(userId))[0] ?? null;
  await getPoolDbClient().transaction(async (tx) => {
    await tx.insert(teamsTable).values({ id, name, createdByUserId: userId });
    await tx.insert(teamMembersTable).values({
      id: uuid(),
      teamId: id,
      githubUserId,
      userId,
      githubLogin,
      avatarUrl: githubAvatarUrl(githubUserId),
      role: 'owner',
      source: 'invite',
      homeWorkspaceId: home,
      invitedByUserId: userId,
    });
  });
  const team = (await listMyTeams(userId)).find((t) => t.id === id);
  if (!team) throw new Error(`team ${id} was created but is not listed`);
  return team;
}

export async function renameSpacesTeam(teamId: string, userId: string, rawName: string): Promise<void> {
  await assertTeamManager(teamId, userId);
  const name = validTeamName(rawName);
  await getPoolDbClient()
    .update(teamsTable)
    .set({ name, updatedAt: new Date() })
    .where(eq(teamsTable.id, teamId));
}

/** Every team the caller belongs to, with their role, home workspace and live spaces. */
export async function listMyTeams(userId: string): Promise<SpacesTeam[]> {
  const db = getPoolDbClient();
  const { githubUserId } = await callerGithubIdentity(userId);
  await claimMemberships(userId, githubUserId);
  const rows = await db
    .select({
      teamId: teamsTable.id,
      name: teamsTable.name,
      createdAt: teamsTable.createdAt,
      role: teamMembersTable.role,
      homeWorkspaceId: teamMembersTable.homeWorkspaceId,
    })
    .from(teamMembersTable)
    .innerJoin(teamsTable, eq(teamsTable.id, teamMembersTable.teamId))
    .where(mineCondition(userId, githubUserId))
    .orderBy(asc(teamsTable.createdAt));
  if (rows.length === 0) return [];
  const owned = await ownedWorkspaceIds(userId);
  const spaceRows = await db
    .select(SPACE_DETAIL_COLUMNS)
    .from(spacesTable)
    .where(
      and(
        inArray(
          spacesTable.teamId,
          rows.map((r) => r.teamId)
        ),
        isNull(spacesTable.archivedAt)
      )
    )
    .orderBy(asc(spacesTable.createdAt));
  return rows.map((r) => ({
    id: r.teamId,
    name: r.name,
    role: roleOf(r),
    homeWorkspaceId: pickHomeWorkspace(r.homeWorkspaceId, owned),
    spaces: spaceRows.filter((s) => s.teamId === r.teamId).map(toSpace),
    createdAt: r.createdAt.toISOString(),
  }));
}

async function toMembers(rows: MemberRow[]): Promise<TeamMember[]> {
  const unclaimed = rows.filter((r) => r.userId === null).map((r) => r.githubUserId);
  const signedUp = unclaimed.length
    ? await getPoolDbClient()
        .select({ githubUserId: usersTable.githubUserId })
        .from(usersTable)
        .where(inArray(usersTable.githubUserId, unclaimed))
    : [];
  const signedUpIds = new Set(signedUp.map((u) => u.githubUserId));
  return rows.map((r) => ({
    id: r.id,
    teamId: r.teamId,
    githubUserId: r.githubUserId,
    githubLogin: r.githubLogin,
    avatarUrl: r.avatarUrl ?? githubAvatarUrl(r.githubUserId),
    role: roleOf(r),
    source: sourceOf(r),
    signedUp: r.userId !== null || signedUpIds.has(r.githubUserId),
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function listMembers(teamId: string, userId: string): Promise<TeamMember[]> {
  await assertTeamMember(teamId, userId);
  const rows = await getPoolDbClient()
    .select(MEMBER_COLUMNS)
    .from(teamMembersTable)
    .where(eq(teamMembersTable.teamId, teamId))
    .orderBy(asc(teamMembersTable.createdAt));
  return toMembers(rows);
}

async function loadMember(teamId: string, memberId: string): Promise<MemberRow> {
  const [row] = await getPoolDbClient()
    .select(MEMBER_COLUMNS)
    .from(teamMembersTable)
    .where(and(eq(teamMembersTable.teamId, teamId), eq(teamMembersTable.id, memberId)))
    .limit(1);
  if (!row) throw new TeamError(404, 'Member not found');
  return row;
}

async function ownerCount(teamId: string): Promise<number> {
  const [row] = await getPoolDbClient()
    .select({ n: sql<number>`count(*)::int` })
    .from(teamMembersTable)
    .where(and(eq(teamMembersTable.teamId, teamId), eq(teamMembersTable.role, 'owner')));
  return Number(row?.n ?? 0);
}

const LAST_OWNER_MESSAGE = 'A team always needs an owner. Make someone else an owner first.';

/**
 * Why `actor` may not remove `target`, or null when they may. A member may
 * always leave; anyone else needs owner or admin, and only an owner removes an
 * owner. A seat holder leaves through the seat, so the paid seat is never left
 * without a member.
 */
export function removalRefusal(input: {
  actorRole: TeamRole;
  isSelf: boolean;
  targetRole: TeamRole;
  targetSource: TeamMemberSource;
  owners: number;
}): { status: number; message: string } | null {
  if (!input.isSelf && !canManageTeam(input.actorRole)) {
    return { status: 403, message: 'Only a team owner or admin can remove people.' };
  }
  if (!input.isSelf && input.targetRole === 'owner' && input.actorRole !== 'owner') {
    return { status: 403, message: 'Only an owner can remove an owner.' };
  }
  if (input.targetRole === 'owner' && input.owners <= 1) {
    return { status: 409, message: LAST_OWNER_MESSAGE };
  }
  if (input.targetSource === 'seat') {
    return {
      status: 409,
      message: 'This person holds a paid seat. Remove the seat in Seats and billing first.',
    };
  }
  return null;
}

/** Why `actor` may not give `target` the role `next`, or null when they may. */
export function roleChangeRefusal(input: {
  actorRole: TeamRole;
  targetRole: TeamRole;
  next: TeamRole;
  owners: number;
}): { status: number; message: string } | null {
  if (!canManageTeam(input.actorRole)) {
    return { status: 403, message: 'Only a team owner or admin can change roles.' };
  }
  if ((input.next === 'owner' || input.targetRole === 'owner') && input.actorRole !== 'owner') {
    return { status: 403, message: 'Only an owner can make or change an owner.' };
  }
  if (input.targetRole === 'owner' && input.next !== 'owner' && input.owners <= 1) {
    return { status: 409, message: LAST_OWNER_MESSAGE };
  }
  return null;
}

export async function removeMember(teamId: string, userId: string, memberId: string): Promise<void> {
  const actor = await assertTeamMember(teamId, userId);
  const target = await loadMember(teamId, memberId);
  const refusal = removalRefusal({
    actorRole: roleOf(actor),
    isSelf: actor.id === target.id,
    targetRole: roleOf(target),
    targetSource: sourceOf(target),
    owners: await ownerCount(teamId),
  });
  if (refusal) throw new TeamError(refusal.status, refusal.message);
  await getPoolDbClient()
    .delete(teamMembersTable)
    .where(and(eq(teamMembersTable.teamId, teamId), eq(teamMembersTable.id, memberId)));
}

export async function changeMemberRole(
  teamId: string,
  userId: string,
  memberId: string,
  next: unknown
): Promise<TeamMember> {
  if (!isTeamRole(next)) throw new TeamError(400, 'role must be "owner", "admin" or "member".');
  const actor = await assertTeamMember(teamId, userId);
  const target = await loadMember(teamId, memberId);
  const refusal = roleChangeRefusal({
    actorRole: roleOf(actor),
    targetRole: roleOf(target),
    next,
    owners: await ownerCount(teamId),
  });
  if (refusal) throw new TeamError(refusal.status, refusal.message);
  const [row] = await getPoolDbClient()
    .update(teamMembersTable)
    .set({ role: next })
    .where(and(eq(teamMembersTable.teamId, teamId), eq(teamMembersTable.id, memberId)))
    .returning(MEMBER_COLUMNS);
  return (await toMembers([row!]))[0]!;
}

/**
 * Invite a GitHub account by login. Free: membership is not a seat. The login
 * is resolved to the numeric id, which is the key, so the invite works before
 * the person signs up and survives a rename.
 */
export async function inviteMember(
  teamId: string,
  userId: string,
  rawLogin: string,
  resolveAccount: ResolveGithubAccount
): Promise<TeamMember> {
  await assertTeamManager(teamId, userId);
  const login = normaliseGithubLogin(rawLogin);
  if (!isValidGithubLogin(login)) throw new TeamError(400, 'Not a valid GitHub username.');
  const account = await resolveAccount(login);
  if (!account) throw new TeamError(404, 'No GitHub user has this username.');
  const db = getPoolDbClient();
  const accounts = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.githubUserId, account.id))
    .limit(2);
  const inserted = await db
    .insert(teamMembersTable)
    .values({
      id: uuid(),
      teamId,
      githubUserId: account.id,
      // Claimed now only when exactly one account has this GitHub id.
      userId: accounts.length === 1 ? accounts[0]!.id : null,
      githubLogin: account.login,
      avatarUrl: account.avatarUrl ?? githubAvatarUrl(account.id),
      role: 'member',
      source: 'invite',
      invitedByUserId: userId,
    })
    .onConflictDoNothing({ target: [teamMembersTable.teamId, teamMembersTable.githubUserId] })
    .returning(MEMBER_COLUMNS);
  if (inserted.length === 0) throw new TeamError(409, `@${account.login} is already a member.`);
  return (await toMembers(inserted))[0]!;
}

/** Set the caller's home workspace for this team. It must be a workspace they own. */
export async function setHomeWorkspace(teamId: string, userId: string, workspaceId: string): Promise<string> {
  const membership = await assertTeamMember(teamId, userId);
  if (!(await ownedWorkspaceIds(userId)).includes(workspaceId)) {
    throw new TeamError(404, 'Workspace not found');
  }
  await getPoolDbClient()
    .update(teamMembersTable)
    .set({ homeWorkspaceId: workspaceId, userId })
    .where(eq(teamMembersTable.id, membership.id));
  return workspaceId;
}
