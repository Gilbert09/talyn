import { stopSandboxScripts } from './scriptStore.js';
import { runWithoutScope } from '../../db/client.js';
import { FleetHibernationLostError, FleetRunNotFoundError } from '../selfHosted/client.js';
import { restoreAgentSession } from './agentBackups.js';
import { emitWorkbenchChat, emitWorkbenchEvents, emitWorkbenchUpdated } from './emit.js';
import { publicWorkbench } from './prLink.js';
import { fleetClientFor, nextSandboxId, recordWorkbenchEvent } from './sandboxRuntime.js';
import { NO_CHECKPOINT_NOTE } from './workCheckpointScripts.js';
import { meterWorkbenchBoxGone } from './usageMeter.js';
import { appendEvents, claimLostWorkbench, failLostWorkbench, listChats, rowToChat, updateChat, type WorkbenchRow } from './store.js';

export const SANDBOX_LOST_MESSAGE = 'The sandbox was lost. Talyn is starting a new one.';
/** The message when the session ends in `error` after a loss and no replacement is starting. */
export const SANDBOX_LOST_FAILED_MESSAGE = 'The sandbox was lost. Retry to start a new one.';
/** The note when no checkpoint of the work exists. `recoveryWorkNote` writes the others. */
export const SANDBOX_RESTORED_NOTE = NO_CHECKPOINT_NOTE;

const RETRY_WINDOW_MS = 10 * 60_000;
const attempts = new Map<string, number>();
const recovering = new Map<string, Promise<void>>();

/** Tests start every case with no recent loss. */
export function resetLostRecoveryForTests(): void {
  attempts.clear();
}

/**
 * Before replacing a box, ask the fleet whether it is merely asleep. A
 * `suspended` box (in memory, on disk or hibernated to object storage) is
 * kept, with all its work, and it is NOT resumed: recovery also runs from
 * reads and background work, and only a person's action or a prompt may wake
 * a box. The next exec wakes it (the fleet's `ensureRunning`, or `withWake` in
 * sandboxRuntime.ts for a hibernated box), and a hibernated copy that cannot
 * be restored is replaced then. Only a box the fleet reports as gone, retired
 * or terminal is replaced. An answer that cannot be read keeps the old
 * behaviour: the call that failed already said the box is not there.
 */
async function isSuspended(row: WorkbenchRow & { sandboxId: string }): Promise<boolean> {
  try {
    const client = await fleetClientFor(row.workspaceId, row.fleetHost);
    const { sandbox, terminal, retired } = await client.getSandbox(row.sandboxId);
    return !terminal && !retired && sandbox?.status === 'suspended';
  } catch {
    return false;
  }
}

/** Whether the fleet cannot restore the box's hibernated copy. Recovery treats it as a lost box. */
export function isHibernationLost(err: unknown): err is FleetHibernationLostError {
  return err instanceof FleetHibernationLostError;
}

/** The ids of a box to keep after its hibernated copy is lost: Talyn's id and the fleet's own. */
export function keptSandboxIdsFor(row: Pick<WorkbenchRow, 'sandboxId' | 'settings'>): string[] {
  return [row.sandboxId, row.settings?.fleetSandboxId].filter((id): id is string => !!id);
}

/**
 * Start one replacement for the sandbox that answered as lost. A box whose
 * hibernated copy cannot be restored is replaced the same way, but Talyn keeps
 * the old box: an operator can sometimes recover the copy, and an older fleet
 * build sends the same answer for a transient failure.
 */
export async function recoverLostSandbox(row: WorkbenchRow, err: unknown): Promise<void> {
  if (!(err instanceof FleetRunNotFoundError) || !row.sandboxId) return;
  const pending = recovering.get(row.id);
  if (pending) return pending;
  const sandboxId = row.sandboxId;
  const hibernationLost = isHibernationLost(err);
  const work = runWithoutScope(async () => {
    // A failed resume says the hibernated copy is lost, however the record reads.
    if (!hibernationLost && await isSuspended({ ...row, sandboxId })) {
      recordWorkbenchEvent(row, 'sandbox_kept', `sandbox ${sandboxId} was suspended, not lost; kept it asleep`);
      return;
    }
    await stopSandboxScripts(row.id, sandboxId);
    const now = Date.now();
    if (now - (attempts.get(row.id) ?? 0) < RETRY_WINDOW_MS) {
      const failed = await failLostWorkbench(row.id, sandboxId, 'The sandbox was lost again. Retry this session.');
      if (failed) await meterWorkbenchBoxGone(row, sandboxId, 'vanished');
      if (failed) {
        recordWorkbenchEvent(failed, 'sandbox_lost', `sandbox ${sandboxId} was lost again`, false);
        await emitWorkbenchUpdated(await publicWorkbench(failed));
      }
      return;
    }
    const replacementId = nextSandboxId(row);
    const claimed = await claimLostWorkbench(row.id, sandboxId, replacementId, SANDBOX_LOST_MESSAGE, {
      keepSandboxIds: hibernationLost ? keptSandboxIdsFor(row) : undefined,
    });
    if (!claimed) return;
    attempts.set(row.id, now);
    // The replacement opens its own interval when provisioning creates it.
    await meterWorkbenchBoxGone(row, sandboxId, 'vanished');
    try {
      const detail = hibernationLost
        ? `sandbox ${sandboxId} could not be restored from its hibernated copy; kept it for an operator`
        : `sandbox ${sandboxId} was lost`;
      recordWorkbenchEvent(claimed, 'sandbox_lost', detail, false, hibernationLost ? err : undefined);
      await emitWorkbenchUpdated(await publicWorkbench(claimed));
    } finally {
      const { scheduleProvision } = await import('./lifecycle.js');
      scheduleProvision(row.id);
    }
  }).finally(() => recovering.delete(row.id));
  recovering.set(row.id, work);
  await work;
}

export async function withLostRecovery<T>(row: WorkbenchRow, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof FleetRunNotFoundError) await recoverLostSandbox(row, err).catch(() => undefined);
    throw err;
  }
}

export const AGENT_MEMORY_RESTORED_NOTE = "The agent's memory of this conversation was restored.";
export const AGENT_MEMORY_RECAP_NOTE =
  'The agent does not remember this conversation; the first message below gives it a short summary.';

/**
 * Restore each conversation before the new sandbox accepts turns. `workNote`
 * says what came back of the saved work; absent, nothing was saved.
 */
export async function recordRecoveredTranscript(row: WorkbenchRow, archived = false, workNote?: string): Promise<void> {
  for (const chat of await listChats(row.id)) {
    const restored = await restoreAgentSession(row, chat);
    const updated = await updateChat(chat.id, restored
      ? { recapPending: false }
      : { agentSessionId: null, recapPending: true });
    if (updated) emitWorkbenchChat(chat.workspaceId, rowToChat(updated));
    const base = workNote ?? (archived ? 'This session was restored onto a new sandbox.' : SANDBOX_RESTORED_NOTE);
    const text = `${base} ${restored ? AGENT_MEMORY_RESTORED_NOTE : AGENT_MEMORY_RECAP_NOTE}`;
    const stored = await appendEvents(chat.id, [{
      turn: chat.turnCount,
      event: { type: 'system', subtype: archived ? 'sandbox_restored' : 'sandbox_recovered', text },
    }]);
    emitWorkbenchEvents(chat.workspaceId, chat.id, stored);
  }
}
