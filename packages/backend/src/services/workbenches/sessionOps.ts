import type { WorkbenchChanges, WorkbenchConfig, WorkbenchDiffScope, WorkbenchPreviewLink } from '@talyn/shared';
import { runWithoutScope } from '../../db/client.js';
import { mintPreviewTicket } from '../preview/previewLinks.js';
import { previewBaseDomain } from '../preview/previewHost.js';
import { emptyChanges, getChanges, getPatch, listRepoFiles, readRepoFile, storeDiffStat } from './changes.js';
import { readChangesSnapshot } from './changesSnapshot.js';
import { emitWorkbenchChat, emitWorkbenchUpdated } from './emit.js';
import { localRuntimeError, notReadyError, refuseThread, WorkbenchError } from './errors.js';
import { startStaleGoldenMove } from './move.js';
import { publicWorkbench } from './prLink.js';
import { requestSessionResize, type ResizeInput, type SessionResizeResult } from './resize.js';
import { loadWorkbenchConfig, loadWorkbenchConfigWithDetection } from './sandboxRuntime.js';
import { startScript, stopScript } from './scripts.js';
import {
  getWorkbench,
  isThread,
  listChats,
  removeQueuedMessage,
  rowToChat,
  updateChat,
  type ChatRow,
  type WorkbenchRow,
} from './store.js';
import { cancelTurn, endCapacityWait, sendMessage } from './turns.js';
import { noteDiffStatFresh } from './workCheckpoint.js';

/**
 * Session operations that the app's routes (`routes/workbenches.ts`) and the
 * public API (`routes/public/sessionWork.ts`) both call, so the two cannot
 * drift. Each one throws a `WorkbenchError` for a refusal a person can act on.
 */

/**
 * Wait for the session's current sandbox before a read or a change uses its
 * id: a move finishes first (up to three minutes). `checkGolden` also starts a
 * move off a stale golden box. Updates `row` in place.
 */
export async function requireReadySandbox(row: WorkbenchRow, checkGolden = false): Promise<void> {
  if (row.runtime === 'local') throw localRuntimeError();
  if (row.archivedAt) throw notReadyError('archived');
  if (checkGolden) await startStaleGoldenMove(row);
  const deadline = Date.now() + 180_000;
  let current = await getWorkbench(row.id);
  while (current?.status === 'moving' && !current.archivedAt && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    current = await getWorkbench(row.id);
  }
  if (!current) throw new WorkbenchError('Session not found', 404, 'not_found');
  Object.assign(row, current);
  if (row.archivedAt) throw notReadyError('archived');
  if (row.status !== 'ready' || !row.sandboxId) throw notReadyError(row.status);
}

/**
 * The changed files. A box that is not running cannot have changed since the
 * last read, so its stored list answers at once; only `live` wakes it. With
 * no stored list, `wakeWithoutSnapshot` decides: the app wakes the box, the
 * public API refuses with `snapshot_unavailable` so a caller never wakes a box
 * it did not ask to.
 */
export async function readSessionChanges(
  row: WorkbenchRow,
  opts: { live: boolean; wakeWithoutSnapshot: boolean },
): Promise<WorkbenchChanges> {
  // A thread has no repository: nothing changed, and no box needs to wake to say so.
  if (isThread(row)) return emptyChanges();
  if (!opts.live && row.runtime === 'sandbox' && !row.archivedAt && row.sandboxState !== 'running') {
    const snapshot = await readChangesSnapshot(row);
    if (snapshot) return snapshot;
    if (!opts.wakeWithoutSnapshot) {
      throw new WorkbenchError(
        'The sandbox is asleep and Talyn has no stored list of its changes. Ask again with live=true to wake it.',
        409,
        'snapshot_unavailable',
      );
    }
  }
  await requireReadySandbox(row, true);
  const changes = await getChanges(row);
  noteDiffStatFresh(row.id);
  void storeDiffStat(row, changes).catch((err) =>
    console.warn(`[workbench] storing the diff stat for ${row.id} failed:`, err),
  );
  return changes;
}

export async function readSessionDiff(
  row: WorkbenchRow,
  path: string | undefined,
  scope: WorkbenchDiffScope | undefined,
): Promise<{ patch: string }> {
  if (isThread(row)) return { patch: '' };
  await requireReadySandbox(row);
  return getPatch(row, path, scope);
}

export async function readSessionFile(row: WorkbenchRow, path: string): Promise<{ content: string; binary: boolean }> {
  await requireReadySandbox(row);
  return readRepoFile(row, path);
}

