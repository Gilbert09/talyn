import { cancelLimitResume } from './limitResume.js';
import { initWorkbenchMaintenance, stopWorkbenchMaintenance } from './maintenance.js';
import { sweepMergeArchives } from './autoArchive.js';
import { archiveBoxSource, IDLE_SWEEP_INTERVAL_MS, IDLE_POLLER, idleArchiveTick } from './idleArchive.js';
import { resetSetupForGeneration, stopSandboxScripts } from './scriptStore.js';
import { sweepAgentBackups } from './agentBackups.js';
import { sweepScripts, detachScriptFollowers } from './scripts.js';
import { beginWorkbenchDrain, detachWorkbenchFollowers, isWorkbenchDraining } from './ownership.js';
import { boxLayerContextFrom, hasPrebakedCheckout, pickWorkbenchName, SANDBOX_SIZES, withCheckoutCommit, type BoxLayerContext, type SandboxSize } from '@talyn/shared';
import { runWithoutScope } from '../../db/client.js';
import { debugBus } from '../debugBus.js';
import {
  FleetCapacityError,
  FleetDispatchUncertainError,
  FleetHttpError,
  FleetRunNotFoundError,
  FleetThrottleError,
  type FleetClient,
  type FleetSandbox,
} from '../selfHosted/client.js';
import { FleetNotDeployedError } from '../selfHosted/credentials.js';
import {
  buildSandboxCreateBody,
  createSandboxRetryingUncertain,
  resolveRepository,
  resolveSandboxCredentials,
  withGithubReadAllRepos,
} from '../selfHosted/sandboxRun.js';
import { refreshDiffStat } from './changes.js';
import { recordSandboxAgents } from './credentialPolicy.js';
import { captureChanges } from './changesCapture.js';
import { deleteChangesSnapshot } from './changesSnapshot.js';
import { emitWorkbenchDeleted, emitWorkbenchUpdated } from './emit.js';
import { emitPrSession } from './prSessions.js';
import {
  isHibernationFetchFailed,
  localRuntimeError,
  notReadyError,
  SandboxSizeRefusedError,
  userFacingError,
  WorkbenchError,
} from './errors.js';
import { holdMoves, MOVE_SWEEP_INTERVAL_MS, sweepAbandonedMoves } from './move.js';
import { linkPullRequest, publicWorkbench } from './prLink.js';
import {
  isHibernationLost,
  keptSandboxIdsFor,
  recordRecoveredTranscript,
  SANDBOX_LOST_FAILED_MESSAGE,
  SANDBOX_LOST_MESSAGE,
} from './recovery.js';
import { isSizeRefusal, noteSizeFallback, sessionSandboxSize, sizeFallbackNote, sizeForSession, sizeRefusalReason } from './sandboxSize.js';
import { boxStartRecord, imageSetupForCreate, noteImageResults, noteImageStatus, recordBoxSetupResults, type BoxTiming } from './setupLayers.js';
import { readStartStepMedians, writeBoxStart, type BoxStartCause, type StartStepMedians } from './boxStart.js';
import { GitProgressTracker, meaningfulStderrTail } from './gitProgress.js';
import { clearLiveStartProgress, createProgressThrottle, setLiveGitProgress, startStep, type StoredStartProgress } from './startProgress.js';
import {
  cloneScript,
  fleetClientFor,
  fleetCreateTarget,
  gitAuthorFor,
  loadWorkbenchConfig,
  killMarker,
  nextSandboxId,
  providerForAgent,
  recordWorkbenchEvent,
  workbenchAgentCredentials,
  runCapture,
  sandboxIdFor,
  SANDBOX_WORK_ROOT,
} from './sandboxRuntime.js';
import { startScript, stopScript, stopAllScripts } from './scripts.js';
import { startTitleFromQueue } from './title.js';
import { checkpointWork, deleteSavedWork, promoteCheckpointToArchive, restoreWork, saveWork } from './workCheckpoint.js';
import { archiveRestoreNote, archiveTooLargeMessage, recoveryWorkNote } from './workCheckpointScripts.js';
import { talynMcpServerFor, unclaimedTalynMcpServer } from './talynMcp.js';
import { claimWarmBox, noteWarmStartReady, yieldWarmPool, type WarmClaim } from './warmPool.js';
import { meterWorkbenchAwake, meterWorkbenchBoxGone } from './usageMeter.js';
import { isMaintenanceClaimHeld, withMaintenanceClaim } from './maintenanceClaim.js';
import {
  claimArchive,
  backfillCredentialArchives,
  clearWorkCheckpoint,
  requestArchiveRestore, cancelPendingArchive, releaseArchive, ensureSandboxGeneration,
  finishArchive,
  markArchive, type IdleArchiveClaim,
  pendingArchives,
  renewArchive,
  deleteWorkbenchRow,
  failProvisioningWorkbench,
  failQueued,
  getWorkbench,
  isProvisionOwned,
  isThread,
  keepSandboxes,
  lastTurnActivity,
  listChats,
  liveWorkbenchNames,
  moveProvisionToSandboxId,
  provisioningWorkbenchIds,
  recordBootMetric,
  recordProvisionedSandbox,
  requeueDroppedMessages,
  resetFailedChats,
  updateProvisioningWorkbench,
  updateWorkbench,
  type WorkbenchRow,
} from './store.js';
import { cancelAllTurns, isWaitingForSandbox, startQueuedIfIdle, sweepOrphanedTurns, detachTurnFollowers } from './turns.js';

/**
 * A sandbox workbench's life: provision (create the box, clone, set up),
 * archive (save the work, delete the box), restore (a new box, the work put
 * back) and delete.
 *
 * Provisioning is IDEMPOTENT end to end, which is what makes it safe to re-run
 * after a crash: the fleet's create returns the existing box for a repeated
 * id, and the clone script keeps a clone and a local branch it finds. One run
 * owns a session's provision across instances (the `provision:<id>` claim),
 * and the clone script also takes a lock in the box.
 */

/** How long the clone and checkout may take. A blobless clone of a very large repository is minutes, not seconds. */
const CLONE_TIMEOUT_MS = 20 * 60_000;
/** An archive script is cleanup, not a build; past this it is stopped and the archive goes on. */
const ARCHIVE_SCRIPT_TIMEOUT_MS = 2 * 60_000;

/** This process's provisions: a fast path in front of the cross-instance claim. */
const provisioning = new Set<string>();

/** The claim expires 2 minutes after its last renewal, so 20 s leaves five missed renewals of slack. */
const PROVISION_CLAIM_RENEW_MS = 20_000;

export const provisionClaimName = (workbenchId: string): string => `provision:${workbenchId}`;

/** This run no longer owns the provision: its claim lapsed, or the row moved on. It stops and writes nothing. */
class ProvisionSupersededError extends Error {}

type ProvisionClaim = { lost: boolean };

function assertOwned(claim: ProvisionClaim): void {
  if (claim.lost) throw new ProvisionSupersededError('the provision claim expired');
}

/** A provision's write, only while the row is still this run's. */
async function setProvisioningRow(
  row: WorkbenchRow,
  sandboxId: string | null,
  patch: Parameters<typeof updateProvisioningWorkbench>[2],
): Promise<WorkbenchRow> {
  const updated = await updateProvisioningWorkbench(row.id, sandboxId, patch);
  if (!updated) throw new ProvisionSupersededError(`the session moved on from sandbox ${sandboxId ?? '(none)'}`);
  await emitWorkbenchUpdated(await publicWorkbench(updated));
  return updated;
}

/**
 * How a provision waits for a free sandbox. When the host is out of memory,
 * the create asks the fleet to queue the box (`queueWhenFull`), and Talyn
 * polls the queued box. Every other refusal is a 503, and Talyn tries again
 * with backoff. ONE bound covers both kinds of wait. It matches the fleet's
 * own queue limit (`MaxQueueWait`, 30 minutes). A field, not a constant, so
 * tests can shorten it.
 */
export const PROVISION_CAPACITY_WAIT = {
  maxMs: 30 * 60_000,
  firstDelayMs: 10_000,
  maxDelayMs: 60_000,
  /** How often a sleep checks for a drain or a lost claim. */
  checkMs: 1_000,
  /** How often a provision reads a box that the fleet queued. */
  queuePollMs: 5_000,
};

/**
 * How a provision waits for its setup script. The script has no time limit,
 * and a box with a failed disk can hang it forever. So the wait also watches
 * for a drain, a lost claim, and a Retry or an archive that moves the row away
 * from this run. Fields, not constants, so tests can shorten them.
 */
