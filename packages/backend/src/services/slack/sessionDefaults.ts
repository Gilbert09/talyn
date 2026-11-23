import { and, desc, eq, sql } from 'drizzle-orm';
import {
  defaultFleetModelForAgent,
  storedFleetModelForAgent,
  type WorkbenchAgent,
  type WorkspaceSettings,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { workbenches, workspaces } from '../../db/schema.js';
import { workbenchReadiness, type ReadinessUser } from '../workbenches/readiness.js';

/**
 * The agent and model a session started outside the app runs with: a Slack
 * trigger, or a rule's `start_session` with no model of its own. The
 * composer's agent default is per device, which the backend cannot see, so
 * this takes the agent of the workspace's most recent sandbox session when it
 * can run, else the first agent that can (Claude, then Codex), and the
 * workspace's model for it.
 */
export async function slackSessionDefaults(workspaceId: string, actor: ReadinessUser): Promise<{ agent: WorkbenchAgent; model: string }> {
  const db = getPoolDbClient();
  const [last, ws, readiness] = await Promise.all([
    db
      .select({ agent: workbenches.agent })
      .from(workbenches)
      .where(and(eq(workbenches.workspaceId, workspaceId), eq(workbenches.runtime, 'sandbox')))
      .orderBy(desc(workbenches.createdAt))
      .limit(1),
    db
      .select({
        fleetModels: sql<WorkspaceSettings['fleetModels'] | null>`${workspaces.settings} -> 'fleetModels'`,
        fleetModel: sql<string | null>`${workspaces.settings} ->> 'fleetModel'`,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1),
    workbenchReadiness(workspaceId, actor),
  ]);
  const lastAgent = last[0]?.agent === 'codex' || last[0]?.agent === 'claude' ? (last[0].agent as WorkbenchAgent) : null;
  const order = [...new Set<WorkbenchAgent>([...(lastAgent ? [lastAgent] : []), 'claude', 'codex'])];
  const agent = order.find((a) => readiness.sandbox.agents[a]?.ok) ?? order[0];
  const settings = { fleetModels: ws[0]?.fleetModels ?? undefined, fleetModel: ws[0]?.fleetModel ?? undefined } as WorkspaceSettings;
  return { agent, model: storedFleetModelForAgent(settings, agent) ?? defaultFleetModelForAgent(agent) };
}
