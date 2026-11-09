import { runWithoutScope } from '../../db/client.js';
import { settleBranchNaming } from './branchName.js';
import { emitWorkbenchEvents } from './emit.js';
import { localRuntimeError, WorkbenchError } from './errors.js';
import { moveWorkbenchToFreshSandbox } from './move.js';
import { recordWorkbenchEvent } from './sandboxRuntime.js';
import {
  appendEvents,
  clearPendingRestart,
  getWorkbench,
  isThread,
  listChats,
  otherRunningChats,
  setPendingRestart,
  type WorkbenchRow,
} from './store.js';

/**
 * Restarting a session: a MOVE to a fresh box of the same size (`move.ts`).
 *
 * A box gets its MCP servers, private routes and other create-time settings
 * once, when the fleet creates it. The fleet cannot change them on a running
 * box. So a server connected after the box started reaches the session only
 * on a new box. A restart makes that new box, with the same guarantees as a
 * resize: the work carries over, and the old box is deleted only after the row
 * names the new one.
 *
 * It never cuts a running turn. The request is stored on the row
 * (`settings.restartRequestedAt`) and applied by whichever comes first: the
 * end of the running turn, the next turn start, or at once when no turn runs.
 * Any move that claims the row after the request answers it, because that
 * move creates a fresh box too.
 */

export const RESTART_REASON_MAX_CHARS = 500;

export type RestartOutcome = 'after_turn' | 'restarting';

export interface SessionRestartResult {
  outcome: RestartOutcome;
  /** A `continueWith` message went to the session's chat. */
  continued: boolean;
}

export interface RestartInput {
  reason?: unknown;
}

/** The restart waiting on this row, as its request time, or null. */
export function pendingRestart(row: Pick<WorkbenchRow, 'settings'>): string | null {
  const at = row.settings?.restartRequestedAt;
  return typeof at === 'string' && at ? at : null;
}

function validate(row: WorkbenchRow, input: RestartInput): { reason: string | null } {
  if (row.runtime !== 'sandbox') throw localRuntimeError();
  if (isThread(row)) {
    throw new WorkbenchError('A thread has no repository sandbox to restart. Restart one of its sessions.', 409, 'thread_restart');
  }
  if (row.archivedAt) throw new WorkbenchError('This session is archived. Restore it before you restart it.', 409, 'archived');
  if (row.status !== 'ready' || !row.sandboxId) {
    throw new WorkbenchError('This session has no running sandbox to restart. Wait for it to start, or retry it.', 409, 'not_ready');
  }
  if (input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string') {
    throw new WorkbenchError('reason must be a string.', 400, 'bad_reason');
  }
  const reason = typeof input.reason === 'string' ? input.reason.replace(/\s+/g, ' ').trim() : '';
  if (reason.length > RESTART_REASON_MAX_CHARS) {
    throw new WorkbenchError(`reason must be at most ${RESTART_REASON_MAX_CHARS} characters. Give it in one sentence.`, 400, 'bad_reason');
  }
  return { reason: reason || null };
}

/**
 * Store a restart and start it when nothing runs. `startNow: false` leaves it
 * for the next turn start, for a caller that is about to start that turn.
 */
export async function requestSessionRestart(
  row: WorkbenchRow,
  input: RestartInput,
  opts: { startNow?: boolean } = {},
): Promise<Omit<SessionRestartResult, 'continued'>> {
  const { reason } = validate(row, input);
  const updated = (await setPendingRestart(row.id, new Date().toISOString(), reason)) ?? row;
  recordWorkbenchEvent(row, 'restart_requested', reason ?? 'no reason given');
  const idle = opts.startNow !== false
    && updated.status === 'ready'
    && !!updated.sandboxId
    && (await otherRunningChats(row.id)) === 0;
  if (!idle) return { outcome: 'after_turn' };
  void runWithoutScope(() => applyPendingRestart(updated)).catch((err) =>
    console.warn(`[workbench] restarting ${row.id} crashed:`, err),
  );
  return { outcome: 'restarting' };
}

async function noteChats(row: Pick<WorkbenchRow, 'id'>, subtype: string, text: string): Promise<void> {
  for (const chat of await listChats(row.id)) {
    if (chat.closedAt) continue;
    const stored = await appendEvents(chat.id, [{ turn: chat.turnCount, event: { type: 'system', subtype, text } }]);
    emitWorkbenchEvents(chat.workspaceId, chat.id, stored);
  }
}

export function restartFailedNote(why: string | undefined): string {
  const reason = (why ?? 'the move failed').trim().replace(/[.\s]+$/, '');
  return `Talyn did not restart this session on a fresh sandbox: ${reason}. It stays on its current sandbox.`;
}

/**
 * Apply a waiting restart by moving the session. Returns the row to go on
 * with: the new box's when it moved, else the current one. The move's own
 * note tells the person; a failure posts one here.
 */
export async function applyPendingRestart(given: WorkbenchRow, opts: { ownerChatId?: string } = {}): Promise<WorkbenchRow> {
  if (!pendingRestart(given)) return given;
  // A branch rename after the export would not reach the new box.
  await settleBranchNaming(given.id);
  const row = (await getWorkbench(given.id)) ?? given;
  const requestedAt = pendingRestart(row);
  if (!requestedAt || row.archivedAt || row.runtime !== 'sandbox' || isThread(row) || row.status !== 'ready' || !row.sandboxId) {
    return row;
  }
  const result = await moveWorkbenchToFreshSandbox(row, 'restart', { ownerChatId: opts.ownerChatId });
  // The commit cleared the request.
  if (result.moved) return result.row;
  // Another chat is running: the next turn start tries again.
  if (result.reason === 'busy') return row;
  await clearPendingRestart(row.id, requestedAt).catch(() => null);
  if (result.reason !== 'not_applicable') {
    recordWorkbenchEvent(row, 'restart_failed', result.message ?? result.reason, false);
    await noteChats(row, 'sandbox_restart_failed', restartFailedNote(result.message)).catch(() => undefined);
  }
  return (await getWorkbench(row.id)) ?? row;
}
