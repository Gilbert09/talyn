import {
  checkpointCreateSteps,
  checkpointRestoreSteps,
  pickWorkbenchName,
  shellQuote,
  toShellScript,
} from '@talyn/shared';
import { runWithoutScope } from '../../db/client.js';
import { debugBus } from '../debugBus.js';
import { FleetRunNotFoundError } from '../selfHosted/client.js';
import { FleetNotDeployedError } from '../selfHosted/credentials.js';
import {
  buildSandboxCreateBody,
  createSandboxRetryingUncertain,
  resolveRepository,
  resolveSandboxCredentials,
} from '../selfHosted/sandboxRun.js';
import { refreshDiffStat } from './changes.js';
import { emitWorkbenchChat, emitWorkbenchDeleted, emitWorkbenchEvents, emitWorkbenchUpdated } from './emit.js';
import { emitPrSession } from './prSessions.js';
import { localRuntimeError, movingError, notReadyError, userFacingError, WorkbenchError } from './errors.js';
import { holdMoves, MOVE_SWEEP_INTERVAL_MS, sweepAbandonedMoves } from './move.js';
import { linkPullRequest, publicWorkbench } from './prLink.js';
import { recordRecoveredTranscript } from './recovery.js';
import {
  cloneScript,
  fleetClientFor,
  fleetCreateTarget,
  gitAuthorFor,
  loadWorkbenchConfig,
  nextSandboxId,
  providerForAgent,
  recordWorkbenchEvent,
  runCapture,
  sandboxIdFor,
} from './sandboxRuntime.js';
import { startScript, stopAllScripts } from './scripts.js';
import {
  appendEvents,
  clearAgentSessions,
  deleteWorkbenchRow,
  failQueued,
  getWorkbench,
  listChats,
  liveWorkbenchNames,
  provisioningWorkbenchIds,
  resetFailedChats,
  rowToChat,
  updateWorkbench,
  type WorkbenchRow,
} from './store.js';
import { cancelAllTurns, startQueuedIfIdle, sweepOrphanedTurns } from './turns.js';

/**
 * A sandbox workbench's life: provision (create the box, clone, set up),
 * archive (save the work, delete the box), restore (a new box, the work put
 * back) and delete.
 *
 * Provisioning is IDEMPOTENT end to end, which is what makes it safe to re-run
 * after a crash: the fleet's create returns the existing box for a repeated
 * id, and the clone script keeps a clone and a local branch it finds.
 */

/** How long the clone and checkout may take. A blobless clone of a very large repository is minutes, not seconds. */
const CLONE_TIMEOUT_MS = 20 * 60_000;
/** An archive script is cleanup, not a build; past this it is stopped and the archive goes on. */
const ARCHIVE_SCRIPT_TIMEOUT_MS = 2 * 60_000;
const ARCHIVE_PUSH_TIMEOUT_MS = 5 * 60_000;

/** The hidden remote ref that holds a workbench's uncommitted work while it is archived. */
export function archiveRef(workbenchId: string): string {
  return `refs/talyn/archive/${workbenchId}`;
}

const provisioning = new Set<string>();

async function setRow(row: WorkbenchRow, patch: Parameters<typeof updateWorkbench>[1]): Promise<WorkbenchRow> {
  const updated = (await updateWorkbench(row.id, patch)) ?? row;
  await emitWorkbenchUpdated(await publicWorkbench(updated));
  return updated;
}

function settingsWithoutFleetSandboxId(row: WorkbenchRow): WorkbenchRow['settings'] {
  const settings = { ...row.settings };
  delete settings.fleetSandboxId;
  return settings;
}

/**
 * The ONE way a provision fails: the workbench and a box that never came up
 * go to `error`, the reason lands in `statusMessage` (which the payload's
 * `error` carries), and every waiting message is dropped with the reason in
 * its chat. A workbench archived while this ran is left alone.
 */
async function failProvision(workbenchId: string, message: string): Promise<void> {
  const row = await getWorkbench(workbenchId);
  if (!row || row.archivedAt) return;
  recordWorkbenchEvent(row, 'provision_failed', message, false);
  await setRow(row, {
    status: 'error',
    statusMessage: message,
    sandboxState: 'error',
  });
  await failQueued(row.id, message);
}

