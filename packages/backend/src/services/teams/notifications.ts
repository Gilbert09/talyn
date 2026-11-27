import { and, eq, inArray } from 'drizzle-orm';
import { MOBILE_NOTIFICATION_CATEGORIES, type MobileNotificationCategory, type MobileNotificationDestination,
  type SpaceNotificationPreferences, type SpacePhoneNotificationCategories } from '@talyn/shared';
import { z } from 'zod';
import { getPoolDbClient, type Database } from '../../db/client.js';
import { spaceNotificationMutes as mutesTable, spacePhoneNotificationPreferences as phoneTable,
  tasks as tasksTable, users as usersTable, workbenches as workbenchesTable, workspaces as workspacesTable } from '../../db/schema.js';
import { TeamError } from '../billing/teams.js';
import { isFeatureEnabled } from '../featureFlags.js';
import { assertSpaceMember } from './access.js';

export async function readSpaceNotificationPreferences(userId: string): Promise<SpaceNotificationPreferences> {
  const db = getPoolDbClient();
  const [mutes, phone] = await Promise.all([
    db.select({ spaceId: mutesTable.spaceId }).from(mutesTable).where(eq(mutesTable.userId, userId)),
    db.select({ spaceId: phoneTable.spaceId, categories: phoneTable.categories }).from(phoneTable).where(eq(phoneTable.userId, userId)),
  ]);
  return {
    mutedSpaceIds: mutes.map((row) => row.spaceId).sort(),
    ...(phone.length ? { phoneCategoriesBySpace: Object.fromEntries(phone.map((row) => [row.spaceId, row.categories])) } : {}),
  };
}

export async function setSpaceNotificationsMuted(
  userId: string,
  spaceId: string,
  muted: unknown
): Promise<SpaceNotificationPreferences> {
  if (typeof muted !== 'boolean') throw new TeamError(400, 'muted must be true or false.');
  const db = getPoolDbClient();
  if (muted) {
    await assertSpaceMember(userId, spaceId);
    await db.insert(mutesTable).values({ userId, spaceId }).onConflictDoNothing();
  } else {
    // People can remove their own preference after they leave a team.
    await db.delete(mutesTable).where(and(eq(mutesTable.userId, userId), eq(mutesTable.spaceId, spaceId)));
  }
  return readSpaceNotificationPreferences(userId);
}

const phoneCategoriesInput = z.record(z.enum(MOBILE_NOTIFICATION_CATEGORIES), z.boolean());

export async function setSpacePhoneNotificationCategories(
  userId: string,
  spaceId: string,
  input: unknown
): Promise<SpaceNotificationPreferences> {
  const parsed = phoneCategoriesInput.safeParse(input);
  if (!parsed.success) throw new TeamError(400, 'Use a supported phone alert type and a boolean value.');
  const db = getPoolDbClient();
  const categories: SpacePhoneNotificationCategories = parsed.data;
  if (Object.keys(categories).length) {
    await assertSpaceMember(userId, spaceId);
    await db.insert(phoneTable).values({ userId, spaceId, categories })
      .onConflictDoUpdate({ target: [phoneTable.userId, phoneTable.spaceId], set: { categories } });
  } else {
    await db.delete(phoneTable).where(and(eq(phoneTable.userId, userId), eq(phoneTable.spaceId, spaceId)));
  }
  return readSpaceNotificationPreferences(userId);
}

async function destinationSpaceIds(destination: MobileNotificationDestination, db: Database) {
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
  return [...new Set(rows.map((row) => row.spaceId))];
}

async function mutedSpaceIds(ownerId: string, spaceIds: string[], db: Database) {
  const rows = await db
    .select({ spaceId: mutesTable.spaceId })
    .from(mutesTable)
    .where(and(eq(mutesTable.userId, ownerId), inArray(mutesTable.spaceId, spaceIds)));
  return new Set(rows.map((row) => row.spaceId));
}

async function canUseSpacePreferences(ownerId: string, db: Database) {
  const [owner] = await db.select({ email: usersTable.email }).from(usersTable)
    .where(eq(usersTable.id, ownerId)).limit(1);
  return !!owner && isFeatureEnabled('spaces', { distinctId: ownerId, email: owner.email });
}

/** A PR stays audible if any linked session or task belongs to Personal or an unmuted space. */
export async function destinationInMutedSpace(
  ownerId: string,
  destination: MobileNotificationDestination,
  db: Database = getPoolDbClient()
): Promise<boolean> {
  const ids = await destinationSpaceIds(destination, db);
  if (!ids.length || ids.some((id) => id === null)) return false;
  const muted = await mutedSpaceIds(ownerId, ids as string[], db);
  return muted.size === ids.length && canUseSpacePreferences(ownerId, db);
}

export async function mobileSpaceNotificationSuppression(
  ownerId: string,
  destination: MobileNotificationDestination,
  category: MobileNotificationCategory,
  workspaceDefault: boolean,
  db: Database
): Promise<'space_muted' | 'preferences_disabled' | null> {
  const fallback = workspaceDefault ? null : 'preferences_disabled';
  const ids = await destinationSpaceIds(destination, db);
  if (workspaceDefault && ids.includes(null)) return null;
  const spaceIds = ids.filter((id): id is string => id !== null);
  if (!spaceIds.length) return fallback;

  const [muted, phone] = await Promise.all([
    mutedSpaceIds(ownerId, spaceIds, db),
    db.select({ spaceId: phoneTable.spaceId, categories: phoneTable.categories }).from(phoneTable)
      .where(and(eq(phoneTable.userId, ownerId), inArray(phoneTable.spaceId, spaceIds))),
  ]);
  if (!muted.size && !phone.length) return fallback;
  if (!await canUseSpacePreferences(ownerId, db)) return fallback;

  const overrides = new Map(phone.map((row) => [row.spaceId, row.categories]));
  for (const id of spaceIds) {
    if (!muted.has(id) && (overrides.get(id)?.[category] ?? workspaceDefault)) return null;
  }
  return muted.size === ids.length ? 'space_muted' : 'preferences_disabled';
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
