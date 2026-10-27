import { or, sql } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import { workbenches } from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { listFleetHosts } from '../fleetHosts.js';
import { FleetClient, type FleetSandbox } from '../selfHosted/client.js';
import { fleetApiToken, fleetGatewayToken, fleetPinnedEndpoint } from '../selfHosted/credentials.js';
import { withMaintenanceClaim } from './maintenanceClaim.js';
import { sandboxIdFor, sandboxGeneration } from './sandboxRuntime.js';

export const REAPER_POLLER = 'workbench-sandbox-reaper';
const HOUR = 60 * 60_000;
const COLUMNS = {
  id: workbenches.id, sandboxId: workbenches.sandboxId, archivedAt: workbenches.archivedAt,
  archivePendingAt: workbenches.archivePendingAt, status: workbenches.status,
  moveSandboxId: sql<string | null>`${workbenches.settings} ->> 'moveSandboxId'`,
  fleetSandboxId: sql<string | null>`${workbenches.settings} ->> 'fleetSandboxId'`,
} as const;
type Session = Pick<typeof workbenches.$inferSelect, 'id' | 'sandboxId' | 'archivedAt' | 'archivePendingAt' | 'status'>
  & { moveSandboxId: string | null; fleetSandboxId: string | null };
type Box = Pick<FleetSandbox, 'id' | 'createdAt' | 'lastActivity'>;
const logicalId = (id: string) => id.split('--')[0];

export function orphanReason(box: Box, sessions: Session[], now = Date.now()): string | null {
  if (!box.id.startsWith('talyn-wb-')) return null;
  // Heartbeats can continue on an unused box. Prefer its creation time.
  const age = now - Date.parse(box.createdAt || box.lastActivity || '');
  if (!Number.isFinite(age) || age < HOUR / 2) return null;
  const id = logicalId(box.id);
  if (sessions.some((row) => (!row.archivedAt && (logicalId(row.sandboxId ?? '') === id || row.fleetSandboxId === box.id))
    || (row.status === 'moving' && logicalId(row.moveSandboxId ?? '') === id))) return null;
  const owners = sessions.filter((row) => sandboxIdFor(row.id) === id.replace(/-r\d+$/, '')
    || logicalId(row.sandboxId ?? '') === id || row.fleetSandboxId === box.id);
  if (owners.length === 0) return age >= 24 * HOUR ? 'no session row after 24 hours' : null;
  if (owners.some((row) => row.archivePendingAt || row.status === 'moving')) return null;
  if (owners.every((row) => row.archivedAt)) return 'completed archive';
  if (owners.every((row) => row.archivedAt || (row.sandboxId && sandboxGeneration(logicalId(row.sandboxId)) > sandboxGeneration(id)))) {
    return 'old generation after a move';
  }
  return 'unused generation after an abandoned move';
}

async function tenantClients(): Promise<Array<{ client: FleetClient; gateway: boolean }>> {
  const endpoint = fleetPinnedEndpoint();
  if (endpoint) {
    const token = fleetGatewayToken();
    return token ? [{ client: new FleetClient(endpoint, token), gateway: true }] : [];
  }
  const token = fleetApiToken();
  if (!token) return [];
  return (await listFleetHosts()).filter((host) => host.apiEndpoint).map((host) => ({
    client: new FleetClient(host.apiEndpoint!, token), gateway: false,
  }));
}

export async function reapWorkbenchSandboxes(
  clients = tenantClients,
): Promise<boolean> {
  return withMaintenanceClaim(REAPER_POLLER, async (renew) => {
    const errors: unknown[] = [];
    for (const { client, gateway } of await clients()) {
      await renew();
      let listed;
      try {
        listed = gateway ? await client.listGatewaySandboxes() : await client.listSandboxes();
      } catch (error) {
        errors.push(error);
        continue;
      }
      for (const ref of listed.sandboxes) {
        if (!ref.id.startsWith('talyn-wb-')) continue;
        await renew();
        try {
          const source = gateway ? (await client.getSandbox(ref.id)).sandbox : ref as FleetSandbox;
          const box: Box = { id: source.id, createdAt: source.createdAt, lastActivity: source.lastActivity };
          const id = logicalId(box.id);
          const owner = id.slice('talyn-wb-'.length).replace(/-r\d+$/, '');
          const sessions = await getPoolDbClient().select(COLUMNS).from(workbenches).where(or(
            sql`left(replace(${workbenches.id}, '-', ''), 24) = ${owner}`,
            sql`split_part(${workbenches.sandboxId}, '--', 1) = ${id}`,
            sql`split_part(${workbenches.settings} ->> 'moveSandboxId', '--', 1) = ${id}`,
            sql`${workbenches.settings} ->> 'fleetSandboxId' = ${box.id}`,
          ));
          const reason = orphanReason(box, sessions);
          if (!reason) continue;
          await renew();
          const dryRun = process.env.WORKBENCH_REAPER_DRY_RUN === '1';
          if (!dryRun) await client.deleteSandbox(box.id);
          const summary = `${dryRun ? 'Would delete' : 'Deleted'} ${box.id}: ${reason}`;
          console.log(`[workbench-reaper] ${summary}`);
          debugBus.recordEvent({ service: 'workbenches', action: dryRun ? 'reaper_dry_run' : 'reaper_delete', summary, ok: true });
        } catch (error) {
          errors.push(error);
          debugBus.recordEvent({ service: 'workbenches', action: 'reaper_error', summary: `Could not reap ${ref.id}`, ok: false, error });
        }
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Some session sandboxes could not be reaped.');
  });
}