export function scheduleProvision(workbenchId: string, opts: { restore?: boolean } = {}): void {
  void runWithoutScope(() => provisionWorkbench(workbenchId, opts)).catch((err) =>
    console.error(`[workbench] provisioning ${workbenchId} crashed:`, err),
  );
}

/**
 * The memory ceiling of a session's box. The YAS tenant default is 4096 today,
 * but `yasctl -reseed-quotas` resets tenant defaults from the plan, so Talyn
 * asks for it explicitly rather than inherit whatever the plan says.
 */
export const SESSION_SANDBOX_MEM_MIB = 4096;

export type CreatedWorkbenchSandbox =
  | { ok: true; sandboxId: string; fleetHost: string | null; fleetSandboxId: string | null }
  | { ok: false; error: string };

/**
 * Create a box for a workbench, writing nothing to its row. The create body
 * comes from the ONE builder task dispatch uses, so the credential rules
 * cannot differ between the two. The repository and its DEFAULT branch go on
 * the body, which is what picks the newest golden: goldens are keyed on them.
 */
export async function createWorkbenchSandbox(row: WorkbenchRow, sandboxId: string): Promise<CreatedWorkbenchSandbox> {
  const resolved = await resolveSandboxCredentials(row.workspaceId);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const provider = providerForAgent(row.agent);
  // Best effort: without it the box boots the base image and the clone script
  // clones as it always did.
  const repository = await resolveRepository(row.repositoryId, row.workspaceId).catch((err) => {
    console.warn(`[workbench] resolving the default branch for ${row.id} failed:`, err);
    return null;
  });
  const built = await buildSandboxCreateBody({
    id: sandboxId,
    workspaceId: row.workspaceId,
    provider,
    model: row.model ?? (provider === 'openai' ? 'Codex' : 'Claude'),
    creds: resolved.creds,
    githubToken: resolved.githubToken,
    mcpServerIds: null,
    internetAccess: row.settings?.internetAccess !== false,
    gitAuthor: await gitAuthorFor(row.workspaceId),
    // No `task` and no `ephemeral`: a bare box that outlives every turn.
    // So the scope goes at the top level: the fleet proxy's commit, checks
    // and review-thread endpoints refuse a box that names no repository.
    repo: row.repoFullName,
    ...(repository ? { baseBranch: repository.defaultBranch } : {}),
  });
  if (!built.ok) return { ok: false, error: built.error };
  const target = await fleetCreateTarget(row.workspaceId);
  const created = await createSandboxRetryingUncertain(target.client, { ...built.body, memMib: SESSION_SANDBOX_MEM_MIB });
  const fleetSandboxId =
    typeof created.sandbox?.id === 'string' && created.sandbox.id && created.sandbox.id !== sandboxId
      ? created.sandbox.id
      : null;
  return { ok: true, sandboxId, fleetHost: target.host ?? created.host ?? null, fleetSandboxId };
}

