import { isSandboxSize, SANDBOX_SIZES, SANDBOX_SIZE_SETTINGS, type SandboxSize } from '@talyn/shared';
import { runWithoutScope } from '../../db/client.js';
import { settleBranchNaming } from './branchName.js';
import { emitWorkbenchEvents } from './emit.js';
import { localRuntimeError, WorkbenchError } from './errors.js';
import { moveWorkbenchToFreshSandbox } from './move.js';
import { fleetClientFor, recordWorkbenchEvent } from './sandboxRuntime.js';
import { mergeSandboxSize } from './sandboxSize.js';
import {
  appendEvents,
  clearPendingResize,
  getWorkbench,
  isThread,
  listChats,
  otherRunningChats,
  setPendingResize,
  type WorkbenchRow,
} from './store.js';

/**
 * Resizing a session: an agent (or a person) asks for a box of another size.
 * The fleet cannot change a running box's memory or CPUs, so a resize is a
 * MOVE to a new box of that size (`move.ts`), with the same guarantees: the
 * work carries over and the old box is deleted only after the row names the
 * new one.
 *
 * It never cuts a running turn. The request is stored on the row
 * (`settings.resizeTo`) and applied by whichever comes first: the end of the
 * running turn, the next turn start, or at once when no turn runs. Every new
 * box of the session gets the size from then on (`settings.sandboxSize`).
 *
 * A resize is tried ONCE. A refusal (the tenant's limit) or a failed move
 * clears the request and tells the person why; a session busy with another
 * chat keeps it for the next turn start.
 */

/**
 * The longest reason kept. It sits in `workbenches.settings`, which every
 * workbench read ships, and goes into a one-line transcript note.
 */
export const RESIZE_REASON_MAX_CHARS = 500;

export type ResizeOutcome = 'unchanged' | 'after_turn' | 'moving';

export interface SessionResizeResult {
  outcome: ResizeOutcome;
  size: SandboxSize;
  rememberedForRepository: boolean;
  /** A `continueWith` message went to the session's chat. */
  continued: boolean;
}

export interface ResizeInput {
  size?: unknown;
  reason?: unknown;
  rememberForRepository?: unknown;
}

/** The resize waiting on this row, or null. */
export function pendingResize(row: Pick<WorkbenchRow, 'settings'>): SandboxSize | null {
  const size = row.settings?.resizeTo;
  return isSandboxSize(size) ? size : null;
}

function sizeForMemMib(memMib: number | undefined): SandboxSize | null {
  if (!memMib) return null;
  return (Object.keys(SANDBOX_SIZES) as SandboxSize[]).find((size) => SANDBOX_SIZES[size].memMib === memMib) ?? null;
}

/** The size the box booted at, from the fleet. One read that does not wake it. Null when unknown. */
async function currentBoxSize(row: WorkbenchRow): Promise<SandboxSize | null> {
  if (!row.sandboxId) return null;
  try {
    const client = await fleetClientFor(row.workspaceId, row.fleetHost);
    return sizeForMemMib((await client.getSandbox(row.sandboxId)).sandbox.memMib);
  } catch {
    return null;
  }
}

function validate(row: WorkbenchRow, input: ResizeInput): { size: SandboxSize; reason: string | null; remember: boolean } {
  if (row.runtime !== 'sandbox') throw localRuntimeError();
  if (isThread(row)) {
    throw new WorkbenchError('A thread runs only the agent, on the smallest sandbox. Resize one of its sessions.', 409, 'thread_resize');
  }
  if (row.archivedAt) throw new WorkbenchError('This session is archived. Restore it before you resize it.', 409, 'archived');
  if (!isSandboxSize(input.size)) {
    const sizes = SANDBOX_SIZE_SETTINGS.filter((s) => s !== 'auto').join(', ');
    throw new WorkbenchError(`size must be one of ${sizes}.`, 400, 'bad_size');
  }
  if (input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string') {
    throw new WorkbenchError('reason must be a string.', 400, 'bad_reason');
  }
  const reason = typeof input.reason === 'string' ? input.reason.replace(/\s+/g, ' ').trim() : '';
  if (reason.length > RESIZE_REASON_MAX_CHARS) {
    throw new WorkbenchError(`reason must be at most ${RESIZE_REASON_MAX_CHARS} characters. Give it in one sentence.`, 400, 'bad_reason');
  }
  if (input.rememberForRepository !== undefined && typeof input.rememberForRepository !== 'boolean') {
    throw new WorkbenchError('rememberForRepository must be a boolean.', 400, 'bad_remember');
  }
  return { size: input.size, reason: reason || null, remember: input.rememberForRepository === true };
}