export async function listSessionFiles(row: WorkbenchRow): Promise<{ paths: string[] }> {
  if (isThread(row)) return { paths: [] };
  await requireReadySandbox(row, true);
  return listRepoFiles(row);
}

/** The session's script config, read from the box (a thread has none). */
export async function readSessionConfig(row: WorkbenchRow): Promise<WorkbenchConfig> {
  if (isThread(row)) return loadWorkbenchConfig(row);
  await requireReadySandbox(row, true);
  return loadWorkbenchConfigWithDetection(row);
}

export async function startSessionScript(row: WorkbenchRow, name: string): Promise<void> {
  refuseThread(row);
  await requireReadySandbox(row);
  // Detached from the request: the script outlives it, and its follower
  // must not inherit anything request-scoped.
  await runWithoutScope(() => startScript(row, name));
}

export async function stopSessionScript(row: WorkbenchRow, name: string): Promise<void> {
  await requireReadySandbox(row);
  await stopScript(row, name);
}

/** Change a chat's title, model, effort or plan mode. The patch is already checked. */
export async function patchChat(
  chat: ChatRow,
  patch: Partial<Pick<ChatRow, 'title' | 'model' | 'effort' | 'planMode' | 'queuedMessages'>>,
): Promise<ChatRow> {
  const row = (await updateChat(chat.id, patch)) ?? chat;
  emitWorkbenchChat(row.workspaceId, rowToChat(row));
  return row;
}

/** Take one message out of a chat's queue. Null when the chat is gone. */
export async function dropQueuedMessage(chatId: string, messageId: string): Promise<ChatRow | null> {
  // A message that waits for a free sandbox has its turn in the transcript: that turn ends as stopped.
  const waited = await endCapacityWait(chatId, messageId);
  if (waited) return waited;
  const row = await removeQueuedMessage(chatId, messageId);
  if (row) emitWorkbenchChat(row.workspaceId, rowToChat(row));
  return row;
}

/** Empty a chat's queue. A running turn goes on; nothing starts after it. */
export async function clearQueuedMessages(chat: ChatRow): Promise<ChatRow> {
  await endCapacityWait(chat.id);
  return patchChat(chat, { queuedMessages: [] });
}

/** Close a chat tab. A running turn is stopped first; the transcript stays. */
export async function closeChat(chat: ChatRow, workbench: WorkbenchRow): Promise<void> {
  if (workbench.runtime === 'sandbox' && chat.status === 'running') {
    await cancelTurn(chat.id).catch((err) => console.warn('[workbench] cancel on close failed:', err));
  }
  // A local turn runs on the desktop, which may be gone: a closed chat must not stay `running`.
  const stale = workbench.runtime === 'local' && chat.status === 'running';
  await updateChat(chat.id, { closedAt: new Date(), queuedMessages: [], ...(stale ? { status: 'idle' as const } : {}) });
  // The embedded list is how a client learns a chat is gone.
  const updated = await getWorkbench(workbench.id);
  if (updated) await emitWorkbenchUpdated(await publicWorkbench(updated));
}

/**
 * Move the session to a sandbox of another size, after the running turn.
 * `continueWith` goes to the session's chat as a Talyn message, so the next
 * turn starts on the new box; the turn start applies the resize first.
 */
export async function resizeSession(row: WorkbenchRow, input: ResizeInput, continueWith: string): Promise<SessionResizeResult> {
  const result = await requestSessionResize(row, input, { startNow: !continueWith });
  let continued = false;
  if (continueWith && result.outcome !== 'unchanged') {
    const chat = (await listChats(row.id)).find((c) => !c.closedAt);
    if (chat) {
      await sendMessage(chat.id, { text: continueWith }, { origin: 'talyn' });
      continued = true;
    }
  }
  await emitWorkbenchUpdated(await publicWorkbench((await getWorkbench(row.id)) ?? row));
  return { ...result, continued };
}

/**
 * A one-time sign-in link to a port on its own preview host. The port is
 * already checked (1024 to 65535).
 */
export async function createSessionPreviewLink(row: WorkbenchRow, port: number, userId: string): Promise<WorkbenchPreviewLink> {
  const domain = previewBaseDomain();
  if (!domain) throw new WorkbenchError('Hosted previews are not set up on this deployment.', 404, 'preview_links_unavailable');
  if (row.runtime !== 'sandbox') throw new WorkbenchError('Only sandbox sessions have hosted previews.', 400, 'local_runtime');
  if (row.archivedAt || row.status === 'archived') throw new WorkbenchError('This session is archived.', 409, 'not_ready');
  return mintPreviewTicket({ workbenchId: row.id, port, userId }, domain);
}