export const PROVISION_SETUP_WATCH = {
  /** How often the wait checks for a drain or a lost claim. */
  checkMs: 1_000,
  /** How often the wait reads the row. */
  ownershipCheckMs: 5_000,
};

/**
 * Wait for the setup script to exit. Null at a drain: the resume sweep comes
 * back to the script after the deploy. A lost claim or a row that moved on
 * ends the wait with a superseded error, and the claim goes to the next run.
 * The script itself is left alone.
 */
async function awaitSetupScript(
  done: Promise<number | null>,
  workbenchId: string,
  sandboxId: string,
  claim: ProvisionClaim,
): Promise<{ code: number | null } | null> {
  const exited = done.then((code) => ({ code }));
  // A failure after the wait ended has nobody to report to.
  exited.catch(() => undefined);
  let checkedAt = Date.now();
  for (;;) {
    let timer: NodeJS.Timeout | undefined;
    const tick = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PROVISION_SETUP_WATCH.checkMs); });
    try {
      const result = await Promise.race([exited, tick]);
      if (result) return result;
    } finally {
      clearTimeout(timer);
    }
    if (isWorkbenchDraining()) return null;
    assertOwned(claim);
    if (Date.now() - checkedAt < PROVISION_SETUP_WATCH.ownershipCheckMs) continue;
    checkedAt = Date.now();
    if (!(await isProvisionOwned(workbenchId, sandboxId))) {
      throw new ProvisionSupersededError(`the session moved on from sandbox ${sandboxId} while its setup script ran`);
    }
  }
}

export const WAITING_FOR_SANDBOX_MESSAGE = 'Waiting for a free sandbox';
export const NO_FREE_SANDBOX_MESSAGE = 'No sandbox became free in 30 minutes. Retry when the fleet has room.';

/**
 * The start of the fleet's error on a queued box that a fleetd restart lost.
 * Nothing ran. The id answers from the failed record, so a new create needs a
 * new id. The second form is the fleet's queue pump finding the same loss.
 */
const QUEUE_LOST_ERRORS = ['lost while queued', 'queued run did not survive'];
/**
 * How many new ids a provision tries after a boot that failed. A boot fails
 * when the host is too busy to stage a box in time, and a create sent again
 * with the same id only finds the failed record. A field, not a constant, so
 * tests can change it.
 */
export const PROVISION_BOOT_RETRIES = { max: 2 };

/**
 * Why the fleet's box did not boot, or null when it did not fail that way. Two
 * shapes: fleetd's own 400 for the create that failed, and the failed record a
 * later create with the same id gets back.
 */
function failedBootReason(created: CreatedWorkbenchSandbox | null, err: unknown): string | null {
  if (err instanceof FleetHttpError) {
    return err.status === 400 && err.message.startsWith('sandbox did not boot') ? err.message : null;
  }
  if (!created?.ok || created.record.status !== 'failed' || created.record.phase === 'queued') return null;
  return created.record.error || 'the fleet gave no reason';
}
/** The start of the fleet's error on a queued box that reached the fleet's own queue limit. */
const QUEUE_TIMEOUT_ERROR = 'waited';
/** The states of a box that has booted. The synchronous create answers `idle`. */
const BOOTED_STATUSES: ReadonlySet<string> = new Set(['idle', 'busy', 'suspended']);

/** The fleet's record, with what it says about the box's image layers. */
type FleetRecord = Pick<FleetSandbox, 'status' | 'phase' | 'error' | (typeof LAYER_FIELDS)[number]> & { credentialAgents?: ('claude' | 'codex')[] };
const LAYER_FIELDS = [
  'layer', 'goldenLayer', 'repoCommit', 'appliedStepIds', 'userLayerPending', 'repoLayerPending',
  'repoSetupOk', 'prebakedCheckout', 'layerStepResults',
] as const;
const layerFieldsOf = (sandbox: Partial<FleetSandbox> | undefined): Partial<FleetRecord> =>
  Object.fromEntries(LAYER_FIELDS.filter((k) => sandbox?.[k] !== undefined).map((k) => [k, sandbox![k]]));

/** The fleet queued the box, or the queue already failed it. */
function isQueueRecord(record: FleetRecord): boolean {
  return record.status === 'queued' || (record.status === 'failed' && record.phase === 'queued');
}

/** The pause before the next try: doubling, capped, with jitter. The fleet's Retry-After wins when it is longer. */
export function capacityWaitDelayMs(attempt: number, retryAfterMs?: number, random = Math.random): number {
  const { firstDelayMs, maxDelayMs } = PROVISION_CAPACITY_WAIT;
  const doubled = Math.min(maxDelayMs, firstDelayMs * 2 ** Math.min(attempt, 30));
  const base = Math.min(maxDelayMs, Math.max(doubled, retryAfterMs ?? 0));
  return Math.round(base * (0.8 + 0.4 * random()));
}

/** Sleep in short steps. False at a drain. A lost claim ends the sleep early, and the caller reads `claim.lost`. */
async function pauseProvision(ms: number, claim: ProvisionClaim): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(PROVISION_CAPACITY_WAIT.checkMs, until - Date.now())));
    if (isWorkbenchDraining()) return false;
    if (claim.lost) return true;
  }
  return true;
}

/** The queued box's record. Null when the fleet cannot answer now: the next poll asks again. */
async function readQueuedBox(client: FleetClient, sandboxId: string): Promise<FleetRecord | null> {
  try {
    return (await client.getSandbox(sandboxId)).sandbox;
  } catch (err) {
    if (err instanceof FleetCapacityError || err instanceof FleetThrottleError || err instanceof FleetDispatchUncertainError) {
      console.warn(`[workbench] reading queued sandbox ${sandboxId} failed; polling again:`, err.message);
      return null;
    }
    throw err;
  }
}

/** `waitMs`: how long the create waited for a free sandbox. 0: no wait. */
type CapacityWait = { created: CreatedWorkbenchSandbox; ownSandboxId: string | null; waitMs: number };

/**
 * Create the session's box, and wait while the fleet has no room. A 503 is
 * tried again with the same sandbox id: the fleet's create is idempotent on
 * the id. A queued box is polled until it boots. A queued box that a fleetd
 * restart lost is created again on the next sandbox id, and the row moves to
 * that id. So the caller takes `ownSandboxId` from the answer.
 *
 * The wait ends quietly (null) at a drain. The fleet keeps a queued box, and
 * the resume sweep's create with the same id finds it and waits again, on its
 * own clock. The wait ends with a superseded error when the claim or the row
 * moves on. A queued box is deleted then, unless the row still names it: a new
 * owner of the provision waits on the same box.
 */
