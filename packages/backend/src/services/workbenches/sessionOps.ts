import type {
  WorkbenchChanges,
  WorkbenchConfig,
  WorkbenchDiff,
  WorkbenchDiffScope,
  WorkbenchFileContent,
  WorkbenchFileList,
  WorkbenchPreviewLink,
} from '@talyn/shared';
import { resolveWorkbenchConfig } from '@talyn/shared';
import { runWithoutScope } from '../../db/client.js';
import { mintPreviewTicket } from '../preview/previewLinks.js';
import { previewBaseDomain } from '../preview/previewHost.js';
import { getPreviewPatch } from '../preview/workbenchPatch.js';
import { assertRepoPath, emptyChanges, getChanges, getPatch, listRepoFiles, readRepoFile, storeDiffStat } from './changes.js';
import { githubDiff, githubFileAt } from './changesGithub.js';
import { listsKey, readChangesMeta, storeConfig } from './changesStore.js';
import { storedChanges, storedConfig, storedFile, storedFileList, storedPatch, storedPreviewPatch } from './changesStored.js';
import { FleetRunNotFoundError } from '../selfHosted/client.js';
import { emitWorkbenchChat, emitWorkbenchUpdated } from './emit.js';
import { localRuntimeError, notReadyError, refuseThread, WorkbenchError } from './errors.js';
import { startStaleGoldenMove } from './move.js';
import { chooseReadSource, type StoredReadReason } from './sandboxReadSource.js';
import { publicWorkbench } from './prLink.js';
import { recoverLostSandbox } from './recovery.js';
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
import { noteChangesStale, noteDiffStatFresh } from './workCheckpoint.js';

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
 * Where a read without `live` comes from. A box that is not running cannot
 * have changed, so Talyn's stored copy answers; the fleet's record decides
 * (see `sandboxReadSource.ts`), because Talyn does not write `suspended` into
 * the row. Null means "read the box": it runs, or `live` was asked for.
 */
async function storedSource(row: WorkbenchRow, live: boolean): Promise<StoredReadReason | null> {
  if (live || row.runtime !== 'sandbox') return null;
  const source = await chooseReadSource(row);
  if (source.live) return null;
  // The row still says `running`, but the fleet no longer has the box. A
  // read of the box used to find that out and start the replacement; a read
  // answered from storage must start it too, or the session never recovers.
  if (source.reason === 'lost' && row.sandboxState === 'running' && row.sandboxId) {
    void recoverLostSandbox(row, new FleetRunNotFoundError(`The fleet no longer runs sandbox ${row.sandboxId}.`))
      .catch((err) => console.warn(`[workbench] starting the recovery of ${row.id} failed:`, err));
  }
  return source.reason;
}

/** Reasons where a read of the box would wake a sleeping one. Only these refuse when nothing is stored. */
function wouldWake(reason: StoredReadReason): boolean {
  return reason === 'asleep' || reason === 'waking';
}

/**
 * Nothing usable is stored for a read of a box that does not run. An archived
 * session has no box to wake. Null means the read goes on to the box path,
 * which answers as it did before stored copies: a fleet that did not answer
 * may still run the box; a starting session answers `not_ready`; a lost box
 * answers the fleet's error and its replacement starts. A sleeping or waking
 * box is refused with the way to wake it: only a person's refresh does that.
 */
function noStoredCopy(reason: StoredReadReason, what: string): WorkbenchError | null {
  if (reason === 'archived') return notReadyError('archived');
  if (!wouldWake(reason)) return null;
  return new WorkbenchError(
    `The sandbox is ${reason === 'waking' ? 'starting' : 'asleep'} and Talyn has no stored copy of ${what}. ` +
      'Use "Refresh from the sandbox" to wake it, or ask again with live=true.',
    409,
    'snapshot_unavailable',
  );
}

/**
 * The changed files. A box that is not running answers from its stored list
 * at once; only `live` wakes it. An archived session answers from its stored
 * list too. With no stored list, `wakeWithoutSnapshot` decides. Both the app
 * and the public API pass false: the read refuses with `snapshot_unavailable`,
 * so opening a session never wakes its box.
 */
export async function readSessionChanges(
  row: WorkbenchRow,
  opts: { live: boolean; wakeWithoutSnapshot: boolean },
): Promise<WorkbenchChanges> {
  // A thread has no repository: nothing changed, and no box needs to wake to say so.
  if (isThread(row)) return emptyChanges();
  const reason = await storedSource(row, opts.live);
  if (reason) {
    const stored = await storedChanges(row, reason);
    if (stored) return stored;
    if (!opts.wakeWithoutSnapshot && wouldWake(reason)) {
      throw noStoredCopy(reason, 'its changes')!;
    }
  }
  await requireReadySandbox(row, true);
  const changes = await getChanges(row);
  noteDiffStatFresh(row.id);
  void storeDiffStat(row, changes).catch((err) =>
    console.warn(`[workbench] storing the diff stat for ${row.id} failed:`, err),
  );
  // The stored diff no longer matches: take a new copy soon, while the box is awake.
  void readChangesMeta(row).then((meta) => {
    if (meta && (meta.listsKey !== listsKey(changes) || meta.sandboxId !== row.sandboxId)) noteChangesStale(row.id);
  }).catch(() => undefined);
  return changes;
}

