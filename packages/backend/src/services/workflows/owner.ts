import { eq } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { workspaces as workspacesTable } from '../../db/schema.js';

/**
 * The workspace's owner, for the plan gates a workflow's actions run behind.
 *
 * Its own module because both the engine and the retry sweep need it, and
 * importing the engine from the sweep would make a cycle: the sweep already
 * imports the actions the engine runs.
 *
 * Owner-keyed rather than caller-keyed for the reason every gate here is — a
 * workflow run has no user attached by construction. It is a webhook delivery,
 * or in the sweep's case a timer.
 */
export async function ownerOfWorkspace(workspaceId: string): Promise<string | null> {
  const rows = await getDbClient()
    .select({ ownerId: workspacesTable.ownerId })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return rows[0]?.ownerId ?? null;
}