/**
 * Store a resize and start it when nothing runs. `startNow: false` leaves it
 * for the next turn start, for a caller that is about to start that turn.
 */
export async function requestSessionResize(
  row: WorkbenchRow,
  input: ResizeInput,
  opts: { startNow?: boolean } = {},
): Promise<Omit<SessionResizeResult, 'continued'>> {
  const { size, reason, remember } = validate(row, input);
  let rememberedForRepository = false;
  if (remember && row.repositoryId) {
    await mergeSandboxSize(row.repositoryId, { sandboxSize: size });
    rememberedForRepository = true;
  }
  const pending = pendingResize(row);
  if ((await currentBoxSize(row)) === size) {
    // Already this size: a different resize that waited is no longer wanted.
    if (pending) await clearPendingResize(row.id, pending);
    recordWorkbenchEvent(row, 'resize_unchanged', size);
    return { outcome: 'unchanged', size, rememberedForRepository };
  }
  const updated = (await setPendingResize(row.id, size, reason)) ?? row;
  recordWorkbenchEvent(row, 'resize_requested', `${size}${reason ? `: ${reason}` : ''}`);
  const idle = opts.startNow !== false
    && updated.status === 'ready'
    && !!updated.sandboxId
    && (await otherRunningChats(row.id)) === 0;
  if (!idle) return { outcome: 'after_turn', size, rememberedForRepository };
  void runWithoutScope(() => applyPendingResize(updated)).catch((err) =>
    console.warn(`[workbench] resizing ${row.id} crashed:`, err),
  );
  return { outcome: 'moving', size, rememberedForRepository };
}

/** Tell each open chat of the session. */
async function noteChats(row: Pick<WorkbenchRow, 'id'>, subtype: string, text: string): Promise<void> {
  for (const chat of await listChats(row.id)) {
    if (chat.closedAt) continue;
    const stored = await appendEvents(chat.id, [{ turn: chat.turnCount, event: { type: 'system', subtype, text } }]);
    emitWorkbenchEvents(chat.workspaceId, chat.id, stored);
  }
}

export function resizeFailedNote(size: SandboxSize, why: string | undefined): string {
  const reason = (why ?? 'the move failed').trim().replace(/[.\s]+$/, '');
  return `Talyn did not move this session to a ${SANDBOX_SIZES[size].label} sandbox: ${reason}. It stays on its current sandbox.`;
}

/**
 * Apply a waiting resize by moving the session. Returns the row to go on
 * with: the new box's when it moved, else the current one. The move's own
 * note tells the person; a failure posts one here.
 */
export async function applyPendingResize(given: WorkbenchRow, opts: { ownerChatId?: string } = {}): Promise<WorkbenchRow> {
  if (!pendingResize(given)) return given;
  // A branch rename after the export would not reach the new box.
  await settleBranchNaming(given.id);
  const row = (await getWorkbench(given.id)) ?? given;
  const size = pendingResize(row);
  if (!size || row.archivedAt || row.runtime !== 'sandbox' || isThread(row) || row.status !== 'ready' || !row.sandboxId) {
    return row;
  }
  const result = await moveWorkbenchToFreshSandbox(row, 'resize', { ownerChatId: opts.ownerChatId });
  if (result.moved) return result.row;
  // Another chat is running: the next turn start tries again.
  if (result.reason === 'busy') return row;
  await clearPendingResize(row.id, size).catch(() => null);
  if (result.reason !== 'not_applicable') {
    recordWorkbenchEvent(row, 'resize_failed', `${size}: ${result.message ?? result.reason}`, false);
    await noteChats(row, 'sandbox_resize_failed', resizeFailedNote(size, result.message)).catch(() => undefined);
  }
  return (await getWorkbench(row.id)) ?? row;
}
