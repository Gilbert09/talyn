import { and, eq, inArray } from 'drizzle-orm';
import type { MobileNotificationDestination, SpaceNotificationPreferences } from '@talyn/shared';
import { getPoolDbClient, type Database } from '../../db/client.js';
import { spaceNotificationMutes as mutesTable, tasks as tasksTable, workbenches as workbenchesTable, workspaces as workspacesTable } from '../../db/schema.js';
import { TeamError } from '../billing/teams.js';
import { assertSpaceMember } from './access.js';

export async function readSpaceNotificationPreferences(userId: string): Promise<SpaceNotificationPreferences> {
  const rows = await getPoolDbClient()
    .select({ spaceId: mutesTable.spaceId })
    .from(mutesTable)
    .where(eq(mutesTable.userId, userId));
  return { mutedSpaceIds: rows.map((r) => r.spaceId).sort() };
}

export async function setSpaceNotificationsMuted(
  userId: string,
  spaceId: string,
  muted: unknown
): Promise<SpaceNotificationPreferences> {
  if (typeof muted !== 'boolean') throw new TeamError(400, 'muted must be true or false.');
  // An archived space may still be muted or unmuted: its sessions keep running.
  await assertSpaceMember(userId, spaceId);
  const db = getPoolDbClient();
  if (muted) {
    await db.insert(mutesTable).values({ userId, spaceId }).onConflictDoNothing();
  } else {
    await db.delete(mutesTable).where(and(eq(mutesTable.userId, userId), eq(mutesTable.spaceId, spaceId)));
  }
  return readSpaceNotificationPreferences(userId);
}

/** A PR stays audible if any linked session or task belongs to Personal or an unmuted space. */
export async function destinationInMutedSpace(
  ownerId: string,
  destination: MobileNotificationDestination,
  db: Database = getPoolDbClient()
): Promise<boolean> {
  const rows = await db
    .select({ spaceId: workbenchesTable.spaceId })
    .from(workbenchesTable)
    .where(
      and(
        eq(workbenchesTable.workspaceId, destination.workspaceId),
        destination.kind === 'pull_request'
          ? eq(workbenchesTable.pullRequestId, destination.entityId)
          : eq(workbenchesTable.id, destination.entityId)
      )
    );
  if (destination.kind === 'pull_request') {
    rows.push(...await db.select({ spaceId: tasksTable.spaceId }).from(tasksTable).where(and(
      eq(tasksTable.workspaceId, destination.workspaceId), eq(tasksTable.pullRequestId, destination.entityId)
    )));
  }
  if (rows.length === 0) return false;
  const spaceIds = rows.map((r) => r.spaceId);
  if (spaceIds.some((id) => id === null)) return false;
  const unique = [...new Set(spaceIds as string[])];
  const muted = await db
    .select({ spaceId: mutesTable.spaceId })
    .from(mutesTable)
    .where(and(eq(mutesTable.userId, ownerId), inArray(mutesTable.spaceId, unique)));
  return muted.length === unique.length;
}

/** PR alerts belong to the workspace owner, just like phone pushes. */
export async function pullRequestNotificationsMuted(workspaceId: string, pullRequestId: string): Promise<boolean> {
  const db = getPoolDbClient();
  const [workspace] = await db.select({ ownerId: workspacesTable.ownerId }).from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId)).limit(1);
  return !!workspace && destinationInMutedSpace(workspace.ownerId, {
    kind: 'pull_request', workspaceId, entityId: pullRequestId,
  }, db);
}
