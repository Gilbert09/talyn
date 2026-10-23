import { runWithoutScope } from '../../db/client.js';
import { FleetRunNotFoundError } from '../selfHosted/client.js';
import { emitWorkbenchChat, emitWorkbenchEvents, emitWorkbenchUpdated } from './emit.js';
import { publicWorkbench } from './prLink.js';
import { recordWorkbenchEvent, sandboxGeneration, sandboxIdFor } from './sandboxRuntime.js';
import { appendEvents, claimLostWorkbench, clearAgentSessions, failLostWorkbench, listChats, rowToChat, type WorkbenchRow } from './store.js';

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
    const replacementId = sandboxIdFor(row.id, sandboxGeneration(row.sandboxId) + 1);
    const claimed = await claimLostWorkbench(row.id, row.sandboxId!, replacementId, SANDBOX_LOST_MESSAGE);
    if (!claimed) return;
    attempts.set(row.id, now);
    try {
      recordWorkbenchEvent(claimed, 'sandbox_lost', `sandbox ${row.sandboxId} was lost`, false);
      await emitWorkbenchUpdated(await publicWorkbench(claimed));
      for (const chat of await clearAgentSessions(row.id)) emitWorkbenchChat(chat.workspaceId, rowToChat(chat));
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

/** Record the data loss after the new branch checkout is ready. */
export async function recordRecoveredTranscript(row: WorkbenchRow): Promise<void> {
  for (const chat of await listChats(row.id)) {
    const stored = await appendEvents(chat.id, [{
      turn: chat.turnCount,
      event: { type: 'system', subtype: 'sandbox_recovered', text: SANDBOX_RESTORED_NOTE },
    }]);
    emitWorkbenchEvents(chat.workspaceId, chat.id, stored);
  }
}
