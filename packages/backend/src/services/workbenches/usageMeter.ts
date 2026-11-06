import { eq, sql } from 'drizzle-orm';
import { isSandboxSize, sandboxSizeForResources, type SandboxSize } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { workbenches } from '../../db/schema.js';
import { meterBoxClosed, meterBoxOpened } from '../billing/usageHooks.js';
import type { EndReason } from '../billing/usage/index.js';
import { openIntervalOfSubjectQuery } from '../billing/usage/intervals.js';
import { fleetInstant, type FleetSandbox } from '../selfHosted/client.js';
import { setWorkbenchSandboxState } from './sandboxState.js';
import { currentBoxPayer, type TurnPayerRef, type WorkbenchRow } from './store.js';

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
 * The box is awake: meter it, and show it as running again if it was asleep.
 *
 * The box bills the payer of its latest turn (Teams and Spaces): `payer`, or
 * when absent, the payer the chats record. When that is not who the open
 * interval bills, the interval closes (`payer_change`) and a new one opens for
 * the new payer. Idle time then bills the new payer until the next turn or a
 * suspend. A null payer is the workspace owner.
 */
export async function meterWorkbenchAwake(
  row: MeterRow & { sandboxId: string | null },
  opts: { size?: SandboxSize; startedAt?: Date; payer?: TurnPayerRef | null } = {},
): Promise<void> {
  if (!row.sandboxId) return;
  const payer = opts.payer !== undefined ? opts.payer : await boxPayer(row.id);
  await closeForPayerChange(row, payer);
  await meterBoxOpened({
    workspaceId: row.workspaceId,
    ...(payer ? { ownerId: payer.userId, payerUserId: payer.userId } : {}),
    subjectKind: 'workbench',
    subjectId: row.id,
    sandboxId: row.sandboxId,
    size: opts.size ?? workbenchBoxSize(row),
    ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
  });
  await setWorkbenchSandboxState({ sandboxId: row.sandboxId }, 'suspended', 'running');
}

/** The box's current payer. A failed read bills the owner, as before payers existed. */
async function boxPayer(workbenchId: string): Promise<TurnPayerRef | null> {
  try {
    return await currentBoxPayer(workbenchId);
  } catch (err) {
    console.warn(`[workbench] reading the payer of ${workbenchId} failed; billing the owner:`, err);
    return null;
  }
}

/** Close the open interval when it bills somebody other than `payer`. Never throws. */
async function closeForPayerChange(row: Pick<WorkbenchRow, 'id' | 'workspaceId'>, payer: TurnPayerRef | null): Promise<void> {
  try {
    const [open] = await openIntervalOfSubjectQuery('workbench', row.id);
    if (!open || (open.payerUserId ?? null) === (payer?.userId ?? null)) return;
    await meterBoxClosed({ sandboxId: open.sandboxId, reason: 'payer_change', workspaceId: row.workspaceId });
  } catch (err) {
    console.warn(`[workbench] moving the meter of ${row.id} to a new payer failed:`, err);
  }
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
  await setWorkbenchSandboxState({ sandboxId: row.sandboxId }, 'running', 'suspended');
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
