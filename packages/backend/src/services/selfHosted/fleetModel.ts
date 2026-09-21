// Which fleet model a workspace runs, read from its settings.
//
// One home for the two questions, because they are asked from opposite ends of
// the system and used to be answerable only inside the executor:
//
//   - the DISPATCH ladder asks "what does this workspace run by default"
//     (`workspaceFleetModel`, vendor included, may be absent), and
//   - anything that has already decided WHICH AGENT asks "so what model"
//     (`workspaceAgentModel`, which always answers).
//
// The second one is the quota failover's question, and it had no way to ask it:
// both swap paths reached for `defaultFleetModelForAgent`, so a workspace that
// had picked a Codex model watched every failover run the shipped default
// instead. See `fleetModelForAgent` in `@talyn/shared` for the read itself —
// it is vendor-checked, so an entry filed under the wrong agent is never handed
// to an agent that cannot run it.

import { eq, sql } from 'drizzle-orm';
import {
  fleetModelForAgent,
  isStoredFleetModelId,
  type FleetAgent,
  type WorkspaceSettings,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { workspaces as workspacesTable } from '../../db/schema.js';

/**
 * The workspace's choice for ONE agent, or that agent's shipped default.
 *
 * Always answers, which is what makes it usable as the bottom of the dispatch
 * ladder and as the model for an agent swap.
 */
export async function workspaceAgentModel(
  workspaceId: string,
  agent: FleetAgent
): Promise<string> {
  const db = getDbClient();
  const [row] = await db
    .select({ settings: workspacesTable.settings })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return fleetModelForAgent(row?.settings as WorkspaceSettings | null, agent);
}

/**
 * The workspace's Settings → Talyn Fleet model choice, or undefined when unset
 * or unrecognised. Extracted in SQL so the settings jsonb never ships.
 *
 * An unrecognised value falls through to the caller's next source rather than
 * to the default: a workspace that pinned a model the picker no longer offers
 * should keep whatever its environment says, not be quietly moved.
 */
export async function workspaceFleetModel(workspaceId: string): Promise<string | undefined> {
  const db = getDbClient();
  const [row] = await db
    .select({ model: sql<string | null>`${workspacesTable.settings} ->> 'fleetModel'` })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return isStoredFleetModelId(row?.model) ? row.model : undefined;
}
