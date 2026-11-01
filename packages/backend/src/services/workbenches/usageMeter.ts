import { and, eq, sql } from 'drizzle-orm';
import { isSandboxSize, sandboxSizeForResources, type SandboxSize, type WorkbenchSandboxState } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { workbenches } from '../../db/schema.js';
import { meterBoxClosed, meterBoxOpened } from '../billing/usageHooks.js';
import type { EndReason } from '../billing/usage/index.js';
import { fleetInstant, type FleetSandbox } from '../selfHosted/client.js';
import { emitWorkbenchUpdated } from './emit.js';
import { WORKBENCH_COLUMNS, type WorkbenchRow } from './store.js';

/**
 * The usage meter's view of a session or thread box. A box is billed while it
 * is awake; the fleet suspends it after the idle timeout, and suspended time
 * is free. Every function here is safe to call twice and never throws: the
 * hooks under it log a failure and return.
 */

type MeterRow = Pick<WorkbenchRow, 'id' | 'workspaceId' | 'kind' | 'settings'>;
type SizedSandbox = Pick<FleetSandbox, 'memMib' | 'milliVcpu' | 'vcpuCount'>;

const AWAKE: ReadonlySet<string> = new Set(['starting', 'idle', 'busy']);
const TERMINAL: ReadonlySet<string> = new Set(['stopped', 'failed', 'cancelled']);

/**
 * The size the session's box was created at. `settings.boxSize` is written at
 * every create; a row from before it existed falls back to what the fleet
 * reports, then to the session's choice.
 */
export function workbenchBoxSize(row: Pick<WorkbenchRow, 'kind' | 'settings'>, sandbox?: SizedSandbox | null): SandboxSize {
  const recorded = row.settings?.boxSize;
  if (isSandboxSize(recorded)) return recorded;
  if (sandbox) {
    const milli = sandbox.milliVcpu ?? (sandbox.vcpuCount ? sandbox.vcpuCount * 1000 : null);
    const reported = sandboxSizeForResources(sandbox.memMib, milli);
    if (reported) return reported;
  }
  if (row.kind === 'thread') return 'small';
  return isSandboxSize(row.settings?.sandboxSize) ? row.settings.sandboxSize : 'standard';
}

/**
 * Move `sandbox_state` between `running` and `suspended`, only from the state
 * named. `lost`, `deleted` and `error` are never overwritten.
 */
async function setSandboxState(
  sandboxId: string,
  from: WorkbenchSandboxState,
  to: WorkbenchSandboxState,
): Promise<void> {
  try {
    const [row] = await getPoolDbClient()
      .update(workbenches)
      .set({ sandboxState: to, updatedAt: new Date() })
      .where(and(eq(workbenches.sandboxId, sandboxId), eq(workbenches.sandboxState, from)))
      .returning(WORKBENCH_COLUMNS);
    if (!row) return;
    const { publicWorkbench } = await import('./prLink.js');
    await emitWorkbenchUpdated(await publicWorkbench(row));
  } catch (err) {
    console.warn(`[workbench] recording sandbox ${sandboxId} as ${to} failed:`, err);
  }
}

/** The box is awake: meter it, and show it as running again if it was asleep. */
export async function meterWorkbenchAwake(
  row: MeterRow & { sandboxId: string | null },
  opts: { size?: SandboxSize; startedAt?: Date } = {},
): Promise<void> {
  if (!row.sandboxId) return;
  await meterBoxOpened({
    workspaceId: row.workspaceId,
    subjectKind: 'workbench',
    subjectId: row.id,
    sandboxId: row.sandboxId,
    size: opts.size ?? workbenchBoxSize(row),
    ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
  });
  await setSandboxState(row.sandboxId, 'suspended', 'running');
}

/**
 * The box with this id woke (a resume knows only the id). A box no row names
 * is not a session's, so nothing is metered for it here.
 */
export async function meterWorkbenchAwakeBySandboxId(sandboxId: string): Promise<void> {
  try {
    const [row] = await getPoolDbClient()
      .select({
        id: workbenches.id,
        workspaceId: workbenches.workspaceId,
        kind: workbenches.kind,
        sandboxId: workbenches.sandboxId,
        boxSize: sql<string | null>`${workbenches.settings} ->> 'boxSize'`,
        sandboxSize: sql<string | null>`${workbenches.settings} ->> 'sandboxSize'`,
      })
      .from(workbenches)
      .where(eq(workbenches.sandboxId, sandboxId))
      .limit(1);
    if (!row) return;
    const settings: WorkbenchRow['settings'] = {
      ...(isSandboxSize(row.boxSize) ? { boxSize: row.boxSize } : {}),
      ...(isSandboxSize(row.sandboxSize) ? { sandboxSize: row.sandboxSize } : {}),
    };
    await meterWorkbenchAwake({ ...row, settings });
  } catch (err) {
    console.warn(`[workbench] metering the resumed sandbox ${sandboxId} failed:`, err);
  }
}

/** The box was suspended (by the fleet's idle timeout or by Talyn): stop billing at the suspend time. */
export async function meterWorkbenchSuspended(
  row: Pick<WorkbenchRow, 'workspaceId'> & { sandboxId: string },
  suspendedAt?: Date | null,
): Promise<void> {
  await meterBoxClosed({ sandboxId: row.sandboxId, reason: 'suspended', endedAt: suspendedAt ?? null, workspaceId: row.workspaceId });
  await setSandboxState(row.sandboxId, 'running', 'suspended');
}

/** The box was deleted, lost or replaced. */
export async function meterWorkbenchBoxGone(
  row: Pick<WorkbenchRow, 'workspaceId'>,
  sandboxId: string | null | undefined,
  reason: EndReason = 'deleted',
): Promise<void> {
  if (!sandboxId) return;
  await meterBoxClosed({ sandboxId, reason, workspaceId: row.workspaceId });
}

/**
 * Bring the meter in step with one fresh fleet record of the session's box.
 * The meter sweep calls this for every box it lists; a caller that has just
 * read the box may call it too.
 */
export async function observeWorkbenchSandbox(
  row: MeterRow & { sandboxId: string },
  sandbox: FleetSandbox & { retired?: boolean },
): Promise<void> {
  if (sandbox.retired || TERMINAL.has(sandbox.status)) {
    await meterBoxClosed({
      sandboxId: row.sandboxId,
      reason: 'terminal',
      endedAt: fleetInstant(sandbox.endedAt),
      workspaceId: row.workspaceId,
    });
    return;
  }
  if (sandbox.status === 'suspended') {
    await meterWorkbenchSuspended(row, fleetInstant(sandbox.suspendedAt));
    return;
  }
  if (AWAKE.has(sandbox.status)) await meterWorkbenchAwake(row, { size: workbenchBoxSize(row, sandbox) });
}
