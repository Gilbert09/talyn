import { and, asc, eq, inArray, ne, or } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type {
  SlackInstallationView,
  SlackStatus,
  SlackUserLinkView,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import {
  slackInstallations,
  slackUserLinks,
  workspaces as workspacesTable,
} from '../../db/schema.js';

/**
 * Reads and writes for the Slack tables that are not about tokens.
 *
 * Everything is on the POOL: the tables are backend-only (no talyn_backend
 * grant), and the routes run before ownerScope. Authorisation is explicit in
 * each function that takes a `userId`.
 */

/** The caller's first workspace: where sessions go when nothing else is chosen. */
export async function firstWorkspaceOf(userId: string): Promise<string | null> {
  const rows = await getPoolDbClient()
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(eq(workspacesTable.ownerId, userId))
    .orderBy(asc(workspacesTable.createdAt), asc(workspacesTable.id))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function installationExists(teamId: string): Promise<boolean> {
  const rows = await getPoolDbClient()
    .select({ teamId: slackInstallations.teamId })
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, teamId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Link a VERIFIED Slack identity to a Talyn user. Callers pass ids that came
 * from Slack over TLS (an OAuth response), never from a client.
 *
 * - The same identity re-linked by the same user keeps its emojis and workspace.
 * - An identity linked to ANOTHER Talyn user moves to this one, with its
 *   settings reset: the person who just proved control of it decides.
 * - The user's older identity in the same team is replaced (one per team).
 */
export async function linkSlackIdentity(input: {
  teamId: string;
  slackUserId: string;
  userId: string;
  workspaceId: string | null;
}): Promise<string> {
  const now = new Date();
  return getPoolDbClient().transaction(async (tx) => {
    await tx
      .delete(slackUserLinks)
      .where(
        and(
          eq(slackUserLinks.teamId, input.teamId),
          eq(slackUserLinks.userId, input.userId),
          ne(slackUserLinks.slackUserId, input.slackUserId)
        )
      );
    const existing = await tx
      .select({ id: slackUserLinks.id, userId: slackUserLinks.userId })
      .from(slackUserLinks)
      .where(
        and(eq(slackUserLinks.teamId, input.teamId), eq(slackUserLinks.slackUserId, input.slackUserId))
      )
      .limit(1);
    const row = existing[0];
    if (row && row.userId === input.userId) {
      await tx.update(slackUserLinks).set({ updatedAt: now }).where(eq(slackUserLinks.id, row.id));
      return row.id;
    }
    if (row) {
      await tx
        .update(slackUserLinks)
        .set({ userId: input.userId, workspaceId: input.workspaceId, triggerEmojis: [], updatedAt: now })
        .where(eq(slackUserLinks.id, row.id));
      return row.id;
    }
    const id = uuid();
    await tx.insert(slackUserLinks).values({
      id,
      teamId: input.teamId,
      slackUserId: input.slackUserId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      triggerEmojis: [],
      createdAt: now,
      updatedAt: now,
    });
    return id;
  });
}

/** `GET /slack`: the teams the caller installed or is linked in, and the caller's links. */
export async function slackStatusFor(userId: string): Promise<SlackStatus> {
  const db = getPoolDbClient();
  const links = await db
    .select({
      id: slackUserLinks.id,
      teamId: slackUserLinks.teamId,
      slackUserId: slackUserLinks.slackUserId,
      workspaceId: slackUserLinks.workspaceId,
      triggerEmojis: slackUserLinks.triggerEmojis,
      createdAt: slackUserLinks.createdAt,
    })
    .from(slackUserLinks)
    .where(eq(slackUserLinks.userId, userId))
    .orderBy(asc(slackUserLinks.createdAt));
  const linkedTeams = links.map((l) => l.teamId);
  const installs = await db
    .select({
      teamId: slackInstallations.teamId,
      teamName: slackInstallations.teamName,
      teamUrl: slackInstallations.teamUrl,
      botUserId: slackInstallations.botUserId,
      botName: slackInstallations.botName,
      installedByUserId: slackInstallations.installedByUserId,
      tokenError: slackInstallations.tokenError,
      createdAt: slackInstallations.createdAt,
    })
    .from(slackInstallations)
    .where(
      linkedTeams.length > 0
        ? or(eq(slackInstallations.installedByUserId, userId), inArray(slackInstallations.teamId, linkedTeams))
        : eq(slackInstallations.installedByUserId, userId)
    )
    .orderBy(asc(slackInstallations.createdAt));
  const byTeam = new Map(installs.map((i) => [i.teamId, i]));

  const installations: SlackInstallationView[] = installs.map((i) => ({
    teamId: i.teamId,
    teamName: i.teamName,
    teamUrl: i.teamUrl,
    botUserId: i.botUserId,
    botName: i.botName,
    installedByMe: i.installedByUserId === userId,
    needsReinstall: i.tokenError !== null,
    installedAt: i.createdAt.toISOString(),
  }));
  const linkViews: SlackUserLinkView[] = links.map((l) => ({
    id: l.id,
    teamId: l.teamId,
    teamName: byTeam.get(l.teamId)?.teamName ?? null,
    slackUserId: l.slackUserId,
    workspaceId: l.workspaceId,
    triggerEmojis: l.triggerEmojis,
    installed: byTeam.has(l.teamId),
    createdAt: l.createdAt.toISOString(),
  }));
  return { installations, links: linkViews };
}

/** One of the caller's own links, or null (also for someone else's link). */
export async function ownLink(
  userId: string,
  linkId: string
): Promise<{ id: string; teamId: string } | null> {
  const rows = await getPoolDbClient()
    .select({ id: slackUserLinks.id, teamId: slackUserLinks.teamId })
    .from(slackUserLinks)
    .where(and(eq(slackUserLinks.id, linkId), eq(slackUserLinks.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateOwnLink(
  userId: string,
  linkId: string,
  patch: { triggerEmojis?: string[]; workspaceId?: string }
): Promise<boolean> {
  const rows = await getPoolDbClient()
    .update(slackUserLinks)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(slackUserLinks.id, linkId), eq(slackUserLinks.userId, userId)))
    .returning({ id: slackUserLinks.id });
  return rows.length > 0;
}

export async function deleteOwnLink(userId: string, linkId: string): Promise<boolean> {
  const rows = await getPoolDbClient()
    .delete(slackUserLinks)
    .where(and(eq(slackUserLinks.id, linkId), eq(slackUserLinks.userId, userId)))
    .returning({ id: slackUserLinks.id });
  return rows.length > 0;
}

/**
 * Forget a team's bot token. Only its installer may. The links stay, so a
 * reinstall brings them back. Returns 'not_found' for a team the caller cannot
 * see and 'forbidden' for one somebody else installed.
 */
export async function forgetInstallation(
  userId: string,
  teamId: string
): Promise<'ok' | 'not_found' | 'forbidden'> {
  const db = getPoolDbClient();
  const rows = await db
    .select({ installedByUserId: slackInstallations.installedByUserId })
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, teamId))
    .limit(1);
  const row = rows[0];
  if (!row) return 'not_found';
  if (row.installedByUserId !== userId) {
    // Visible to a linked user, so say "not yours" rather than pretend it is absent.
    const linked = await db
      .select({ id: slackUserLinks.id })
      .from(slackUserLinks)
      .where(and(eq(slackUserLinks.teamId, teamId), eq(slackUserLinks.userId, userId)))
      .limit(1);
    return linked.length > 0 ? 'forbidden' : 'not_found';
  }
  await db.delete(slackInstallations).where(eq(slackInstallations.teamId, teamId));
  return 'ok';
}

/** Slack says the app is gone from a team: drop its token and every link in it. */
export async function removeTeam(teamId: string): Promise<void> {
  const db = getPoolDbClient();
  await db.delete(slackInstallations).where(eq(slackInstallations.teamId, teamId));
  await db.delete(slackUserLinks).where(eq(slackUserLinks.teamId, teamId));
}