async function createWaitingForCapacity(
  row: WorkbenchRow,
  sandboxId: string,
  ownSandboxId: string | null,
  claim: ProvisionClaim,
): Promise<CapacityWait | null> {
  let startedAt: number | null = null;
  let noted = false;
  const timeLeft = () => {
    startedAt ??= Date.now();
    return PROVISION_CAPACITY_WAIT.maxMs - (Date.now() - startedAt);
  };
  /** The first wait of either kind: one message on the row and one event. */
  const noteWait = async (why: string) => {
    if (noted) return;
    noted = true;
    // No estimate: a wait for room has no usual length.
    row = await setProvisioningRow(row, ownSandboxId, {
      statusMessage: WAITING_FOR_SANDBOX_MESSAGE,
      startProgress: startStep('sandbox', { thread: isThread(row), expectedMs: null }),
    });
    recordWorkbenchEvent(row, 'sandbox_capacity_wait', `${why}: waiting for a free sandbox`, false);
    // A real session outranks the warm pool: its boxes go back to the fleet.
    await yieldWarmPool(`session ${row.id.slice(0, 8)} is waiting for room (${why})`);
    await recordBootMetric(row.id, 'capacity_wait_start', { why, sandboxId }).catch((err) =>
      console.warn(`[workbench] recording the capacity wait of ${row.id} failed:`, err));
    console.warn(`[workbench] no free sandbox for ${row.id} (${why}); waiting`);
  };
  const superseded = () => new ProvisionSupersededError(`the session moved on from sandbox ${ownSandboxId ?? '(none)'}`);
  const waited = () => (startedAt === null ? 0 : Date.now() - startedAt);
  /** Nothing runs on the current id: create the box again on the next one, and move the row there. */
  const moveToNextId = async (action: string, detail: (nextId: string) => string) => {
    const nextId = nextSandboxId({ id: row.id, sandboxId, settings: row.settings });
    assertOwned(claim);
    const moved = await moveProvisionToSandboxId(row.id, ownSandboxId, nextId);
    if (!moved) throw superseded();
    recordWorkbenchEvent(moved, action, detail(nextId), false);
    console.warn(`[workbench] ${row.id}: ${detail(nextId)}`);
    row = moved;
    ownSandboxId = nextId;
    sandboxId = nextId;
    await emitWorkbenchUpdated(await publicWorkbench(row));
  };
  let bootFailures = 0;

  try {
  for (let attempt = 0; ;) {
    let created: CreatedWorkbenchSandbox | null = null;
    let createError: unknown = null;
    try {
      created = await createWorkbenchSandbox(row, sandboxId, { queueWhenFull: true });
    } catch (err) {
      createError = err;
    }
    const bootFailed = failedBootReason(created, createError);
    if (bootFailed !== null) {
      // An answer, not a throw: the row may be on a new id now, and the caller fails the id this returns.
      if (bootFailures++ >= PROVISION_BOOT_RETRIES.max) {
        return { created: { ok: false, error: `The sandbox did not start: ${bootFailed}` }, ownSandboxId, waitMs: waited() };
      }
      if (isWorkbenchDraining()) return null;
      assertOwned(claim);
      // A short pause: the host that failed the boot was busy a moment ago.
      if (!(await pauseProvision(PROVISION_CAPACITY_WAIT.firstDelayMs, claim))) return null;
      if (!(await isProvisionOwned(row.id, ownSandboxId))) throw superseded();
      const failedId = sandboxId;
      await moveToNextId('sandbox_boot_failed', (nextId) => `sandbox ${failedId} did not boot (${bootFailed}); creating ${nextId}`);
      continue;
    }
    if (createError !== null || created === null) {
      const err = createError;
      // A 429 waits too: the fleet's per-tenant queue cap (queue_depth) and its
      // rate limit both clear with time, and the same bound applies.
      const throttled = err instanceof FleetThrottleError;
      if (!(err instanceof FleetCapacityError || throttled) || isHibernationFetchFailed(err)) throw err;
      const left = timeLeft();
      if (left <= 0) throw new WorkbenchError(NO_FREE_SANDBOX_MESSAGE, 503, 'no_free_sandbox');
      if (isWorkbenchDraining()) return null;
      assertOwned(claim);
      await noteWait(throttled ? 'throttled' : err.reason);
      if (!(await pauseProvision(Math.min(capacityWaitDelayMs(attempt++, err.retryAfterMs), left), claim))) return null;
      assertOwned(claim);
      if (!(await isProvisionOwned(row.id, ownSandboxId))) throw superseded();
      continue;
    }
    if (!created.ok || !isQueueRecord(created.record)) return { created, ownSandboxId, waitMs: waited() };

    const { client } = created;
    const dropQueuedBox = async () => {
      await client.deleteSandbox(sandboxId).catch((err) =>
        console.warn(`[workbench] deleting queued sandbox ${sandboxId} failed:`, err),
      );
    };
    /** The wait is no longer this run's. The queued box goes, unless the row still names it. */
    const stopWaiting = async () => {
      if (!(await isProvisionOwned(row.id, ownSandboxId))) await dropQueuedBox();
      return superseded();
    };
    let record = created.record;
    for (;;) {
      if (record.status === 'failed' && record.phase === 'queued') {
        const error = record.error ?? '';
        if (QUEUE_LOST_ERRORS.some((prefix) => error.startsWith(prefix))) break;
        if (error.startsWith(QUEUE_TIMEOUT_ERROR)) throw new WorkbenchError(NO_FREE_SANDBOX_MESSAGE, 503, 'no_free_sandbox');
        throw new Error(`The sandbox failed while it waited for room: ${error || 'the fleet gave no reason'}`);
      }
      if (record.status && BOOTED_STATUSES.has(record.status)) return { created: { ...created, record }, ownSandboxId, waitMs: waited() };
      if (record.status !== 'queued' && record.status !== 'starting') {
        throw new Error(`The sandbox did not start: ${record.error || `the fleet reports it ${record.status}`}`);
      }
      const left = timeLeft();
      if (left <= 0) {
        await dropQueuedBox();
        throw new WorkbenchError(NO_FREE_SANDBOX_MESSAGE, 503, 'no_free_sandbox');
      }
      if (isWorkbenchDraining()) return null;
      if (claim.lost) throw await stopWaiting();
      await noteWait('queued in the fleet').catch(async (err: unknown) => {
        throw err instanceof ProvisionSupersededError ? await stopWaiting() : err;
      });
      if (!(await pauseProvision(Math.min(PROVISION_CAPACITY_WAIT.queuePollMs, left), claim))) return null;
      if (claim.lost || !(await isProvisionOwned(row.id, ownSandboxId))) throw await stopWaiting();
      const polled = await readQueuedBox(client, sandboxId);
      record = polled ? { ...polled, ...layerFieldsOf(polled) } : record;
    }

    // A fleetd restart lost the queued box. Nothing ran, so create it again on the next id.
    const lostId = sandboxId;
    await moveToNextId('sandbox_queue_lost', (nextId) => `the fleet lost queued sandbox ${lostId}; creating ${nextId}`);
  }
  } finally {
    if (noted) await recordBootMetric(row.id, 'capacity_wait_end', { sandboxId, ms: waited() }).catch((err) =>
      console.warn(`[workbench] recording the capacity wait end of ${row.id} failed:`, err));
  }
}

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
 * `error` carries), and each chat says why. Waiting messages stay queued for a
 * retry. A workbench archived, retried or restored while this ran is left
 * alone: the write names the sandbox id this run used.
 */
