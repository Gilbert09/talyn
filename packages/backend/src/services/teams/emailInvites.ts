import { createHash, randomBytes } from 'crypto';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import {
  isValidInviteEmail,
  TEAM_INVITE_TTL_DAYS,
  type InviteTeamEmailResponse,
  type SpacesTeam,
  type TeamEmailInvite,
  type TeamInvitePreview,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import {
  teamInvites as teamInvitesTable,
  teamMembers as teamMembersTable,
  teams as teamsTable,
  users as usersTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { escapeHtml, sendEmail, type EmailMessage } from '../email.js';
import { teamInviteUrl } from '../webApp.js';
import { githubAvatarUrl, TeamError } from '../billing/teams.js';
import { assertTeamManager, callerGithubIdentity, listMyTeams, mineCondition } from './membership.js';

/**
 * Team invites by email. `team_members` is keyed by the GitHub id, which an
 * email does not give, so an email invite waits in `team_invites` until the
 * person opens the link, signs in with GitHub and accepts.
 *
 * The link token is the proof: only the owner of the address gets it. The
 * accepting account's email is NOT compared with the invited one, because a
 * GitHub sign-in often reports a different (personal) address. A link is
 * single use and expires after `TEAM_INVITE_TTL_DAYS`. Only its hash is stored.
 */

export const MAX_PENDING_INVITES_PER_TEAM = 100;
const INVALID_LINK = 'This invite link is not valid. It may have expired or been used already. Ask for a new invite.';

export type SendInviteEmail = (message: EmailMessage) => Promise<boolean>;

const INVITE_COLUMNS = {
  id: teamInvitesTable.id,
  teamId: teamInvitesTable.teamId,
  email: teamInvitesTable.email,
  expiresAt: teamInvitesTable.expiresAt,
  createdAt: teamInvitesTable.createdAt,
  invitedByLogin: usersTable.githubUsername,
} as const;

type InviteRow = {
  id: string;
  teamId: string;
  email: string;
  expiresAt: Date;
  createdAt: Date;
  invitedByLogin: string | null;
};

function toInvite(row: InviteRow): TeamEmailInvite {
  return {
    id: row.id,
    teamId: row.teamId,
    email: row.email,
    invitedByLogin: row.invitedByLogin,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export function normaliseInviteEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/** One line, so a team name cannot add a header or break the subject. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function inviteEmailMessage(input: {
  to: string;
  teamName: string;
  inviterLogin: string | null;
  acceptUrl: string;
}): EmailMessage {
  const team = oneLine(input.teamName);
  const inviter = input.inviterLogin ? `@${oneLine(input.inviterLogin)}` : 'A teammate';
  const url = input.acceptUrl;
  const text = [
    `${inviter} invited you to join the team "${team}" on Talyn.`,
    '',
    'Open this link and sign in with GitHub to accept:',
    url,
    '',
    `The link works one time and expires in ${TEAM_INVITE_TTL_DAYS} days.`,
    'If you did not expect this email, you can ignore it.',
  ].join('\n');
  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;line-height:1.5">
<p>${escapeHtml(inviter)} invited you to join the team <strong>${escapeHtml(team)}</strong> on Talyn.</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;border-radius:6px;text-decoration:none">Accept the invite</a></p>
<p style="color:#555;font-size:13px">Or open this link: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a><br>
You sign in with GitHub to accept. The link works one time and expires in ${TEAM_INVITE_TTL_DAYS} days.<br>
If you did not expect this email, you can ignore it.</p>
</body></html>`;
  return { to: input.to, subject: `${inviter} invited you to ${team} on Talyn`, html, text };
}

/** Pending, unexpired invites. Owners and admins only: the rows are email addresses. */
export async function listEmailInvites(teamId: string, userId: string): Promise<TeamEmailInvite[]> {
  await assertTeamManager(teamId, userId);
  const rows = await getPoolDbClient()
    .select(INVITE_COLUMNS)
    .from(teamInvitesTable)
    .leftJoin(usersTable, eq(usersTable.id, teamInvitesTable.invitedByUserId))
    .where(
      and(
        eq(teamInvitesTable.teamId, teamId),
        isNull(teamInvitesTable.acceptedAt),
        gt(teamInvitesTable.expiresAt, new Date())
      )
    )
    .orderBy(asc(teamInvitesTable.createdAt));
  return rows.map(toInvite);
}

/** True when an account with this email is already in the team. */
async function emailIsMember(teamId: string, email: string): Promise<boolean> {
  const [row] = await getPoolDbClient()
    .select({ id: teamMembersTable.id })
    .from(teamMembersTable)
    .innerJoin(usersTable, eq(usersTable.githubUserId, teamMembersTable.githubUserId))
    .where(and(eq(teamMembersTable.teamId, teamId), sql`lower(${usersTable.email}) = ${email}`))
    .limit(1);
  return Boolean(row);
}

async function pendingCount(teamId: string): Promise<number> {
  const [row] = await getPoolDbClient()
    .select({ n: sql<number>`count(*)::int` })
    .from(teamInvitesTable)
    .where(
      and(
        eq(teamInvitesTable.teamId, teamId),
        isNull(teamInvitesTable.acceptedAt),
        gt(teamInvitesTable.expiresAt, new Date())
      )
    );
  return Number(row?.n ?? 0);
}

/**
 * Invite an email address and email it the accept link. Inviting the same
 * address again replaces the token, so only the newest link works. When the
 * email is not sent, the link comes back for the inviter to share.
 */
export async function inviteByEmail(
  teamId: string,
  userId: string,
  rawEmail: string,
  send: SendInviteEmail = sendEmail
): Promise<InviteTeamEmailResponse> {
  await assertTeamManager(teamId, userId);
  const email = normaliseInviteEmail(rawEmail);
  if (!isValidInviteEmail(email)) throw new TeamError(400, 'Not a valid email address.');
  if (await emailIsMember(teamId, email)) throw new TeamError(409, `${email} is already a member.`);

  const db = getPoolDbClient();
  const [existing] = await db
    .select({ id: teamInvitesTable.id })
    .from(teamInvitesTable)
    .where(
      and(
        eq(teamInvitesTable.teamId, teamId),
        eq(teamInvitesTable.email, email),
        isNull(teamInvitesTable.acceptedAt),
        gt(teamInvitesTable.expiresAt, new Date())
      )
    )
    .limit(1);
  if (!existing && (await pendingCount(teamId)) >= MAX_PENDING_INVITES_PER_TEAM) {
    throw new TeamError(409, `A team can have at most ${MAX_PENDING_INVITES_PER_TEAM} pending invites. Revoke some first.`);
  }

  const token = newInviteToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TEAM_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const [saved] = await db
    .insert(teamInvitesTable)
    .values({
      id: uuid(),
      teamId,
      email,
      tokenHash: hashInviteToken(token),
      invitedByUserId: userId,
      expiresAt,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [teamInvitesTable.teamId, teamInvitesTable.email],
      targetWhere: sql`${teamInvitesTable.acceptedAt} IS NULL`,
      set: { tokenHash: hashInviteToken(token), invitedByUserId: userId, expiresAt, createdAt: now },
    })
    .returning({ id: teamInvitesTable.id });

  const [team] = await db.select({ name: teamsTable.name }).from(teamsTable).where(eq(teamsTable.id, teamId)).limit(1);
  const { githubLogin } = await callerGithubIdentity(userId);
  const acceptUrl = teamInviteUrl(token);
  const emailSent = await send(
    inviteEmailMessage({ to: email, teamName: team?.name ?? 'your team', inviterLogin: githubLogin, acceptUrl })
  );
  return {
    invite: toInvite({ id: saved!.id, teamId, email, expiresAt, createdAt: now, invitedByLogin: githubLogin }),
    emailSent,
    acceptUrl: emailSent ? null : acceptUrl,
  };
}

/** Revoke a pending invite. Its link stops working. */
export async function revokeEmailInvite(teamId: string, userId: string, inviteId: string): Promise<void> {
  await assertTeamManager(teamId, userId);
  const deleted = await getPoolDbClient()
    .delete(teamInvitesTable)
    .where(
      and(eq(teamInvitesTable.teamId, teamId), eq(teamInvitesTable.id, inviteId), isNull(teamInvitesTable.acceptedAt))
    )
    .returning({ id: teamInvitesTable.id });
  if (deleted.length === 0) throw new TeamError(404, 'Invite not found');
}

function validToken(token: unknown): string {
  if (typeof token !== 'string' || token.length < 16 || token.length > 200) throw new TeamError(404, INVALID_LINK);
  return token;
}

/** The team behind a link, for the invitee to read before accepting. */
export async function previewEmailInvite(rawToken: unknown, userId: string): Promise<TeamInvitePreview> {
  const token = validToken(rawToken);
  const [row] = await getPoolDbClient()
    .select({
      teamId: teamInvitesTable.teamId,
      teamName: teamsTable.name,
      email: teamInvitesTable.email,
      expiresAt: teamInvitesTable.expiresAt,
      invitedByLogin: usersTable.githubUsername,
    })
    .from(teamInvitesTable)
    .innerJoin(teamsTable, eq(teamsTable.id, teamInvitesTable.teamId))
    .leftJoin(usersTable, eq(usersTable.id, teamInvitesTable.invitedByUserId))
    .where(
      and(
        eq(teamInvitesTable.tokenHash, hashInviteToken(token)),
        isNull(teamInvitesTable.acceptedAt),
        gt(teamInvitesTable.expiresAt, new Date())
      )
    )
    .limit(1);
  if (!row) throw new TeamError(404, INVALID_LINK);
  const { githubUserId } = await callerGithubIdentity(userId);
  const [mine] = await getPoolDbClient()
    .select({ id: teamMembersTable.id })
    .from(teamMembersTable)
    .where(and(eq(teamMembersTable.teamId, row.teamId), mineCondition(userId, githubUserId)))
    .limit(1);
  return {
    teamId: row.teamId,
    teamName: row.teamName,
    invitedByLogin: row.invitedByLogin,
    email: row.email,
    expiresAt: row.expiresAt.toISOString(),
    alreadyMember: Boolean(mine),
  };
}

/**
 * Accept a link as the signed-in caller: use up the invite and add their
 * GitHub account as a member. A caller who is already a member keeps their
 * row and role.
 */
export async function acceptEmailInvite(rawToken: unknown, userId: string): Promise<SpacesTeam> {
  const token = validToken(rawToken);
  const { githubUserId, githubLogin } = await callerGithubIdentity(userId);
  if (githubUserId === null || !githubLogin) {
    throw new TeamError(
      409,
      'Talyn does not know your GitHub account yet. Sign out and sign in again with GitHub, then try again.'
    );
  }
  const db = getPoolDbClient();
  const [home] = await db
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(eq(workspacesTable.ownerId, userId))
    .orderBy(asc(workspacesTable.createdAt), asc(workspacesTable.id))
    .limit(1);
  const now = new Date();
  const teamId = await db.transaction(async (tx) => {
    // The conditional update is the claim: two accepts of one link cannot both win.
    const [invite] = await tx
      .update(teamInvitesTable)
      .set({ acceptedAt: now, acceptedByUserId: userId })
      .where(
        and(
          eq(teamInvitesTable.tokenHash, hashInviteToken(token)),
          isNull(teamInvitesTable.acceptedAt),
          gt(teamInvitesTable.expiresAt, now)
        )
      )
      .returning({ teamId: teamInvitesTable.teamId, invitedByUserId: teamInvitesTable.invitedByUserId });
    if (!invite) throw new TeamError(404, INVALID_LINK);
    await tx
      .insert(teamMembersTable)
      .values({
        id: uuid(),
        teamId: invite.teamId,
        githubUserId,
        userId,
        githubLogin,
        avatarUrl: githubAvatarUrl(githubUserId),
        role: 'member',
        source: 'invite',
        homeWorkspaceId: home?.id ?? null,
        invitedByUserId: invite.invitedByUserId,
      })
      .onConflictDoNothing({ target: [teamMembersTable.teamId, teamMembersTable.githubUserId] });
    return invite.teamId;
  });
  const team = (await listMyTeams(userId)).find((t) => t.id === teamId);
  if (!team) {
    // Another Talyn account with the same GitHub id already holds the membership.
    throw new TeamError(409, 'Another Talyn account with your GitHub account is already in this team.');
  }
  return team;
}