export async function provisionWorkbench(workbenchId: string, opts: { restore?: boolean } = {}): Promise<void> {
  if (provisioning.has(workbenchId)) return;
  provisioning.add(workbenchId);
  let row = await getWorkbench(workbenchId);
  try {
    if (!row || row.runtime !== 'sandbox' || row.archivedAt) return;
    const replacingLostSandbox = row.sandboxState === 'lost';
    const fail = (message: string) => failProvision(workbenchId, message);

    // 1. The box.
    const created = await createWorkbenchSandbox(row, row.sandboxId ?? sandboxIdFor(row.id));
    if (!created.ok) return await fail(created.error);
    const settings = settingsWithoutFleetSandboxId(row);
    if (created.fleetSandboxId) settings.fleetSandboxId = created.fleetSandboxId;
    const sandboxId = created.sandboxId;
    row = await setRow(row, {
      sandboxId,
      sandboxState: replacingLostSandbox ? 'lost' : 'running',
      fleetHost: created.fleetHost ?? row.fleetHost ?? null,
      settings,
      statusMessage: 'Cloning the repository',
    });
    recordWorkbenchEvent(row, 'sandbox_created', `sandbox ${sandboxId}`);

    // 2. The repository and the branch.
    const cloned = await runCapture(row, cloneScript(row), { cwd: '/', timeoutMs: CLONE_TIMEOUT_MS });
    if (cloned.exitCode !== 0) {
      return await fail(
        `Could not clone ${row.repoFullName} and check out ${row.branch}: ` +
          (cloned.stderr.trim().split('\n').slice(-3).join(' ') || `git exited ${cloned.exitCode}`),
      );
    }
    if (opts.restore) {
      const restored = await runCapture(row, restoreSavedWorkScript(row), { timeoutMs: CLONE_TIMEOUT_MS });
      if (restored.exitCode !== 0) {
        console.warn(`[workbench] restoring saved work for ${row.id} failed:`, restored.stderr.slice(-300));
      }
    }

    // 3. The setup script. A failure leaves the workbench usable — the agent
    // can often fix what the script could not — and says so.
    let setupNote: string | null = null;
    const config = await loadWorkbenchConfig(row).catch(() => null);
    if (config?.setup) {
      row = await setRow(row, { statusMessage: 'Running the setup script' });
      const { done } = await startScript(row, 'setup', { config });
      const code = await done;
      if (code !== 0) {
        setupNote = `The setup script exited with ${code ?? 'no exit code'}. Its output is in the Scripts panel.`;
      }
    }

    row = await linkPullRequest(row);
    row = await setRow(row, { status: 'ready', sandboxState: 'running', statusMessage: setupNote });
    recordWorkbenchEvent(row, 'ready', 'provisioned');
    void refreshDiffStat(row);

    if (replacingLostSandbox) await recordRecoveredTranscript(row);

    // 4. Messages sent while the box was coming up.
    for (const chat of await listChats(row.id)) {
      if (chat.queuedMessages.length > 0 && !chat.closedAt) await startQueuedIfIdle(chat.id);
    }
  } catch (err) {
    console.warn(`[workbench] provisioning ${workbenchId} failed:`, err);
    await failProvision(workbenchId, userFacingError(err)).catch((failErr) =>
      console.error(`[workbench] recording the failed provision of ${workbenchId} failed:`, failErr),
    );
  } finally {
    provisioning.delete(workbenchId);
  }
}

/**
 * Save everything the box holds that origin does not, before the box goes.
 *
 * Prints one line per thing it did, which `archiveWorkbench` turns into the
 * note the user reads:
 *   PUSHED_BRANCH <n>   n commits pushed to the branch itself
 *   PUSHED_HEAD         the branch had moved on origin; HEAD saved to the archive ref instead
 *   SAVED_WORK          uncommitted changes saved as a hidden commit on the archive ref
 * and exits non-zero when something could NOT be saved — the caller then
 * keeps the box, because deleting it would lose the work.
 *
 * Committed work goes to `refs/heads/<branch>` only as a fast-forward push; it
 * never force-pushes. Uncommitted work never touches the branch at all.
 */
export function archiveSaveScript(row: Pick<WorkbenchRow, 'id' | 'branch' | 'baseBranch'>): string {
  const branchRef = shellQuote(`refs/heads/${row.branch}`);
  const base = shellQuote(`origin/${row.baseBranch}`);
  const ref = archiveRef(row.id);
  const checkpoint = toShellScript(
    checkpointCreateSteps({ chatId: `archive-${row.id}`, turn: 0, tmpIndexPath: `/tmp/talyn-archive-${row.id}.index` }),
  );
  return [
    'set -u',
    `ahead=$(git rev-list --count ${base}..HEAD 2>/dev/null || echo 0)`,
    'head=$(git rev-parse HEAD)',
    `if [ "$ahead" -gt 0 ]; then`,
    `  remote=$(git ls-remote origin ${branchRef} | cut -f1)`,
    `  if [ "$remote" != "$head" ]; then`,
    `    if git push origin HEAD:${branchRef} >&2; then echo "PUSHED_BRANCH $ahead"`,
    `    elif git push --force origin HEAD:${shellQuote(`${ref}-head`)} >&2; then echo PUSHED_HEAD`,
    '    else echo "could not push the commits on this branch" >&2; exit 1; fi',
    '  fi',
    'fi',
    `if [ -n "$(git status --porcelain)" ]; then`,
    `  sha=$(bash -c ${shellQuote(checkpoint)} | tail -n 1)`,
    `  if [ -n "$sha" ] && git push --force origin "$sha":${shellQuote(ref)} >&2; then echo SAVED_WORK`,
    '  else echo "could not save the uncommitted changes" >&2; exit 1; fi',
    'fi',
  ].join('\n');
}