async function failProvision(workbenchId: string, sandboxId: string | null, rawMessage: string): Promise<void> {
  if (isWorkbenchDraining()) return;
  // A lost box found while provisioning ends in `error`: nothing is starting a new one.
  const message = rawMessage === SANDBOX_LOST_MESSAGE ? SANDBOX_LOST_FAILED_MESSAGE : rawMessage;
  clearLiveStartProgress(workbenchId);
  const row = await failProvisioningWorkbench(workbenchId, sandboxId, message);
  if (!row) {
    console.warn(`[workbench] not failing ${workbenchId}: it moved on from sandbox ${sandboxId ?? '(none)'} (${message})`);
    return;
  }
  recordWorkbenchEvent(row, 'provision_failed', message, false);
  await emitWorkbenchUpdated(await publicWorkbench(row));
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
export const SESSION_SANDBOX_MEM_MIB = SANDBOX_SIZES.standard.memMib;

/**
 * The CPU allowance of a session's box: 4 vCPUs. The tenant default is 1, or
 * 0.5 on a plan, which made a PostHog test run or build take many minutes. It
 * is a ceiling, not a reservation: the host shares its 12 threads by load.
 */
export const SESSION_SANDBOX_MILLI_VCPU = SANDBOX_SIZES.standard.milliVcpu;

/** A thread's box: the smallest size. It holds no clone and runs no build, only the agent. */
export const THREAD_SANDBOX_SIZE: SandboxSize = (Object.keys(SANDBOX_SIZES) as SandboxSize[]).reduce((smallest, size) =>
  SANDBOX_SIZES[size].memMib < SANDBOX_SIZES[smallest].memMib ? size : smallest);

/**
 * What a thread's box runs instead of the clone: the agent's working directory.
 * Built at call time: sandboxRuntime is in an import cycle with this module, so
 * at load time its constants can still be undefined (`mkdir -p undefined`).
 */
export function threadWorkdirScript(): string {
  return `mkdir -p ${SANDBOX_WORK_ROOT}`;
}

export type CreatedWorkbenchSandbox =
  | {
    ok: true;
    sandboxId: string;
    fleetHost: string | null;
    fleetSandboxId: string | null;
    size: SandboxSize;
    /** The fleet's record as the create answered it. A queued box says `queued`. */
    record: FleetRecord;
    /** The person's steps in the legacy bake: on a host that does not report layers, a box never runs them. */
    legacyUserStepIds: string[];
    /** The client the create used. A queued box is polled and deleted through it. */
    client: FleetClient;
  }
  | { ok: false; error: string };

/** Create a session box with every usable vendor key and record its allowed agents. */
export async function createWorkbenchSandbox(
  row: WorkbenchRow,
  sandboxId: string,
  opts: { strictSize?: boolean; queueWhenFull?: boolean; diskMib?: number; warm?: boolean } = {},
): Promise<CreatedWorkbenchSandbox> {
  const resolved = await resolveSandboxCredentials(row.workspaceId);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const credentials = await workbenchAgentCredentials(row);
  const agents = (['claude', 'codex'] as const).filter((agent) => credentials[agent]?.token);
  const provider = providerForAgent(credentials[row.agent === 'codex' ? 'codex' : 'claude']?.token ? row.agent : agents[0]);
  // Best effort: without it the box boots the base image and the clone script
  // clones as it always did. A thread has no repository.
  const repositoryId = row.repositoryId;
  const repository = repositoryId && !isThread(row)
    ? await resolveRepository(repositoryId, row.workspaceId).catch((err) => {
      console.warn(`[workbench] resolving the default branch for ${row.id} failed:`, err);
      return null;
    })
    : null;
  // A warm box has no session yet: the route goes in with a secret that opens nothing (`warmPool.ts`).
  const talynServer = opts.warm ? unclaimedTalynMcpServer() : await talynMcpServerFor(row);
  const built = await buildSandboxCreateBody({
    id: sandboxId,
    workspaceId: row.workspaceId,
    provider,
    model: row.model ?? (provider === 'openai' ? 'Codex' : 'Claude'),
    creds: { claudeToken: credentials.claude?.token, openaiKey: credentials.codex?.token },
    githubToken: resolved.githubToken,
    mcpServerIds: null,
    repositoryId: isThread(row) ? null : repositoryId,
    extraMcpServers: talynServer ? [talynServer] : [],
    internetAccess: row.settings?.internetAccess !== false,
    gitAuthor: await gitAuthorFor(row.workspaceId),
    // No `task` and no `ephemeral`: a bare box that outlives every turn.
    // So the scope goes at the top level: the fleet proxy's commit, checks
    // and review-thread endpoints refuse a box that names no repository.
    // A thread names none: it reads repositories and never pushes.
    ...(isThread(row) ? {} : { repo: row.repoFullName }),
    ...(repository ? { baseBranch: repository.defaultBranch } : {}),
  });
  if (!built.ok) return { ok: false, error: built.error };
  built.body.anthropicKey = credentials.claude?.token;
  built.body.openaiKey = credentials.codex?.token;
  // Recompute only the two agent vendors. Keep every other suppression the
  // builder set (github: 'none'): the fleet fills an absent one from custody.
  const { anthropic: _anthropic, openai: _openai, ...otherCredentials } = built.body.policy?.credentials ?? {};
  built.body.policy = {
    ...built.body.policy,
    credentials: {
      ...otherCredentials,
      ...(!credentials.claude?.token ? { anthropic: 'none' as const } : {}),
      ...(!credentials.codex?.token ? { openai: 'none' as const } : {}),
    },
  };
  // The image layers of the Setup list (`layers`), and the legacy `bake`
  // beside them for a host that predates layers. A changed spec is what makes
  // the fleet build the user layer again. Best effort: a box without them
  // runs every step itself.
  const image = repository && repositoryId
    ? await imageSetupForCreate({
      workspaceId: row.workspaceId,
      repositoryId,
      slug: row.repoFullName,
      baseBranch: repository.defaultBranch,
    }).catch((error) => {
      debugBus.recordEvent({
        service: 'setup_recipe',
        action: 'image_spec_failed',
        summary: 'Could not build the image layers for a box. The box runs every setup step itself.',
        ok: false,
        error,
        workspaceId: row.workspaceId,
        meta: { repositoryId, workbenchId: row.id },
      });
      return null;
    })
    : null;
  const target = await fleetCreateTarget(row.workspaceId);
  const withSize = (size: SandboxSize, diskMib?: number) => withGithubReadAllRepos({
    ...built.body,
    ...(image?.bake ? { bake: image.bake } : {}),
    ...(image ? { layers: image.layers } : {}),
    memMib: SANDBOX_SIZES[size].memMib,
    milliVcpu: SANDBOX_SIZES[size].milliVcpu,
    ...(diskMib ? { diskMib } : {}),
    ...(opts.queueWhenFull ? { queueWhenFull: true } : {}),
  });
  // A larger disk is a request, not a need: when the fleet refuses it, ask once more for the default.
  const createSized = async (size: SandboxSize) => {
    if (!opts.diskMib) return createSandboxRetryingUncertain(target.client, withSize(size));
    try {
      return await createSandboxRetryingUncertain(target.client, withSize(size, opts.diskMib));
    } catch (err) {
      // An uncertain create may have made the box: the same request must be asked again, not a new one.
      if (err instanceof FleetDispatchUncertainError) throw err;
      console.warn(`[workbench] creating ${sandboxId} with a ${opts.diskMib} MiB disk failed; using the default size:`, err);
      return createSandboxRetryingUncertain(target.client, withSize(size));
    }
  };
  const chosen = isThread(row) ? null : sessionSandboxSize(row);
  const wanted = isThread(row) ? THREAD_SANDBOX_SIZE : chosen ?? await sizeForSession(row);
  let size = wanted;
  let created;
  try {
    created = await createSized(wanted);
  } catch (err) {
    // A resize asked for exactly this size: refuse, and the session keeps its box.
    if (opts.strictSize && isSizeRefusal(err)) throw new SandboxSizeRefusedError(wanted, sizeRefusalReason(err));
    // The tenant maximum refuses a size it cannot hold. Ask once for the standard box.
    if (SANDBOX_SIZES[wanted].memMib <= SANDBOX_SIZES.standard.memMib || !isSizeRefusal(err)) throw err;
    const text = sizeFallbackNote(err, wanted, chosen ? 'session' : 'repository');
    recordWorkbenchEvent(row, 'sandbox_size_fallback', text, false);
    await noteSizeFallback(row, text).catch(() => undefined);
    size = 'standard';
    created = await createSized(size);
  }
  if (!opts.warm) await recordSandboxAgents(row, sandboxId, agents);
  const fleetSandboxId =
    typeof created.sandbox?.id === 'string' && created.sandbox.id && created.sandbox.id !== sandboxId
      ? created.sandbox.id
      : null;
  return {
    ok: true,
    sandboxId,
    fleetHost: target.host ?? created.host ?? null,
    fleetSandboxId,
    size,
    record: {
      credentialAgents: agents,
      status: created.sandbox?.status,
      phase: created.sandbox?.phase,
      error: created.sandbox?.error,
      ...layerFieldsOf(created.sandbox),
    },
    legacyUserStepIds: image?.legacyUserStepIds ?? [],
    client: target.client,
  };
}

/**
 * What the booted box says about its image, kept on the repository for the
 * Setup list's footer, and the image build's step failures. Best effort.
 */
async function noteBoxImage(row: WorkbenchRow, record: FleetRecord, ctx: BoxLayerContext): Promise<void> {
  if (!row.repositoryId) return;
  try {
    if (record.layer || record.appliedStepIds || record.userLayerPending !== undefined || record.repoLayerPending !== undefined) {
      await noteImageStatus(row.repositoryId, {
        layer: ctx.layer,
        repoCommit: ctx.repoCommit,
        repoLayerPending: record.repoLayerPending ?? null,
        userLayerPending: record.userLayerPending ?? null,
        repoSetupOk: ctx.repoSetupOk,
        appliedStepIds: ctx.layerAware ? ctx.appliedStepIds : [],
        checkedAt: new Date().toISOString(),
        workbenchId: row.id,
      });
    }
    if (record.layerStepResults?.length) await noteImageResults(row.repositoryId, record.layerStepResults, row.workspaceId);
  } catch (error) {
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'image_status_failed',
      summary: 'Could not keep the image status of a box.',
      ok: false,
      error,
      workspaceId: row.workspaceId,
      meta: { repositoryId: row.repositoryId, workbenchId: row.id },
    });
  }
}

/** The box's image context from the create answer, or the old rule when the host reports no layers. */
export function boxLayerOf(created: Extract<CreatedWorkbenchSandbox, { ok: true }>): BoxLayerContext {
  return boxLayerContextFrom(created.record, created.legacyUserStepIds);
}

/**
 * Provision a sandbox session. ONE run owns a session at a time, across
 * backend instances: the run holds the `provision:<id>` maintenance claim and
 * renews it while it works. A call that finds the claim held returns and
 * changes nothing; the resume sweep comes back if the holder dies.
 */
export async function provisionWorkbench(workbenchId: string, opts: { restore?: boolean } = {}): Promise<void> {
  if (provisioning.has(workbenchId) || isWorkbenchDraining()) return;
  provisioning.add(workbenchId);
  try {
    await withMaintenanceClaim(provisionClaimName(workbenchId), async (renew) => {
      const claim: ProvisionClaim = { lost: false };
      const timer = setInterval(() => {
        void renew().catch(() => { claim.lost = true; });
      }, PROVISION_CLAIM_RENEW_MS);
      timer.unref();
      try {
        await provisionClaimed(workbenchId, opts, claim);
      } finally {
        clearInterval(timer);
      }
    });
  } finally {
    provisioning.delete(workbenchId);
  }
}

