import { eq, sql } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import { workspaces } from '../../db/schema.js';

/** Read the workspace choice for Claude Code's commit attribution. */
export async function claudeCoAuthoredBySetting(workspaceId: string): Promise<boolean> {
  const [row] = await getPoolDbClient()
    .select({ value: sql<string | null>`${workspaces.settings} ->> 'claudeCoAuthoredBy'` })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (row?.value === 'true') return true;
  if (row?.value === 'false') return false;
  return true;
}