/** After a restore's clone: put back what `archiveSaveScript` saved, when it saved anything. */
export function restoreSavedWorkScript(row: Pick<WorkbenchRow, 'id' | 'branch'>): string {
  const ref = archiveRef(row.id);
  const headRef = shellQuote(`${ref}-head`);
  // The sha is not known until the fetch, so the restore steps are built for a
  // placeholder and the real sha substituted in the shell.
  const placeholder = '0'.repeat(40);
  const restore = toShellScript(
    checkpointRestoreSteps({ sha: placeholder, tmpIndexPath: `/tmp/talyn-unarchive-${row.id}.index` }),
  ).replace(placeholder, '"$sha"');
  return [
    'set -u',
    `if git fetch origin ${headRef} 2>/dev/null; then git checkout -B ${shellQuote(row.branch)} FETCH_HEAD; fi`,
    `if git fetch origin ${shellQuote(ref)} 2>/dev/null; then`,
    '  sha=$(git rev-parse FETCH_HEAD)',
    `  export sha; bash -c ${shellQuote(restore)}`,
    '  echo RESTORED_WORK',
    'fi',
  ].join('\n');
}

/**
 * Archive: stop what is running, run the archive script, save the work to
 * origin, delete the box. A local workbench is only marked — the desktop
 * removes its worktree.
 */
export async function archiveWorkbench(workbenchId: string): Promise<WorkbenchRow> {
  const row = await getWorkbench(workbenchId);
  if (!row) throw new WorkbenchError('Session not found', 404, 'not_found');
  if (row.archivedAt) return row;
  // Its work is on two boxes until the move ends. Archiving now would save
  // and delete only one of them.
  if (row.status === 'moving') throw movingError();
  const release = holdMoves(row.id);
  try {
    return await archiveHeld(row);
  } finally {
    release();
  }
}

async function archiveHeld(row: WorkbenchRow): Promise<WorkbenchRow> {
  const notes: string[] = [];

  if (row.runtime === 'sandbox' && row.sandboxId && row.sandboxState !== 'deleted') {
    const chats = await listChats(row.id);
    await cancelAllTurns(chats.filter((c) => c.status === 'running').map((c) => c.id));
    await stopAllScripts(row).catch(() => undefined);

    if (row.status === 'ready') {
      const config = await loadWorkbenchConfig(row).catch(() => null);
      if (config?.archive) {
        try {
          const { done } = await startScript(row, 'archive', { config, timeoutMs: ARCHIVE_SCRIPT_TIMEOUT_MS });
          const code = await done;
          notes.push(code === 0 ? 'Ran the archive script.' : `The archive script exited with ${code ?? 'no exit code'}.`);
        } catch (err) {
          notes.push(`The archive script could not run: ${userFacingError(err)}`);
        }
      }
      const saved = await runCapture(row, archiveSaveScript(row), { timeoutMs: ARCHIVE_PUSH_TIMEOUT_MS, diskRecovery: false });
      if (saved.exitCode !== 0) {
        // The box stays: deleting it now would lose work nothing else holds.
        throw new WorkbenchError(
          `This session was not archived, because its work could not be saved to GitHub first: ` +
            (saved.stderr.trim().split('\n').slice(-2).join(' ') || `git exited ${saved.exitCode}`),
          409,
          'archive_save_failed',
        );
      }
      const pushed = /^PUSHED_BRANCH (\d+)/m.exec(saved.stdout);
      if (pushed) notes.push(`Pushed ${pushed[1]} commit${pushed[1] === '1' ? '' : 's'} to ${row.branch}.`);
      if (/^PUSHED_HEAD/m.test(saved.stdout)) {
        notes.push(`${row.branch} had moved on GitHub, so this session's commits were saved separately.`);
      }
      if (/^SAVED_WORK/m.test(saved.stdout)) notes.push('Saved the uncommitted changes; restoring brings them back.');
    }

    try {
      const client = await fleetClientFor(row.workspaceId, row.fleetHost);
      await client.deleteSandbox(row.sandboxId);
      recordWorkbenchEvent(row, 'archived', notes.join(' ') || 'sandbox deleted');
    } catch (err) {
      // A workbench that never became ready holds no work, and a fleet that is
      // not set up cannot hold a box either. Archive it without the box rather
      // than strand it. A ready one keeps the refusal: its box may hold work.
      if (row.status === 'ready' || !fleetHoldsNoBox(err)) throw err;
      recordWorkbenchEvent(row, 'archived', `archived without the sandbox: ${userFacingError(err)}`);
    }
  }

  row = await setRow(row, {
    status: 'archived',
    archivedAt: new Date(),
    sandboxState: row.runtime === 'sandbox' ? 'deleted' : 'none',
    statusMessage: notes.length > 0 ? notes.join(' ') : null,
  });
  return row;
}

