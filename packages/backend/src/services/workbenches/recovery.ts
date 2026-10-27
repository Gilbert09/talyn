import { runWithoutScope } from '../../db/client.js';
import { FleetRunNotFoundError } from '../selfHosted/client.js';
import { restoreAgentSession } from './agentBackups.js';
import { emitWorkbenchChat, emitWorkbenchEvents, emitWorkbenchUpdated } from './emit.js';
import { publicWorkbench } from './prLink.js';
import { nextSandboxId, recordWorkbenchEvent } from './sandboxRuntime.js';
import { appendEvents, claimLostWorkbench, failLostWorkbench, listChats, rowToChat, updateChat, type WorkbenchRow } from './store.js';

export const SANDBOX_LOST_MESSAGE = 'The sandbox was lost. Talyn is starting a new one.';
export const SANDBOX_RESTORED_NOTE =
  'The sandbox was lost and Talyn started a new one from the branch on GitHub. Changes that were not pushed are lost.';

const RETRY_WINDOW_MS = 10 * 60_000;
const attempts = new Map<string, number>();
const recovering = new Map<string, Promise<void>>();

/** Start one replacement for the sandbox that answered as lost. */
export async function recoverLostSandbox(row: WorkbenchRow, err: unknown): Promise<void> {
  if (!(err instanceof FleetRunNotFoundError) || !row.sandboxId) return;
  const pending = recovering.get(row.id);
  if (pending) return pending;
  const now = Date.now();
  if (now - (attempts.get(row.id) ?? 0) < RETRY_WINDOW_MS) {
    const failed = await failLostWorkbench(row.id, row.sandboxId, 'The sandbox was lost again. Retry this session.');
    if (failed) {
      recordWorkbenchEvent(failed, 'sandbox_lost', `sandbox ${row.sandboxId} was lost again`, false);
      await emitWorkbenchUpdated(await publicWorkbench(failed));
    }
    return;
  }
  const work = runWithoutScope(async () => {
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

/** Restore each conversation before the new sandbox accepts turns. */
export async function recordRecoveredTranscript(row: WorkbenchRow, archived = false): Promise<void> {
  for (const chat of await listChats(row.id)) {
    const restored = await restoreAgentSession(row, chat);
    const updated = await updateChat(chat.id, restored
      ? { recapPending: false }
      : { agentSessionId: null, recapPending: true });
    if (updated) emitWorkbenchChat(chat.workspaceId, rowToChat(updated));
    const base = archived ? 'This session was restored onto a new sandbox.' : SANDBOX_RESTORED_NOTE;
    const text = `${base} ${restored ? AGENT_MEMORY_RESTORED_NOTE : AGENT_MEMORY_RECAP_NOTE}`;
    const stored = await appendEvents(chat.id, [{
      turn: chat.turnCount,
      event: { type: 'system', subtype: archived ? 'sandbox_restored' : 'sandbox_recovered', text },
    }]);
    emitWorkbenchEvents(chat.workspaceId, chat.id, stored);
  }
}
