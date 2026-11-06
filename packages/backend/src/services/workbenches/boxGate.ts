import { noteBoxRefusal, releaseBoxHold, workspaceBoxHold } from '../billing/boxDeferral.js';
import type { SandboxSize } from '@talyn/shared';
import { billingEnabled, checkBoxGate, isBoxGateError, type BoxGateError, type BoxGateOptions } from '../billing/entitlements.js';
import { openIntervalOfSubjectQuery } from '../billing/usage/intervals.js';
import { ownerOfWorkspace } from '../workflows/owner.js';
import { sessionSandboxSize, sizeForSession } from './sandboxSize.js';
import type { TurnPayerRef, WorkbenchRow } from './store.js';
import { workbenchBoxSize } from './usageMeter.js';

/**
 * The box gate for sessions and threads. Every path that starts or wakes a
 * workbench box asks here first: create, retry, restore, wake, and each turn
 * start. A person is waiting on every one of them, so a refusal is a
 * {@link BoxGateError} the route answers with a 402 and its notice.
 *
 * A turn already running is never stopped: these checks run before a box
 * starts or wakes, never during a turn. Exhaustion suspends an idle box on
 * its own (the usage meter, and the end of each turn).
 *
 * The concurrency check counts open usage intervals, and a box opens its
 * interval when it boots. So two creates at the same moment can both pass on
 * Free; a lost race costs one box, which is why these use the lock-free
 * {@link checkBoxGate}.
 *
 * Local-runtime sessions run on the person's machine: nothing is gated.
 */

type GateRow = Pick<WorkbenchRow, 'id' | 'workspaceId' | 'runtime' | 'kind' | 'settings' | 'repositoryId'>;

type GateOptions = Omit<BoxGateOptions, 'workspaceId' | 'size'> & { size: SandboxSize | (() => Promise<SandboxSize>) };

async function check(workspaceId: string, options: GateOptions): Promise<void> {
  // Skips the owner read, and any size detection, when nothing is enforced.
  if (!billingEnabled()) return;
  const ownerId = await ownerOfWorkspace(workspaceId);
  if (!ownerId) return;
  const size = typeof options.size === 'function' ? await options.size() : options.size;
  await checkBoxGate(ownerId, { ...options, size, workspaceId });
  releaseBoxHold(ownerId);
}

/** A new session or thread box. `size` may be a thunk: detecting it can read GitHub. */
export async function assertNewWorkbenchBox(
  workspaceId: string,
  size: SandboxSize | (() => Promise<SandboxSize>)
): Promise<void> {
  await check(workspaceId, { size });
}

/** The size a fresh box for this row boots at: the provision path's own rule. */
export async function wantedWorkbenchSize(row: GateRow): Promise<SandboxSize> {
  if (row.kind === 'thread') return workbenchBoxSize(row);
  return sessionSandboxSize(row) ?? (await sizeForSession(row));
}

/** A fresh box for an existing row (retry after a failed start, restore from archive). */
export async function assertWorkbenchBoxStart(row: GateRow): Promise<void> {
  if (row.runtime !== 'sandbox') return;
  await check(row.workspaceId, { size: () => wantedWorkbenchSize(row) });
}

/** Whether the row's box is metered now (an open usage interval). */
async function boxIsAwake(row: Pick<WorkbenchRow, 'id'>): Promise<boolean> {
  const [open] = await openIntervalOfSubjectQuery('workbench', row.id);
  return Boolean(open);
}

/**
 * The refusal for running a turn on, or waking, the row's existing box, or
 * null. Budget always; the concurrency cap only when the box sleeps, because
 * waking it adds a box. The size is not checked again: the box exists.
 */
export async function existingBoxRefusal(
  row: GateRow,
  unattended = false,
  payer: TurnPayerRef | null = null,
): Promise<BoxGateError | null> {
  if (row.runtime !== 'sandbox' || !billingEnabled()) return null;
  if (payer) return payerBoxRefusal(row, unattended, payer);
  if (unattended) {
    const held = await workspaceBoxHold(row.workspaceId);
    if (held) return held;
  }
  try {
    await check(row.workspaceId, {
      unattended,
      size: workbenchBoxSize(row),
      existingBox: (await boxIsAwake(row)) ? 'awake' : 'asleep',
    });
    return null;
  } catch (err) {
    if (isBoxGateError(err)) {
      if (unattended) {
        const owner = await ownerOfWorkspace(row.workspaceId);
        if (owner) noteBoxRefusal(owner, err);
      }
      return err;
    }
    throw err;
  }
}

/**
 * A teammate's turn on the owner's box pays from the teammate's budget, and
 * the owner is not asked. The box exists, so only the budget is checked: the
 * size is not checked again, and the concurrency cap does not apply.
 */
async function payerBoxRefusal(row: GateRow, unattended: boolean, payer: TurnPayerRef): Promise<BoxGateError | null> {
  if (unattended) {
    const held = await workspaceBoxHold(payer.workspaceId);
    if (held) return held;
  }
  try {
    await checkBoxGate(payer.userId, {
      unattended,
      size: workbenchBoxSize(row),
      existingBox: 'awake',
      workspaceId: payer.workspaceId,
    });
    releaseBoxHold(payer.userId);
    return null;
  } catch (err) {
    if (isBoxGateError(err)) {
      if (unattended) noteBoxRefusal(payer.userId, err);
      return err;
    }
    throw err;
  }
}