/**
 * Provision again after a failed start. A half-made box is deleted first, and
 * the new one takes the next sandbox id, because the fleet answers a deleted
 * id from its tombstone. Chats the failure left in `error` go back to `idle`.
 */
export async function retryWorkbench(workbenchId: string): Promise<WorkbenchRow> {
  let row = await getWorkbench(workbenchId);
  if (!row) throw new WorkbenchError('Session not found', 404, 'not_found');
  if (row.runtime !== 'sandbox') throw localRuntimeError();
  if (row.archivedAt) throw notReadyError('archived');
  if (row.status !== 'error') {
    throw new WorkbenchError('This session has not failed, so there is nothing to retry.', 409, 'not_failed');
  }
  if (row.sandboxId && row.sandboxState !== 'deleted') {
    try {
      const client = await fleetClientFor(row.workspaceId, row.fleetHost);
      await client.deleteSandbox(row.sandboxId);
    } catch (err) {
      if (!fleetHoldsNoBox(err)) throw err;
    }
  }
  row = await setRow(row, {
    status: 'provisioning',
    statusMessage: 'Creating the sandbox',
    sandboxId: row.sandboxId ? nextSandboxId(row) : sandboxIdFor(row.id),
    sandboxState: 'creating',
    fleetHost: null,
    settings: settingsWithoutFleetSandboxId(row),
  });
  recordWorkbenchEvent(row, 'provision_retry', `retrying on ${row.sandboxId}`);
  await resetFailedChats(row.id);
  scheduleProvision(row.id);
  return row;
}

/** Errors that mean this fleet cannot be holding the workbench's box. */
function fleetHoldsNoBox(err: unknown): boolean {
  return (
    err instanceof FleetNotDeployedError ||
    err instanceof FleetRunNotFoundError ||
    (err instanceof WorkbenchError && err.code === 'fleet_unconfigured')
  );
}

/**
 * Restore: a NEW box (the old id answers from its tombstone), the branch
 * checked out again and the saved work put back. Every chat's CLI session is
 * forgotten, because the session files lived on the box that is gone — a
 * `--resume` of one would fail the first turn.
 */
export async function restoreWorkbench(workbenchId: string): Promise<WorkbenchRow> {
  let row = await getWorkbench(workbenchId);
  if (!row) throw new WorkbenchError('Session not found', 404, 'not_found');
  if (!row.archivedAt) return row;

  // The name is unique among LIVE workbenches, and another may have taken it.
  const taken = await liveWorkbenchNames(row.workspaceId);
  const name = taken.includes(row.name) ? pickWorkbenchName(taken) : row.name;

  if (row.runtime !== 'sandbox') {
    return setRow(row, { archivedAt: null, status: 'ready', statusMessage: null, name });
  }
  row = await setRow(row, {
    archivedAt: null,
    name,
    status: 'provisioning',
    statusMessage: 'Creating a new sandbox',
    sandboxId: nextSandboxId(row),
    sandboxState: 'creating',
    fleetHost: null,
    settings: settingsWithoutFleetSandboxId(row),
  });
  for (const chat of await clearAgentSessions(row.id)) {
    const stored = await appendEvents(chat.id, [
      {
        turn: chat.turnCount,
        event: {
          type: 'system',
          subtype: 'sandbox_restored',
          text: 'This session was restored onto a new sandbox. The agent starts fresh and does not remember earlier turns.',
        },
      },
    ]);
    emitWorkbenchEvents(chat.workspaceId, chat.id, stored);
    emitWorkbenchChat(chat.workspaceId, rowToChat(chat));
  }
  scheduleProvision(row.id, { restore: true });
  return row;
}

