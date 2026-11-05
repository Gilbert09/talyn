import { eq, sql } from 'drizzle-orm';
import { fleetProviderForModel, type FleetAgent } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { workbenches } from '../../db/schema.js';
import { WorkbenchError } from './errors.js';
import type { WorkbenchRow } from './store.js';

export function validateAgentModel(agent: string, model: unknown): void {
  if (typeof model !== 'string' || !model.trim()) return;
  if (fleetProviderForModel(model.trim()) !== (agent === 'codex' ? 'openai' : 'anthropic')) {
    throw new WorkbenchError('The model must match this chat\'s agent.', 400, 'model_wrong_agent');
  }
}

/** Keep the allowed agents for each box. A move can have two boxes at once. */
export async function recordSandboxAgents(row: WorkbenchRow, sandboxId: string, agents: FleetAgent[]): Promise<void> {
  await getPoolDbClient().update(workbenches).set({
    settings: sql`COALESCE(${workbenches.settings}, '{}'::jsonb) || jsonb_build_object(
      'sandboxAgents', COALESCE(${workbenches.settings}->'sandboxAgents', '{}'::jsonb) ||
      jsonb_build_object(${sandboxId}::text, ${JSON.stringify(agents)}::jsonb))`,
  }).where(eq(workbenches.id, row.id));
  const settings = row.settings as Record<string, unknown>;
  row.settings = { ...settings, sandboxAgents: { ...(settings?.sandboxAgents as object), [sandboxId]: agents } } as WorkbenchRow['settings'];
}

export function sandboxAgents(row: WorkbenchRow, sandboxId = row.sandboxId): FleetAgent[] {
  const saved = (row.settings as Record<string, unknown> | null)?.sandboxAgents as Record<string, FleetAgent[]> | undefined;
  return (sandboxId && saved?.[sandboxId]) || [row.agent === 'codex' ? 'codex' : 'claude'];
}

export function assertSandboxAgent(row: WorkbenchRow, agent: FleetAgent): void {
  const allowed = sandboxAgents(row);
  if (allowed.includes(agent)) return;
  const original = allowed.includes('codex') ? 'Codex' : 'Claude';
  const requested = agent === 'codex' ? 'Codex' : 'Claude';
  throw new WorkbenchError(
    `This session's sandbox was started for ${original}. Start a new session to use ${requested}, or switch this chat back to ${original}.`,
    409,
    'sandbox_wrong_agent',
  );
}