/**
 * The diff. A sleeping box answers from the stored patch; with none (too
 * large, or not taken yet), GitHub answers when the work is all pushed;
 * otherwise the read is refused with a way to wake the box.
 */
export async function readSessionDiff(
  row: WorkbenchRow,
  path: string | undefined,
  scope: WorkbenchDiffScope | undefined,
  opts: { live?: boolean } = {},
): Promise<WorkbenchDiff> {
  if (isThread(row)) return { patch: '' };
  const reason = await storedSource(row, opts.live === true);
  if (reason) {
    const stored = await storedPatch(row, scope ?? 'combined', path);
    if (stored && !('tooLarge' in stored)) return { patch: stored.patch, snapshotAt: stored.snapshotAt, source: 'stored' };
    const list = await storedChanges(row, reason);
    const fromGithub = list ? await githubDiff(row, list, scope ?? 'combined', path ? assertRepoPath(path) : undefined) : null;
    if (fromGithub) return fromGithub;
    const refusal = noStoredCopy(reason, stored ? 'this diff, because it is too large' : 'this diff');
    if (refusal) throw refusal;
  }
  await requireReadySandbox(row);
  return getPatch(row, path, scope);
}

/**
 * One file. A sleeping box answers a changed file from the stored copy, and a
 * file the session did not change from GitHub at the merge base.
 */
export async function readSessionFile(row: WorkbenchRow, path: string, opts: { live?: boolean } = {}): Promise<WorkbenchFileContent> {
  const reason = isThread(row) ? null : await storedSource(row, opts.live === true);
  if (reason) {
    const stored = await storedFile(row, path);
    if (stored?.kind === 'file') return stored.file;
    if (stored?.kind === 'missing') throw new WorkbenchError(`${assertRepoPath(path)} does not exist.`, 404, 'file_not_found');
    if (stored?.kind === 'deleted') throw new WorkbenchError(`${assertRepoPath(path)} was deleted in this session.`, 404, 'file_not_found');
    if (stored?.kind === 'unchanged') {
      const meta = await readChangesMeta(row);
      const answer = await githubFileAt(row, stored.mergeBase, assertRepoPath(path), meta?.takenAt);
      if (answer && 'content' in answer) return answer;
      if (answer && 'missing' in answer && stored.known === false) {
        throw new WorkbenchError(`${assertRepoPath(path)} does not exist.`, 404, 'file_not_found');
      }
    }
    const refusal = noStoredCopy(reason, 'this file');
    if (refusal) throw refusal;
  }
  await requireReadySandbox(row);
  return readRepoFile(row, path);
}

export async function listSessionFiles(row: WorkbenchRow, opts: { live?: boolean } = {}): Promise<WorkbenchFileList> {
  if (isThread(row)) return { paths: [] };
  const reason = await storedSource(row, opts.live === true);
  if (reason) {
    const stored = await storedFileList(row);
    if (stored) return stored;
    const refusal = noStoredCopy(reason, 'the file list');
    if (refusal) throw refusal;
  }
  await requireReadySandbox(row, true);
  return listRepoFiles(row);
}

/**
 * The session's script config (a thread has none). A sleeping box answers
 * with the config Talyn last read from it.
 */
export async function readSessionConfig(row: WorkbenchRow, opts: { live?: boolean } = {}): Promise<WorkbenchConfig> {
  if (isThread(row)) return loadWorkbenchConfig(row);
  const reason = await storedSource(row, opts.live === true);
  if (reason) {
    const stored = await storedConfig(row);
    if (stored) return stored;
    // No scripts until the box wakes: a Run panel must not wake a sleeping box or fail on it.
    if (reason === 'archived' || wouldWake(reason)) return resolveWorkbenchConfig({});
  }
  await requireReadySandbox(row, true);
  const config = await loadWorkbenchConfigWithDetection(row);
  void storeConfig(row, config);
  return config;
}

/**
 * The patch the preview sync applies. A box known not to run answers from
 * the stored patch when there is one, marked `source: 'stored'` with its
 * time; otherwise the box is read (and wakes), as before, because the sync
 * has no other source.
 */
export async function readSessionPreviewPatch(
  row: WorkbenchRow,
  opts: { live?: boolean } = {},
): Promise<{ base: string; patch: string; source?: 'stored'; snapshotAt?: string }> {
  refuseThread(row);
  const reason = await storedSource(row, opts.live === true);
  // A fleet that did not answer may still run the box, and the sync must
  // apply what is in it now: only a box known not to run answers from storage.
  if (reason && reason !== 'fleet_unreachable') {
    const stored = await storedPreviewPatch(row);
    if (stored) return { ...stored, source: 'stored' };
    if (reason === 'archived') throw notReadyError('archived');
  }
  await requireReadySandbox(row);
  return getPreviewPatch(row);
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