/** Delete the workbench and its box. The box is best effort: the row goes either way. */
export async function deleteWorkbench(workbenchId: string): Promise<void> {
  const row = await getWorkbench(workbenchId);
  if (!row) return;
  // A move in flight finds the row gone at its commit and deletes its new box.
  const release = holdMoves(row.id);
  try {
    await deleteHeld(row);
  } finally {
    release();
  }
}

async function deleteHeld(row: WorkbenchRow): Promise<void> {
  if (row.runtime === 'sandbox' && row.sandboxId && row.sandboxState !== 'deleted') {
    const chats = await listChats(row.id);
    await cancelAllTurns(chats.filter((c) => c.status === 'running').map((c) => c.id)).catch(() => undefined);
    await stopAllScripts(row).catch(() => undefined);
    try {
      const client = await fleetClientFor(row.workspaceId, row.fleetHost);
      await client.deleteSandbox(row.sandboxId);
    } catch (err) {
      console.warn(`[workbench] deleting sandbox ${row.sandboxId} failed; removing the workbench anyway:`, err);
    }
  }
  await deleteWorkbenchRow(row.id);
  emitWorkbenchDeleted(row.workspaceId, row.id);
  if (row.pullRequestId) await emitPrSession(row.workspaceId, row.pullRequestId);
}

/**
 * How long after boot the sweep waits. A deploy overlaps the old and the new
 * instance; the old one is still following its turns until it is told to
 * stop, and settling them from here before then would stop work in progress.
 * Railway's drain plus the forced exit is well under this.
 */
const BOOT_SWEEP_DELAY_MS = 90_000;

let bootTimer: NodeJS.Timeout | null = null;
let moveSweepTimer: NodeJS.Timeout | null = null;
let moveSweepRunning = false;

const MOVE_SWEEP_POLLER = 'workbench-move-sweep';

/** One pass of the abandoned-move sweep, timed on the debug bus. */
async function moveSweepTick(): Promise<void> {
  if (moveSweepRunning) return;
  moveSweepRunning = true;
  const started = Date.now();
  try {
    const undone = await runWithoutScope(() => sweepAbandonedMoves());
    if (undone > 0) console.log(`[workbench] undid ${undone} abandoned move(s)`);
    debugBus.pollerTick(MOVE_SWEEP_POLLER, { durationMs: Date.now() - started, ok: true });
  } catch (err) {
    console.error('[workbench] the move sweep failed:', err);
    debugBus.pollerTick(MOVE_SWEEP_POLLER, { durationMs: Date.now() - started, ok: false, error: err });
  } finally {
    moveSweepRunning = false;
  }
}

/**
 * Arm the one-shot boot sweep: settle turns a dead process left running, and
 * carry on provisions it left half done. Then the move sweep, which runs on
 * an interval: an instance can die mid-move at any time, not only at a deploy,
 * and the row would stay `moving` until the next one.
 */
export function initWorkbenches(delayMs = BOOT_SWEEP_DELAY_MS): void {
  if (bootTimer) return;
  bootTimer = setTimeout(() => {
    void runWithoutScope(async () => {
      try {
        const settled = await sweepOrphanedTurns();
        const stuck = await provisioningWorkbenchIds();
        for (const id of stuck) scheduleProvision(id);
        if (settled > 0 || stuck.length > 0) {
          console.log(`[workbench] boot sweep: settled ${settled} orphaned turn(s), resumed ${stuck.length} provision(s)`);
        }
      } catch (err) {
        console.error('[workbench] boot sweep failed:', err);
      }
    });
    void moveSweepTick();
  }, delayMs);
  bootTimer.unref();
  if (!moveSweepTimer) {
    debugBus.registerPoller(
      MOVE_SWEEP_POLLER,
      MOVE_SWEEP_INTERVAL_MS,
      'Undoes session moves whose lease lapsed: puts the old sandbox back and deletes the half-made one.',
    );
    moveSweepTimer = setInterval(() => void moveSweepTick(), MOVE_SWEEP_INTERVAL_MS);
    moveSweepTimer.unref();
  }
}

export function stopWorkbenches(): void {
  if (bootTimer) clearTimeout(bootTimer);
  bootTimer = null;
  if (moveSweepTimer) clearInterval(moveSweepTimer);
  moveSweepTimer = null;
}