async function provisionClaimed(workbenchId: string, opts: { restore?: boolean }, claim: ProvisionClaim): Promise<void> {
  // Read under the claim: a late call finds the session ready, failed or archived.
  let row = await getWorkbench(workbenchId);
  if (!row || row.runtime !== 'sandbox' || row.archivedAt || row.status !== 'provisioning' || isWorkbenchDraining()) return;
  // Every write below names this id. A Retry or a restore moves the row to a new one.
  let ownSandboxId: string | null = row.sandboxId;
  try {
    row = (await ensureSandboxGeneration(row.id))!;
    await resetSetupForGeneration(row);
    const replacingLostSandbox = row.sandboxState === 'lost';
    const fail = async (message: string) => {
      assertOwned(claim);
      await failProvision(workbenchId, ownSandboxId, message);
    };

    // 1. The box.
    const createStartedAt = Date.now();
    const cause: BoxStartCause = opts.restore || row.memoryRestorePending === 'archive' ? 'restore' : replacingLostSandbox ? 'lost' : 'new';
    const thread = isThread(row);
    // Read once: every step's estimate comes from this.
    const medians: StartStepMedians = await readStartStepMedians(thread ? null : row.repositoryId);
    // A new session's first box can come ready-made from the repository's warm pool.
    const warm: WarmClaim | null = cause === 'new' && !thread ? await claimWarmBox(row) : null;
    // A warm box is booted already: its start goes straight to the code.
    if (!warm) {
      row = await setProvisioningRow(row, ownSandboxId, { startProgress: startStep('sandbox', { thread, expectedMs: medians.sandbox }) });
    }
    const waited = warm
      ? { created: warm.created, ownSandboxId, waitMs: 0 }
      : await createWaitingForCapacity(row, row.sandboxId ?? sandboxIdFor(row.id), ownSandboxId, claim);
    if (!waited) return;
    ownSandboxId = waited.ownSandboxId;
    const { created } = waited;
    if (!created.ok) return await fail(created.error);
    assertOwned(claim);
    const boxReadyMs = Date.now() - createStartedAt;
    let boxLayer = boxLayerOf(created);
    const prebakedCheckout = hasPrebakedCheckout(boxLayer, created.record.prebakedCheckout);
    const sandboxId = created.sandboxId;
    const codeStep = thread ? null : startStep('code', { thread, expectedMs: prebakedCheckout ? medians.checkout : medians.clone });
    const boxed = await recordProvisionedSandbox(row.id, ownSandboxId, {
      sandboxId,
      sandboxState: replacingLostSandbox ? 'lost' : 'running',
      fleetHost: created.fleetHost,
      fleetSandboxId: created.fleetSandboxId,
      size: created.size,
      statusMessage: thread ? 'Preparing the thread' : 'Cloning the repository',
      // A thread's only step was the box.
      startProgress: codeStep,
    });
    if (!boxed) throw new ProvisionSupersededError(`the session moved on from sandbox ${ownSandboxId ?? '(none)'}`);
    ownSandboxId = sandboxId;
    row = boxed;
    await emitWorkbenchUpdated(await publicWorkbench(row));
    recordWorkbenchEvent(row, 'sandbox_created', `sandbox ${sandboxId}`);
    await meterWorkbenchAwake(row, { size: created.size });
    // The box holds the agent's credentials now: the title need not wait for the clone and the setup.
    const titled = row;
    void startTitleFromQueue(titled).catch((err) => console.warn(`[workbench] early title for ${titled.id} failed:`, err));

    if (isWorkbenchDraining()) return;
    // A thread has no repository: no clone, setup, PR, diff or saved work.
    if (isThread(row)) {
      await writeBoxStart(row.id, { ...boxStartRecord(sandboxId, {
        cause, requestedAtMs: createStartedAt, capacityWaitMs: waited.waitMs,
        boxReadyMs, layer: boxLayer.layer,
      }), totalMs: boxReadyMs }).catch((err: unknown) =>
        console.warn(`[workbench] keeping the start of ${sandboxId} failed:`, err));
      return await finishThreadProvision(row, replacingLostSandbox, fail, claim);
    }
    void noteBoxImage(row, created.record, boxLayer);
    const startFacts: BoxTiming = {
      cause,
      requestedAtMs: createStartedAt,
      capacityWaitMs: waited.waitMs,
      boxReadyMs,
      layer: boxLayer.layer,
      repoCommit: boxLayer.repoCommit,
      userLayerPending: created.record.userLayerPending ?? null,
      repoLayerPending: created.record.repoLayerPending ?? null,
      prebakedCheckout,
      ...(warm ? { warm: true } : {}),
    };
    // The image and the boot show in the Sandbox panel while the clone and the setup run.
    await writeBoxStart(row.id, boxStartRecord(sandboxId, startFacts)).catch((err: unknown) =>
      console.warn(`[workbench] keeping the start of ${sandboxId} failed:`, err));
    // 2. The repository and the branch: a checkout when the image holds the repository.
    const checkoutStartedAt = Date.now();
    const cloned = await runCloneWithProgress(
      row,
      cloneScript(row, { boxLayer, prebakedCheckout: created.record.prebakedCheckout, firstBox: cause === 'new', progress: true }),
      codeStep,
    );
    const checkoutMs = Date.now() - checkoutStartedAt;
    if (cloned.exitCode !== 0) {
      return await fail(
        `Could not clone ${row.repoFullName} and check out ${row.branch}: ` +
          (cloned.errorTail || `git exited ${cloned.exitCode}`),
      );
    }
    boxLayer = withCheckoutCommit(boxLayer, cloned.stdout);
    if (isWorkbenchDraining()) return;
    assertOwned(claim);
    // The saved work comes back from Talyn's storage before the setup script
    // runs against the files: the archive's for a restore, the last
    // checkpoint's for a lost box.
    const restoringArchive = opts.restore || row.memoryRestorePending === 'archive';
    let workNote: string | undefined;
    if (restoringArchive) {
      workNote = archiveRestoreNote(await restoreWork(row, 'archive'));
    } else if (replacingLostSandbox) {
      const restore = await restoreWork(row, 'checkpoint');
      const turns = await lastTurnActivity(row.id).catch(() => null);
      workNote = recoveryWorkNote(restore, {
        lostAt: new Date(),
        recordedAt: row.workCheckpointAt,
        checkedAt: row.workCheckedAt,
        saveFailures: row.workSaveFailures,
        ...(turns ? { lastTurnStartedAt: turns.lastStartedAt, lastTurnEndedAt: turns.lastEndedAt, turnRunning: turns.running } : {}),
      });
    }

    // 3. The setup script. A failure leaves the workbench usable — the agent
    // can often fix what the script could not — and says so.
    let setupNote: string | null = null;
    const config = await loadWorkbenchConfig(row).catch(() => null);
    if (isWorkbenchDraining()) return;
    if (config?.setup) {
      assertOwned(claim);
      row = await setProvisioningRow(row, sandboxId, {
        statusMessage: 'Running the setup script',
        startProgress: startStep('setup', { thread, expectedMs: medians.setup }),
      });
      const setupStartedAt = Date.now();
      const { done } = await startScript(row, 'setup', { config, resume: true });
      const exited = await awaitSetupScript(done, row.id, sandboxId, claim);
      if (!exited || isWorkbenchDraining()) return;
      await recordBoxSetupResults(row, { ...startFacts, checkoutMs, setupMs: Date.now() - setupStartedAt, setupExitCode: exited.code ?? null });
      const { code } = exited;
      if (code !== 0) {
        setupNote = `The setup script exited with ${code ?? 'no exit code'}. Its output is in the Scripts panel.`;
      }
    } else {
      await recordBoxSetupResults(row, { ...startFacts, checkoutMs }, { ranSetup: false });
    }

    if (isWorkbenchDraining()) return;
    assertOwned(claim);
    row = await linkPullRequest(row);
    if (row.memoryRestorePending || replacingLostSandbox) {
      await recordRecoveredTranscript(row, row.memoryRestorePending === 'archive', workNote);
    }
    assertOwned(claim);
    row = await setProvisioningRow(row, sandboxId, {
      status: 'ready', sandboxState: 'running', statusMessage: setupNote, memoryRestorePending: null, startProgress: null,
    });
    recordWorkbenchEvent(row, 'ready', 'provisioned');
    if (warm) await noteWarmStartReady(row, warm, Date.now() - createStartedAt);
    // A new box (a start, a move, a recovery): store its changes, which refreshes the stat too.
    const readyRow = row;
    void captureChanges(readyRow, 'ready').then((c) => (c.kind === 'captured' ? undefined : refreshDiffStat(readyRow)));
    // The archive's work is on this box now: make it the checkpoint, so a loss before the first turn keeps it.
    if (restoringArchive) void checkpointWork(row, 'restored');

    // 4. Messages sent while the box was coming up.
    for (const chat of await listChats(row.id)) {
      if (chat.queuedMessages.length > 0 && !chat.closedAt) await startQueuedIfIdle(chat.id);
    }
  } catch (err) {
    if (isWorkbenchDraining() || (err instanceof WorkbenchError && err.code === 'draining')) return;
    if (err instanceof ProvisionSupersededError || claim.lost) {
      console.warn(`[workbench] provisioning ${workbenchId} stopped: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    console.warn(`[workbench] provisioning ${workbenchId} failed:`, err);
    await failProvision(workbenchId, ownSandboxId, userFacingError(err)).catch((failErr) =>
      console.error(`[workbench] recording the failed provision of ${workbenchId} failed:`, failErr),
    );
  }
}

/** How often git progress may go out to the clients. A field, not a constant, so tests can shorten it. */
export const PROVISION_PROGRESS = { emitMs: 1_000 };

/**
 * The clone script, streamed so git's progress reaches the start's progress
 * bar while it runs. The percentage is kept in this process only and goes out
 * at most once a second. The error tail leaves the progress lines out.
 */
async function runCloneWithProgress(
  row: WorkbenchRow,
  script: string,
  step: StoredStartProgress | null,
): Promise<{ exitCode: number; stdout: string; errorTail: string }> {
  const tracker = new GitProgressTracker();
  const throttle = createProgressThrottle(async () => {
    const fresh = await getWorkbench(row.id);
    if (fresh?.status === 'provisioning') await emitWorkbenchUpdated(await publicWorkbench(fresh));
  }, PROVISION_PROGRESS.emitMs);
  try {
    const cloned = await runCapture(row, script, {
      cwd: '/',
      timeoutMs: CLONE_TIMEOUT_MS,
      marker: `clone-${row.id}`,
      onStderrLine: (line) => {
        const state = tracker.push(line);
        if (!state || !step) return;
        setLiveGitProgress(row.id, step.stepStartedAt, state.percent, state.detail);
        throttle.note(state.percent);
      },
    });
    return { exitCode: cloned.exitCode, stdout: cloned.stdout, errorTail: meaningfulStderrTail(cloned.stderr) };
  } finally {
    throttle.stop();
    clearLiveStartProgress(row.id);
  }
}

/** A thread's box after its create: the work directory, the recap, then the queued messages. */
async function finishThreadProvision(
  row: WorkbenchRow,
  replacingLostSandbox: boolean,
  fail: (message: string) => Promise<void>,
  claim: ProvisionClaim,
): Promise<void> {
  const prepared = await runCapture(row, threadWorkdirScript(), { cwd: '/', timeoutMs: 60_000 });
  if (prepared.exitCode !== 0) {
    return fail(`Could not prepare the thread's sandbox: ${prepared.stderr.trim().split('\n').slice(-3).join(' ') || `exit ${prepared.exitCode}`}`);
  }
  if (isWorkbenchDraining()) return;
  assertOwned(claim);
  if (row.memoryRestorePending || replacingLostSandbox) {
    await recordRecoveredTranscript(row, row.memoryRestorePending === 'archive');
  }
  row = await setProvisioningRow(row, row.sandboxId, {
    status: 'ready', sandboxState: 'running', statusMessage: null, memoryRestorePending: null, startProgress: null,
  });
  recordWorkbenchEvent(row, 'ready', 'provisioned');
  for (const chat of await listChats(row.id)) {
    if (chat.queuedMessages.length > 0 && !chat.closedAt) await startQueuedIfIdle(chat.id);
  }
}

/** Archive answers after the durable marker is written. */
export function archiveWorkbench(workbenchId: string): Promise<WorkbenchRow>;
export function archiveWorkbench(workbenchId: string, opts: { autoForMergedPr: true } | { idle: IdleArchiveClaim }): Promise<WorkbenchRow | null>;
export async function archiveWorkbench(
  workbenchId: string, opts?: { autoForMergedPr: true } | { idle: IdleArchiveClaim },
): Promise<WorkbenchRow | null> {
  const idle = opts && 'idle' in opts ? opts.idle : undefined;
  // A person's or a merge's archive of a sleeping box: a fresh save is the archive, so nothing wakes the box.
  const source = idle ? 'running' : await archiveBoxSource(workbenchId);
  const row = await markArchive(workbenchId, Boolean(opts && 'autoForMergedPr' in opts), idle, source === 'running' ? undefined : source);
  if (!row && opts) return null;
  if (!row) throw new WorkbenchError('Session not found', 404, 'not_found');
  await emitWorkbenchUpdated(await publicWorkbench(row));
  for (const chat of await listChats(row.id)) await cancelLimitResume(chat.id);
  scheduleArchive(row.id);
  return row;
}

const archiveJobs = new Set<Promise<void>>();

const archiveSaveMarker = (row: WorkbenchRow) => `archive-save-${row.id}-${row.archivePendingAt?.getTime() ?? 0}`;

export async function settleArchivesForTests(): Promise<void> {
  while (archiveJobs.size) await Promise.all([...archiveJobs]);
}

export function scheduleArchive(workbenchId: string): void {
  const job = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => runWithoutScope(() => processArchive(workbenchId)))
    .catch((err) => {
      debugBus.pollerTick(ARCHIVE_POLLER, { durationMs: 0, ok: false, error: err });
    }).finally(() => { archiveJobs.delete(job); });
  archiveJobs.add(job);
}

/** Save first. A failed save keeps the sandbox and its durable retry marker. */
export async function processArchive(workbenchId: string): Promise<void> {
  if (isWorkbenchDraining()) return;
  const seen = await getWorkbench(workbenchId);
  if (!seen?.archivePendingAt || seen.status === 'moving' || provisioning.has(workbenchId)) return;
  // Another instance may be provisioning it. Its writes stop at the archive's status change, and it lets the claim go.
  if (await isMaintenanceClaimHeld(provisionClaimName(workbenchId))) return;
  const row = await claimArchive(seen);
  if (!row) return;
  let lost = false;
  const timer = setInterval(() => {
    void renewArchive(row).then((ok) => { if (!ok) lost = true; }).catch(() => { lost = true; });
  }, 20_000);
  timer.unref();
  const checkLease = async () => {
    if (lost || !(await renewArchive(row))) { lost = true; throw new Error('The archive claim expired.'); }
  };
  try {
    await checkLease();
    if (row.runtime === 'sandbox' && row.sandboxId && row.sandboxState !== 'deleted' && isThread(row)) {
      // A thread's box holds no work of its own: its conversation is in the transcript and the agent backups.
      const chats = await listChats(row.id);
      await cancelAllTurns(chats.filter((c) => c.status === 'running' || isWaitingForSandbox(c)).map((c) => c.id));
      await checkLease();
      await (await fleetClientFor(row.workspaceId, row.fleetHost)).deleteSandbox(row.sandboxId);
      await meterWorkbenchBoxGone(row, row.sandboxId);
      await stopSandboxScripts(row.id, row.sandboxId);
    } else if (row.runtime === 'sandbox' && row.sandboxId && row.sandboxState !== 'deleted' && row.settings?.archiveFromSaved) {
      // An archive of a sleeping box with a fresh save: the saved copy is the archive, and nothing here wakes the box.
      await promoteCheckpointToArchive(row);
      await checkLease();
      await deleteSavedWork(row, ['checkpoint']).catch((err) =>
        console.warn(`[workbench] removing the checkpoint of ${row.id} after its archive failed:`, err),
      );
      await clearWorkCheckpoint(row.id);
      await (await fleetClientFor(row.workspaceId, row.fleetHost)).deleteSandbox(row.sandboxId);
      await meterWorkbenchBoxGone(row, row.sandboxId);
      await stopSandboxScripts(row.id, row.sandboxId);
    } else if (row.runtime === 'sandbox' && row.sandboxId && row.sandboxState !== 'deleted') {
      const chats = await listChats(row.id);
      await cancelAllTurns(chats.filter((c) => c.status === 'running' || isWaitingForSandbox(c)).map((c) => c.id));
      await stopAllScripts(row);
      const config = await loadWorkbenchConfig(row);
      await checkLease();
      if (config?.archive) {
        const { done } = await startScript(row, 'archive', { config, timeoutMs: ARCHIVE_SCRIPT_TIMEOUT_MS, resume: true });
        await done;
      }
      await checkLease();
      // Into Talyn's storage, never a push: the branch on GitHub is the
      // person's, and a hidden ref on a public repository is public.
      const saved = await saveWork(row, 'archive', { marker: archiveSaveMarker(row) });
      if (saved.kind === 'too_large') throw new Error(archiveTooLargeMessage(saved.size));
      if (saved.kind === 'failed') throw saved.error ?? new Error(`Could not save the session: ${saved.detail}`);
      await checkLease();
      // The archived session shows its changes from this copy. Best effort: it never fails the archive.
      await captureChanges(row, 'archive');
      await checkLease();
      // The archive supersedes the checkpoint; a stale one must not come back after a restore.
      await deleteSavedWork(row, ['checkpoint']).catch((err) =>
        console.warn(`[workbench] removing the checkpoint of ${row.id} after its archive failed:`, err),
      );
      await clearWorkCheckpoint(row.id);
      await (await fleetClientFor(row.workspaceId, row.fleetHost)).deleteSandbox(row.sandboxId);
      await meterWorkbenchBoxGone(row, row.sandboxId);
      await stopSandboxScripts(row.id, row.sandboxId);
    }
    const done = await finishArchive(row);
    if (done) await emitWorkbenchUpdated(await publicWorkbench(done));
    recordWorkbenchEvent(row, 'archived', 'Saved the session and deleted its sandbox.');
  } catch (err) {
    if (isWorkbenchDraining()) return;
    if (!lost) {
      const gone = err instanceof FleetRunNotFoundError;
      // A lost hibernated copy ends the archive as for a lost box, but the reaper
      // must not delete it (the bucket copy may still restore), so it is kept,
      // not metered as vanished.
      if (isHibernationLost(err)) await keepSandboxes(row.id, keptSandboxIdsFor(row));
      else if (gone) await meterWorkbenchBoxGone(row, row.sandboxId, 'vanished');
      const updated = await finishArchive(row, gone ? undefined : userFacingError(err));
      if (updated) await emitWorkbenchUpdated(await publicWorkbench(updated));
      if (!gone) {
        recordWorkbenchEvent(row, 'archive_failed', 'The sandbox was kept for another save attempt.', false, err);
        debugBus.pollerTick(ARCHIVE_POLLER, { durationMs: 0, ok: false, error: err });
      }
    }
  } finally {
    clearInterval(timer);
    await releaseArchive(row);
  }
}

export async function sweepPendingArchives(): Promise<void> {
  for (const row of await pendingArchives()) await processArchive(row.id);
}

/**
 * Provision again after a failed start. A half-made box is deleted first, and
 * the new one takes the next sandbox id, because the fleet answers a deleted
 * id from its tombstone. Chats the failure left in `error` go back to `idle`.
 *
 * A session still at `provisioning` can be retried too: its start can hang,
 * for example in a setup script on a box whose disk failed. The old box is
 * deleted best effort, because the host that holds it can be the broken part.
 * The old run sees that the row moved on and ends, and the resume sweep then
 * starts the new provision.
 */
export async function retryWorkbench(workbenchId: string): Promise<WorkbenchRow> {
  let row = await getWorkbench(workbenchId);
  if (!row) throw new WorkbenchError('Session not found', 404, 'not_found');
  if (row.runtime !== 'sandbox') throw localRuntimeError();
  if (row.archivedAt) throw notReadyError('archived');
  if (row.status !== 'error' && row.status !== 'provisioning') {
    throw new WorkbenchError('This session has not failed and is not starting, so there is nothing to retry.', 409, 'not_failed');
  }
  const stuck = row.status === 'provisioning';
  // A stuck run with no recorded box can still be creating the first id.
  const oldBox = row.sandboxId ?? (stuck ? sandboxIdFor(row.id) : null);
  if (oldBox && row.sandboxState !== 'deleted') {
    try {
      const client = await fleetClientFor(row.workspaceId, row.fleetHost);
      await client.deleteSandbox(oldBox);
    } catch (err) {
      if (!stuck && !fleetHoldsNoBox(err)) throw err;
      if (stuck) console.warn(`[workbench] deleting sandbox ${oldBox} of stuck ${row.id} failed; retrying anyway:`, err);
    }
    await meterWorkbenchBoxGone(row, row.sandboxId);
  }
  row = await setRow(row, {
    status: 'provisioning',
    statusMessage: 'Creating the sandbox',
    startProgress: null,
    sandboxId: oldBox ? nextSandboxId({ ...row, sandboxId: oldBox }) : sandboxIdFor(row.id),
    // A stuck recovery of a lost box stays one, so the new box gets the checkpoint back.
    sandboxState: stuck && row.sandboxState === 'lost' ? 'lost' : 'creating',
    sandboxGeneration: null,
    fleetHost: null,
    settings: settingsWithoutFleetSandboxId(row),
  });
  recordWorkbenchEvent(row, 'provision_retry', `retrying on ${row.sandboxId}`);
  await requeueDroppedMessages(row.id);
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
 * checked out again and the saved work put back. Agent backups are restored
 * before queued turns start.
 */
export async function restoreWorkbench(workbenchId: string, opts: { archiveWaitMs?: number } = {}): Promise<WorkbenchRow> {
  let row = await getWorkbench(workbenchId);
  if (!row) throw new WorkbenchError('Session not found', 404, 'not_found');
  if (!row.archivedAt) return row;

  row = (await requestArchiveRestore(workbenchId))!;
  const deadline = Date.now() + Math.max(0, Math.min(opts.archiveWaitMs ?? 60_000, 60_000));
  while (row.archivePendingAt && row.archiveLeaseUntil && row.archiveLeaseUntil.getTime() > Date.now()) {
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
    row = (await getWorkbench(workbenchId))!;
    if (!row) throw new WorkbenchError('Session not found', 404, 'not_found');
  }
  const interruptedArchive = row.archivePendingAt && row.archiveLeaseUntil ? row : null;
  row = (await cancelPendingArchive(workbenchId)) ?? row;

  // The name is unique among LIVE workbenches, and another may have taken it.
  const taken = await liveWorkbenchNames(row.workspaceId);
  const name = taken.includes(row.name) ? pickWorkbenchName(taken) : row.name;

  if (row.runtime !== 'sandbox') {
    return setRow(row, { archivedAt: null, restoreRequestedAt: null, status: 'ready', statusMessage: null, name, lastActivityAt: new Date() });
  }
  if (row.sandboxId && row.sandboxState !== 'deleted') {
    try {
      const box = await (await fleetClientFor(row.workspaceId, row.fleetHost)).getSandbox(row.sandboxId);
      if (box.retired) throw new FleetRunNotFoundError('The sandbox was deleted.');
      if (interruptedArchive) {
        await stopScript(row, 'archive');
        await killMarker(row, archiveSaveMarker(interruptedArchive));
      }
      return setRow(row, { archivedAt: null, restoreRequestedAt: null, status: 'ready', statusMessage: null, name, lastActivityAt: new Date() });
    } catch (error) { if (!fleetHoldsNoBox(error)) throw error; }
  }
  // The old box is gone; its interval normally closed with the archive.
  await meterWorkbenchBoxGone(row, row.sandboxId);
  row = await setRow(row, {
    archivedAt: null,
    restoreRequestedAt: null,
    lastActivityAt: new Date(),
    name,
    status: 'provisioning',
    statusMessage: 'Creating a new sandbox',
    startProgress: null,
    memoryRestorePending: 'archive',
    sandboxId: nextSandboxId(row),
    sandboxState: 'creating',
    sandboxGeneration: null,
    fleetHost: null,
    settings: settingsWithoutFleetSandboxId(row),
  });
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
    await cancelAllTurns(chats.filter((c) => c.status === 'running' || isWaitingForSandbox(c)).map((c) => c.id)).catch(() => undefined);
    await stopAllScripts(row).catch(() => undefined);
    try {
      const client = await fleetClientFor(row.workspaceId, row.fleetHost);
      await client.deleteSandbox(row.sandboxId);
    } catch (err) {
      console.warn(`[workbench] deleting sandbox ${row.sandboxId} failed; removing the workbench anyway:`, err);
    }
    // Closed even when the delete failed: no row will name the box again.
    await meterWorkbenchBoxGone(row, row.sandboxId);
  }
  // Before the row: a failure leaves objects behind, never a row that names nothing.
  await deleteSavedWork(row).catch((err) =>
    console.warn(`[workbench] deleting the saved work of ${row.id} failed; removing the workbench anyway:`, err),
  );
  await deleteChangesSnapshot(row).catch((err) =>
    console.warn(`[workbench] deleting the changes snapshot of ${row.id} failed; removing the workbench anyway:`, err),
  );
  await deleteWorkbenchRow(row.id);
  emitWorkbenchDeleted(row.workspaceId, row.id);
  if (row.pullRequestId) await emitPrSession(row.workspaceId, row.pullRequestId);
}

/** Resume provisions promptly. Turn ownership and the provision claim protect overlapping backend instances. */
const BOOT_SWEEP_DELAY_MS = 5_000;

const PROVISION_POLLER = 'workbench-provision-sweep';
/**
 * A stranded provision waits for its dead owner's claim to lapse (2 minutes)
 * and then at most one more pass. No minimum row age: a pass over a live
 * provision costs one claim INSERT that matches nothing.
 */
const PROVISION_SWEEP_INTERVAL_MS = 15_000;

/**
 * Start a provision for every session left in `provisioning`. A live one,
 * here or on another instance, holds its claim, so the call returns at once.
 * Fire and forget: a pass must not wait out a 20-minute clone.
 */
export async function sweepStrandedProvisions(): Promise<number> {
  if (isWorkbenchDraining()) return 0;
  let started = 0;
  for (const id of await provisioningWorkbenchIds()) {
    if (isWorkbenchDraining()) break;
    if (provisioning.has(id)) continue;
    scheduleProvision(id);
    started += 1;
  }
  return started;
}

let provisionSweepRunning = false;
let provisionSweepArmed = false;
async function provisionSweepTick(): Promise<void> {
  if (provisionSweepRunning || isWorkbenchDraining()) return;
  provisionSweepRunning = true;
  const started = Date.now();
  let error: unknown;
  try { await runWithoutScope(() => sweepStrandedProvisions()); } catch (err) { error = err; }
  finally {
    provisionSweepRunning = false;
    debugBus.pollerTick(PROVISION_POLLER, { durationMs: Date.now() - started, ok: !error, error });
  }
}

let turnSweepTimer: NodeJS.Timeout | null = null;
let turnSweepRunning = false;
let backupSweepRunning = false;
async function backupSweepTick(): Promise<void> {
  if (backupSweepRunning) return;
  backupSweepRunning = true;
  const started = Date.now();
  let error: unknown;
  try { await runWithoutScope(() => sweepAgentBackups()); } catch (err) { error = err; }
  finally {
    backupSweepRunning = false;
    debugBus.pollerTick('workbench-backup-sweep', { durationMs: Date.now() - started, ok: !error, error });
  }
}
async function turnSweepTick(): Promise<void> {
  if (turnSweepRunning) return;
  turnSweepRunning = true;
  const started = Date.now();
  let error: unknown;
  try { await runWithoutScope(async () => { await sweepOrphanedTurns(); await sweepScripts(); }); }
  catch (err) { error = err; }
  finally {
    turnSweepRunning = false;
    debugBus.pollerTick('workbench-turn-sweep', { durationMs: Date.now() - started, ok: !error, error });
  }
}
let bootTimer: NodeJS.Timeout | null = null;
let moveSweepTimer: NodeJS.Timeout | null = null;
let archiveSweepTimer: NodeJS.Timeout | null = null;
let idleSweepTimer: NodeJS.Timeout | null = null;
let archiveSweepRunning = false;
const ARCHIVE_POLLER = 'workbench-archive-sweep';

async function archiveSweepTick(): Promise<void> {
  if (archiveSweepRunning) return;
  archiveSweepRunning = true;
  const started = Date.now();
  let error: unknown;
  try {
    await runWithoutScope(async () => {
      await sweepMergeArchives();
      await sweepPendingArchives();
    });
  } catch (err) {
    error = err;
  } finally {
    archiveSweepRunning = false;
    debugBus.pollerTick(ARCHIVE_POLLER, { durationMs: Date.now() - started, ok: !error, error });
  }
}
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
 * carry on provisions it left half done. The provision sweep then repeats on
 * the turn sweep's timer: a provision another instance started after this
 * pass, and then lost at its drain, must not wait for the next boot. Then the
 * move sweep, which runs on an interval: an instance can die mid-move at any
 * time, not only at a deploy, and the row would stay `moving` until the next one.
 */
export function initWorkbenches(delayMs = BOOT_SWEEP_DELAY_MS): void {
  if (bootTimer) return;
  debugBus.registerPoller('workbench-turn-sweep', 5_000, 'Resumes stale turns and starts queued messages.');
  debugBus.registerPoller('workbench-backup-sweep', 30_000, 'Retries agent backups after a backend restart.');
  debugBus.registerPoller(PROVISION_POLLER, PROVISION_SWEEP_INTERVAL_MS, 'Resumes session provisions whose owner stopped or died.');
  void turnSweepTick();
  void backupSweepTick();
  const bootAt = Date.now();
  let lastBackupAt = bootAt;
  let lastProvisionAt = bootAt;
  let lastInterval = 5_000;
  const scheduleSweep = () => {
    const interval = Date.now() - bootAt < 120_000 ? 5_000 : 15_000;
    if (interval !== lastInterval) {
      debugBus.registerPoller('workbench-turn-sweep', interval, 'Resumes stale turns and deferred queues.');
      lastInterval = interval;
    }
    turnSweepTimer = setTimeout(() => {
      void turnSweepTick();
      if (Date.now() - lastBackupAt >= 30_000) { lastBackupAt = Date.now(); void backupSweepTick(); }
      if (provisionSweepArmed && Date.now() - lastProvisionAt >= PROVISION_SWEEP_INTERVAL_MS) {
        lastProvisionAt = Date.now();
        void provisionSweepTick();
      }
      scheduleSweep();
    }, interval);
    turnSweepTimer.unref();
  };
  scheduleSweep();
  bootTimer = setTimeout(() => {
    void runWithoutScope(async () => {
      try {
        await backfillCredentialArchives();
        initWorkbenchMaintenance();
        const settled = await sweepOrphanedTurns();
        const stuck = await sweepStrandedProvisions();
        if (settled > 0 || stuck > 0) {
          console.log(`[workbench] boot sweep: settled ${settled} orphaned turn(s), scheduled ${stuck} provision(s)`);
        }
      } catch (err) {
        console.error('[workbench] boot sweep failed:', err);
      } finally {
        provisionSweepArmed = true;
      }
    });
    void moveSweepTick();
  }, delayMs);
  bootTimer.unref();
  if (!archiveSweepTimer) {
    debugBus.registerPoller(ARCHIVE_POLLER, 60_000, 'Saves pending session archives and deletes their sandboxes after a successful save.');
    archiveSweepTimer = setInterval(() => void archiveSweepTick(), 60_000);
    archiveSweepTimer.unref();
  }
  if (!idleSweepTimer) {
    debugBus.registerPoller(IDLE_POLLER, IDLE_SWEEP_INTERVAL_MS, 'Archives sessions with no activity for the workspace window (7 days by default).');
    idleSweepTimer = setInterval(() => void idleArchiveTick(), IDLE_SWEEP_INTERVAL_MS);
    idleSweepTimer.unref();
  }
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
  beginWorkbenchDrain();
  stopWorkbenchMaintenance();
  if (turnSweepTimer) clearInterval(turnSweepTimer);
  turnSweepTimer = null;
  if (archiveSweepTimer) clearInterval(archiveSweepTimer);
  archiveSweepTimer = null;
  if (idleSweepTimer) clearInterval(idleSweepTimer);
  idleSweepTimer = null;
  if (bootTimer) clearTimeout(bootTimer);
  bootTimer = null;
  provisionSweepArmed = false;
  if (moveSweepTimer) clearInterval(moveSweepTimer);
  moveSweepTimer = null;
}

export function workbenchDrainTimeoutMs(): number {
  const seconds = Number(process.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS ?? 10);
  return (Number.isFinite(seconds) ? Math.max(2, Math.min(seconds, 52)) : 10) * 1000;
}

/** Leave time for output writes before the platform terminates the backend. */
export async function drainWorkbenchFollowers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, workbenchDrainTimeoutMs() - 2000));
  detachWorkbenchFollowers();
  await Promise.all([detachTurnFollowers(), detachScriptFollowers()]);
}
