import { v4 as uuid } from 'uuid';
import { and, eq } from 'drizzle-orm';
import type { CloudProviderType } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { environments as environmentsTable } from '../../db/schema.js';
import { emitEnvironmentCreated } from '../websocket.js';
import { rowToEnvironment } from '../../routes/environments.js';
import { getCloudProvider } from './registry.js';

/**
 * Ensure the user has a secret-free env marker for a cloud provider.
 * Created on first integration connect, marked `connected` immediately
 * (no daemon to pair). Idempotent — at most one marker per (user,
 * provider). The per-workspace credentials live on the `integrations`
 * row; this row only carries the provider `type` so a task assigned to it
 * resolves the right provider.
 */
export async function ensureCloudEnvironment(
  userId: string,
  type: CloudProviderType,
): Promise<void> {
  const db = getDbClient();
  const existing = await db
    .select({ id: environmentsTable.id })
    .from(environmentsTable)
    .where(
      and(
        eq(environmentsTable.ownerId, userId),
        eq(environmentsTable.type, type),
      ),
    )
    .limit(1);
  if (existing[0]) return;

  const now = new Date();
  const row = {
    id: uuid(),
    ownerId: userId,
    name: getCloudProvider(type)?.displayName ?? type,
    type,
    status: 'connected' as const,
    config: { type },
    createdAt: now,
    updatedAt: now,
  };
  const [inserted] = await db.insert(environmentsTable).values(row).returning();

  // Tell the owner's connected clients live so the env appears without an
  // app restart (scoped — other tenants must not see this row).
  emitEnvironmentCreated(userId, rowToEnvironment(inserted ?? (row as typeof inserted)));
}
