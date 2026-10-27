import { randomUUID } from 'node:crypto';
import { and, eq, ne, or, lt, sql } from 'drizzle-orm';
import type { WorkbenchScriptFrame } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { workbenchScriptRuns as runs } from '../../db/schema.js';
import { TURN_OWNER } from './ownership.js';
import type { WorkbenchRow } from './store.js';

const columns = {
  id: runs.id, sandboxId: runs.sandboxId, workbenchId: runs.workbenchId, workspaceId: runs.workspaceId, name: runs.name,
  sandboxGeneration: runs.sandboxGeneration, generation: runs.generation, owner: runs.owner, heartbeat: runs.heartbeat, offset: runs.offset,
};
export type ScriptLease = { [K in keyof typeof columns]: typeof runs.$inferSelect[K] };
export async function claimScript(row: WorkbenchRow, name: string): Promise<ScriptLease | null> {
  const values = { id: `${row.id}:${name}`, workbenchId: row.id, sandboxId: row.sandboxId!, workspaceId: row.workspaceId, name,
    sandboxGeneration: row.sandboxGeneration ?? row.sandboxId!, generation: randomUUID(), owner: TURN_OWNER, heartbeat: new Date(), offset: 0, output: '', running: true, exitCode: null };
  const [claimed] = await getPoolDbClient().insert(runs).values(values)
    .onConflictDoUpdate({ target: runs.id, set: values, setWhere: or(eq(runs.running, false), ne(runs.sandboxId, row.sandboxId!), sql`coalesce(${runs.sandboxGeneration}, ${runs.sandboxId}) <> ${row.sandboxGeneration ?? row.sandboxId!}`) }).returning(columns);
  return claimed ?? null;
}
function owned(lease: ScriptLease) {
  return and(eq(runs.id, lease.id), eq(runs.generation, lease.generation), eq(runs.owner, TURN_OWNER), eq(runs.running, true));
}
export async function renewScript(lease: ScriptLease): Promise<boolean> {
  const rows = await getPoolDbClient().update(runs).set({ heartbeat: new Date() }).where(owned(lease)).returning({ id: runs.id });
  return rows.length === 1;
}
export async function appendScriptOutput(lease: ScriptLease, data: string, offset: number): Promise<boolean> {
  const rows = await getPoolDbClient().update(runs).set({ output: sql`right(${runs.output} || ${data}, 65536)`, offset })
    .where(and(owned(lease), eq(runs.offset, lease.offset))).returning({ id: runs.id });
  if (rows.length) lease.offset = offset;
  return rows.length === 1;
}
export async function finishScript(lease: ScriptLease, exitCode: number | null): Promise<boolean> {
  const rows = await getPoolDbClient().update(runs).set({ running: false, exitCode }).where(owned(lease)).returning({ id: runs.id });
  return rows.length === 1;
}
export async function staleScripts(): Promise<ScriptLease[]> {
  return getPoolDbClient().select(columns).from(runs).where(and(eq(runs.running, true), lt(runs.heartbeat, new Date(Date.now() - 90_000))));
}
export async function adoptScript(lease: ScriptLease): Promise<boolean> {
  const rows = await getPoolDbClient().update(runs).set({ owner: TURN_OWNER, heartbeat: new Date() })
    .where(and(eq(runs.id, lease.id), eq(runs.generation, lease.generation), eq(runs.owner, lease.owner),
      eq(runs.heartbeat, lease.heartbeat), eq(runs.running, true))).returning({ id: runs.id });
  return rows.length === 1;
}
export async function scriptSnapshots(workbenchId: string): Promise<WorkbenchScriptFrame[]> {
  const rows = await getPoolDbClient().select({ name: runs.name, generation: runs.generation, offset: runs.offset,
    output: runs.output, running: runs.running, exitCode: runs.exitCode }).from(runs).where(eq(runs.workbenchId, workbenchId));
  return rows.map((r) => ({ workbenchId, name: r.name, generation: r.generation, offset: r.offset,
    snapshot: true, data: r.output, stream: 'stdout', running: r.running, exitCode: r.exitCode }));
}
export async function storedScriptNames(workbenchId: string, sandboxId?: string): Promise<string[]> {
  const rows = await getPoolDbClient().select({ name: runs.name }).from(runs).where(and(eq(runs.workbenchId, workbenchId), eq(runs.running, true), sandboxId ? eq(runs.sandboxId, sandboxId) : undefined));
  return rows.map((r) => r.name);
}

export async function stopStoredScript(workbenchId: string, name: string, sandboxId?: string): Promise<void> {
  await getPoolDbClient().update(runs).set({ running: false, exitCode: null })
    .where(and(eq(runs.workbenchId, workbenchId), eq(runs.name, name), eq(runs.running, true), sandboxId ? eq(runs.sandboxId, sandboxId) : undefined));
}
export async function existingScript(workbenchId: string, name: string, sandboxId: string, generation = sandboxId) {
  const [row] = await getPoolDbClient().select({ running: runs.running, exitCode: runs.exitCode })
    .from(runs).where(and(eq(runs.workbenchId, workbenchId), eq(runs.name, name), eq(runs.sandboxId, sandboxId), sql`coalesce(${runs.sandboxGeneration}, ${runs.sandboxId}) = ${generation}`));
  return row ?? null;
}

export async function releaseScript(lease: ScriptLease): Promise<void> {
  await getPoolDbClient().update(runs).set({ heartbeat: new Date(0) }).where(owned(lease));
}
export async function releaseOwnedScripts(): Promise<void> {
  await getPoolDbClient().update(runs).set({ heartbeat: new Date(0) }).where(and(eq(runs.owner, TURN_OWNER), eq(runs.running, true)));
}
export async function stopSandboxScripts(workbenchId: string, sandboxId: string): Promise<void> {
  await getPoolDbClient().update(runs).set({ running: false, exitCode: null })
    .where(and(eq(runs.workbenchId, workbenchId), eq(runs.sandboxId, sandboxId), eq(runs.running, true)));
}
export async function resetSetupForGeneration(row: WorkbenchRow): Promise<void> {
  await getPoolDbClient().delete(runs).where(and(eq(runs.workbenchId, row.id), eq(runs.name, 'setup'),
    sql`coalesce(${runs.sandboxGeneration}, ${runs.sandboxId}) <> ${row.sandboxGeneration ?? row.sandboxId!}`));
}
