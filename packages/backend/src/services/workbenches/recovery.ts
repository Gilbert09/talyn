import { stopSandboxScripts } from './scriptStore.js';
import { runWithoutScope } from '../../db/client.js';
import { FleetRunNotFoundError } from '../selfHosted/client.js';
import { restoreAgentSession } from './agentBackups.js';
import { emitWorkbenchChat, emitWorkbenchEvents, emitWorkbenchUpdated } from './emit.js';
import { publicWorkbench } from './prLink.js';
import { fleetClientFor, nextSandboxId, recordWorkbenchEvent } from './sandboxRuntime.js';
import { NO_CHECKPOINT_NOTE } from './workCheckpointScripts.js';
import { appendEvents, claimLostWorkbench, failLostWorkbench, listChats, rowToChat, updateChat, type WorkbenchRow } from './store.js';

export const SANDBOX_LOST_MESSAGE = 'The sandbox was lost. Talyn is starting a new one.';
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
 * resumed and kept, with all its work. Only a box the fleet reports as gone,
 * retired or terminal is replaced. An answer that cannot be read keeps the old
 * behaviour: the call that failed already said the box is not there.
 *
 * Exec calls already wake a suspended box (the fleet's `ensureRunning`) and a
 * hibernated one (`withWake` in sandboxRuntime.ts), so this mostly catches a
 * box that went to sleep between the failed call and now.
 */
async function resumeIfSuspended(row: WorkbenchRow & { sandboxId: string }): Promise<boolean> {
  try {
    const client = await fleetClientFor(row.workspaceId, row.fleetHost);
    const { sandbox, terminal, retired } = await client.getSandbox(row.sandboxId);
    if (terminal || retired || sandbox?.status !== 'suspended') return false;
    await client.resumeSandbox(row.sandboxId);
    return true;
  } catch {
    return false;
  }
}

/** Start one replacement for the sandbox that answered as lost. */
export async function recoverLostSandbox(row: WorkbenchRow, err: unknown): Promise<void> {
  if (!(err instanceof FleetRunNotFoundError) || !row.sandboxId) return;
  const pending = recovering.get(row.id);
  if (pending) return pending;
  const sandboxId = row.sandboxId;
  const work = runWithoutScope(async () => {
    if (await resumeIfSuspended({ ...row, sandboxId })) {
      recordWorkbenchEvent(row, 'sandbox_resumed', `sandbox ${sandboxId} was suspended, not lost; resumed it`);
      return;
    }
    await stopSandboxScripts(row.id, sandboxId);
    const now = Date.now();
    if (now - (attempts.get(row.id) ?? 0) < RETRY_WINDOW_MS) {
      const failed = await failLostWorkbench(row.id, sandboxId, 'The sandbox was lost again. Retry this session.');
      if (failed) {
        recordWorkbenchEvent(failed, 'sandbox_lost', `sandbox ${sandboxId} was lost again`, false);
        await emitWorkbenchUpdated(await publicWorkbench(failed));
      }
      return;
    }
    const replacementId = nextSandboxId(row);
    const claimed = await claimLostWorkbench(row.id, row.sandboxId!, replacementId, SANDBOX_LOST_MESSAGE);
    if (!claimed) return;
    attempts.set(row.id, now);
    try {
      recordWorkbenchEvent(claimed, 'sandbox_lost', `sandbox ${row.sandboxId} was lost`, false);
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
