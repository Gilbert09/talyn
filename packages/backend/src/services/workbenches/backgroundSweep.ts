import { BACKGROUND_EXIT_TAIL_LINES } from '@talyn/shared';
import { runWithoutScope } from '../../db/client.js';
import { guardCrossReplica } from '../advisoryLock.js';
import { debugBus } from '../debugBus.js';
import { existingBoxRefusal } from './boxGate.js';
import { isWorkbenchDraining } from './ownership.js';
import { wakeWithCredentials } from './sandboxRuntime.js';
import { chooseReadSource } from './sandboxReadSource.js';
import { getWorkbench, listChats } from './store.js';
import {
  applyProbe,
  emitBackground,
  fireWakeup,
  jobLostReason,
  jobPayer,
  probeJob,
} from './background.js';
import {
  cancelArchivedWakeups,
  dueWakeupsQuery,
  markJobsLost,
  setJobKeepAwake,
  settleJob,
  sweepJobsQuery,
  type JobRow,
} from './backgroundStore.js';

/**
 * Every 30 s: check running background jobs, then fire due wake-ups.
 *
 * A job check is an exec into the box, and every exec is a request that keeps
 * the box awake. So a job is checked only when:
 *  - its keep-awake time is in the future (the agent asked for the box to stay
 *    up, and the check is how it stays up), or
 *  - a turn runs in the session (the box is awake for that turn anyway).
 * After keep-awake ends, a sleeping box is left to sleep. The process is
 * frozen with the box and continues when it wakes; the next turn's checks see
 * how it ended.
 *
 * A box that sleeps while keep-awake is still on (Talyn was down for a deploy,
 * or the box was suspended for usage) is woken, because the agent asked for
 * it to stay up. The wake goes through the box gate as unattended work; a
 * refusal ends the keep-awake and is recorded on the job, never a 402.
 *
 */
export const BACKGROUND_POLLER = 'workbench-background';
export const BACKGROUND_SWEEP_MS = 30_000;
/** Jobs checked per pass, the ones checked longest ago first. */
const JOB_PASS_LIMIT = 50;
/** Checks in flight at once: each one is an exec of up to 15 s. */
const JOB_CHECK_PARALLEL = 8;
const WAKEUP_PASS_LIMIT = 50;

let timer: NodeJS.Timeout | undefined;
let ticking = false;

export type JobCheckOutcome = 'running' | 'exited' | 'lost' | 'stopped' | 'skipped' | 'idle' | 'refused' | 'error';

/** Check one running job. Never throws. */
export async function checkJob(job: JobRow, now = new Date()): Promise<JobCheckOutcome> {
  try {
    const row = await getWorkbench(job.workbenchId);
    const lost = jobLostReason(job, row);
    if (lost) {
      if (await settleJob(job.id, { status: 'lost', detail: lost }, now)) await emitBackground(job.workspaceId, job.workbenchId);
      return 'lost';
    }
    if (!row) return 'skipped';
    if (row.status !== 'ready' || !row.sandboxId) return 'skipped';
    const keepAwake = Boolean(job.keepAwakeUntil && job.keepAwakeUntil.getTime() > now.getTime());
    if (!keepAwake) {
      const busy = (await listChats(row.id)).some((c) => c.status === 'running');
      if (!busy) return 'idle';
    }
    const source = await chooseReadSource(row, now.getTime());
    if (!source.live) {
      if (source.reason !== 'asleep' || !keepAwake) return 'skipped';
      const refusal = await existingBoxRefusal(row, true, jobPayer(job));
      if (refusal) {
        await setJobKeepAwake(job.id, null, `Talyn stopped keeping the sandbox awake: ${refusal.message}`);
        await emitBackground(job.workspaceId, job.workbenchId);
        return 'refused';
      }
      await wakeWithCredentials(row);
    }
    const probe = await probeJob(row, job, job.notifyOnExit ? BACKGROUND_EXIT_TAIL_LINES : 0);
    return await applyProbe(row, job, probe, now);
  } catch (err) {
    console.warn(`[background] checking job ${job.id} failed:`, err);
    return 'error';
  }
}

async function sweepJobs(now: Date): Promise<number> {
  const jobs = await sweepJobsQuery(JOB_PASS_LIMIT);
  let checked = 0;
  for (let i = 0; i < jobs.length; i += JOB_CHECK_PARALLEL) {
    const outcomes = await Promise.all(jobs.slice(i, i + JOB_CHECK_PARALLEL).map((job) => checkJob(job, now)));
    checked += outcomes.filter((o) => o !== 'skipped' && o !== 'idle').length;
  }
  return checked;
}

async function sweepWakeups(now: Date): Promise<number> {
  for (const touched of await cancelArchivedWakeups()) await emitBackground(touched.workspaceId, touched.workbenchId);
  let fired = 0;
  for (const due of await dueWakeupsQuery(now, WAKEUP_PASS_LIMIT)) {
    if (await fireWakeup(due.id, now)) fired++;
  }
  return fired;
}

/** One pass. Exported for tests; production runs it from the timer. */
export async function sweepBackground(now = new Date()): Promise<{ checked: number; fired: number }> {
  if (ticking || isWorkbenchDraining()) return { checked: 0, fired: 0 };
  ticking = true;
  const start = Date.now();
  let error: unknown;
  try {
    const outcome = await guardCrossReplica(BACKGROUND_POLLER, async () => {
      const checked = await sweepJobs(now);
      const fired = await sweepWakeups(now);
      return { checked, fired };
    });
    return outcome.result ?? { checked: 0, fired: 0 };
  } catch (err) {
    error = err;
    return { checked: 0, fired: 0 };
  } finally {
    ticking = false;
    debugBus.pollerTick(BACKGROUND_POLLER, { durationMs: Date.now() - start, ok: !error, error });
  }
}

/**
 * A move committed: the old box and its processes are gone. Marks the running
 * jobs lost now rather than at the next sweep. Never throws.
 */
export async function markJobsLostAfterMove(workbenchId: string, workspaceId: string, newSandboxId: string | null): Promise<void> {
  try {
    const count = await markJobsLost(workbenchId, newSandboxId,
      'The session moved to another sandbox. Running processes do not move with it.');
    if (count > 0) await emitBackground(workspaceId, workbenchId);
  } catch (err) {
    console.warn(`[background] marking the jobs of ${workbenchId} lost failed:`, err);
  }
}

export function initBackgroundSweep(): void {
  if (timer) return;
  debugBus.registerPoller(BACKGROUND_POLLER, BACKGROUND_SWEEP_MS,
    'Check session background jobs and send due wake-up turns.');
  timer = setInterval(() => { void runWithoutScope(() => sweepBackground()); }, BACKGROUND_SWEEP_MS);
  timer.unref();
}

export function stopBackgroundSweep(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
