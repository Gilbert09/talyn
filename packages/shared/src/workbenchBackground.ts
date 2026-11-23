/**
 * Session background jobs and wake-ups.
 *
 * A background job is a shell command that an agent starts in its session's
 * sandbox. It outlives the turn that started it. A wake-up is a row that sends
 * a new turn into a chat at a stated time. Talyn sends one when a job exits
 * too, if the agent asked for it. A CI wake-up waits for the checks on the
 * session's pull request instead, and its time is only the latest it fires.
 */

import type { AwaitCiOutcome } from './prMergeable.js';

export type WorkbenchBackgroundJobStatus = 'running' | 'exited' | 'stopped' | 'lost';

export const WORKBENCH_BACKGROUND_JOB_STATUSES: readonly WorkbenchBackgroundJobStatus[] = [
  'running',
  'exited',
  'stopped',
  'lost',
];

export interface WorkbenchBackgroundJob {
  id: string;
  workbenchId: string;
  chatId: string;
  name: string;
  /** The shell command. A list response cuts it at `BACKGROUND_COMMAND_PREVIEW_CHARS`. */
  command: string;
  /** The directory the command runs in. */
  cwd: string;
  status: WorkbenchBackgroundJobStatus;
  /** Set when the job exited. Null while it runs, and after a stop or a loss. */
  exitCode: number | null;
  /** Why a job is `lost` or `stopped`, in words a person can read. */
  detail: string | null;
  startedAt: string;
  endedAt: string | null;
  /**
   * While this is in the future, Talyn checks the job every 30 seconds, and
   * each check keeps the sandbox awake. The awake time is billed box time.
   * Null: the sandbox may sleep, and the job continues when it wakes.
   */
  keepAwakeUntil: string | null;
  /** When true, Talyn sends a wake-up turn into the chat when the job exits. */
  notifyOnExit: boolean;
  lastCheckedAt: string | null;
}

export type WorkbenchWakeupStatus = 'scheduled' | 'fired' | 'cancelled' | 'failed';

export const WORKBENCH_WAKEUP_STATUSES: readonly WorkbenchWakeupStatus[] = [
  'scheduled',
  'fired',
  'cancelled',
  'failed',
];

/** `agent`: the agent scheduled it, or asked for it when its job exits. `user`: a person did. */
export type WorkbenchWakeupCreatedBy = 'agent' | 'user';

/**
 * What a CI wake-up found when it fired: the outcomes of a parked fix run
 * (`AwaitCiOutcome`), plus a pull request that merged or closed while the
 * session waited.
 */
export type CiWakeupOutcome = AwaitCiOutcome | { kind: 'merged' } | { kind: 'closed' };

export type CiWakeupOutcomeKind = CiWakeupOutcome['kind'];

/** The commit a CI wake-up waits for, on the session's pull request. */
export interface WorkbenchWakeupCi {
  pullRequestId: string;
  headSha: string;
}

export interface WorkbenchWakeup {
  id: string;
  workbenchId: string;
  chatId: string;
  /** For a CI wake-up, the latest time it fires: Talyn sends it sooner when CI settles. */
  wakeAt: string;
  reason: string;
  status: WorkbenchWakeupStatus;
  /** Why a wake-up is `failed` or `cancelled`. */
  failureDetail: string | null;
  createdBy: WorkbenchWakeupCreatedBy;
  /** Set when Talyn made the wake-up because a background job exited. */
  sourceJobId: string | null;
  /** Set on a wake-up that waits for CI. Null on a timed one. */
  ci: WorkbenchWakeupCi | null;
  createdAt: string;
  firedAt: string | null;
}

/** `GET /workbenches/:id/background`, and the `workbench:background` WS payload. */
export interface WorkbenchBackground {
  workbenchId: string;
  /** Every running job, then the most recent ended jobs (newest first). */
  jobs: WorkbenchBackgroundJob[];
  /** Every scheduled wake-up (soonest first), then the most recent settled ones. */
  wakeups: WorkbenchWakeup[];
}

/** `GET /workbenches/:id/background/jobs/:jobId/logs`. */
export interface WorkbenchBackgroundLogs {
  jobId: string;
  status: WorkbenchBackgroundJobStatus;
  exitCode: number | null;
  /** The last lines of the job's output, oldest first. Empty when `asleep`. */
  lines: string[];
  /**
   * The sandbox sleeps, and the request did not ask to wake it (`live=1`).
   * Nothing was read.
   */
  asleep: boolean;
}

/**
 * Why Talyn wrote a queued message, for a message with `origin: 'talyn'`. The
 * clients show such a turn as a system row, not as the person's prompt.
 */
export type WorkbenchMessageTrigger =
  | {
      kind: 'wakeup';
      wakeupId: string;
      reason: string;
      createdBy: WorkbenchWakeupCreatedBy;
      /** Set when a CI wake-up fired: what Talyn found. Older clients ignore it. */
      ci?: CiWakeupOutcomeKind;
    }
  | {
      kind: 'job_exit';
      wakeupId: string;
      reason: string;
      jobId: string;
      jobName: string;
      /** Null when the job's exit code is not known. */
      exitCode: number | null;
    }
  | {
      /** Talyn could not open the pull request, and the agent can fix the cause. */
      kind: 'pr_retry';
      /** 1 for the first automatic retry, up to `PR_RETRY_MAX`. */
      attempt: number;
      /** Talyn's words for the failure. */
      error: string;
    };

/** `POST /workbenches/:id/background/jobs`. Talyn's MCP server calls it for the agent. */
export interface StartWorkbenchBackgroundJobInput {
  /** The chat to tell when the job exits. Default: the session's running chat, else its newest open chat. */
  chatId?: string;
  command: string;
  name?: string;
  /** Default: the repository directory. */
  cwd?: string;
  /** Default `BACKGROUND_DEFAULT_KEEP_AWAKE_SECONDS`. 0 lets the box sleep. */
  keepAwakeSeconds?: number;
  /** Default true. */
  notifyOnExit?: boolean;
}

/** `POST /workbenches/:id/background/jobs/:jobId/keep-awake`. 0 stops keeping the box awake. */
export interface KeepWorkbenchJobAwakeInput {
  seconds: number;
}

/**
 * `POST /workbenches/:id/wakeups`. Exactly one of `delaySeconds` and `at`,
 * except with `untilCi`, where both are optional and set the latest time.
 */
export interface ScheduleWorkbenchWakeupInput {
  /** Default: the session's running chat, else its newest open chat. */
  chatId?: string;
  delaySeconds?: number;
  /** An ISO time in the future. */
  at?: string;
  reason: string;
  /**
   * Fire when the checks on the session's pull request settle, its head
   * moves or it closes. The time (default `CI_WAKEUP_DEFAULT_WAIT_SECONDS`)
   * is the latest it fires. Needs a linked, open pull request.
   */
  untilCi?: boolean;
  /** With `untilCi`: the commit to wait for, full or short. Default: the pull request's head. */
  headSha?: string;
}

/** The default keep-awake of a new job: one hour. */
export const BACKGROUND_DEFAULT_KEEP_AWAKE_SECONDS = 3600;
/**
 * The longest keep-awake one request may ask for. A forgotten job with no
 * bound would keep a box awake, and billed, with nobody watching. A day covers
 * a long build or an overnight run, and a person can ask again.
 */
export const BACKGROUND_MAX_KEEP_AWAKE_SECONDS = 24 * 3600;
/** Lines of output in a log response when the caller does not say. */
export const BACKGROUND_LOG_TAIL_DEFAULT = 200;
/** The most lines one log response returns. Read the file in the sandbox for more. */
export const BACKGROUND_LOG_TAIL_MAX = 2000;
/** Lines of output in the wake-up turn that reports a job's exit. */
export const BACKGROUND_EXIT_TAIL_LINES = 40;
/** A list response cuts a job's command here; the full command stays stored. */
export const BACKGROUND_COMMAND_PREVIEW_CHARS = 2000;
/**
 * The longest command. It reaches the sandbox in one environment variable, and
 * Linux refuses one longer than 128 KiB (MAX_ARG_STRLEN).
 */
export const BACKGROUND_COMMAND_MAX_CHARS = 100_000;
/** A job name shows in one row of the Background panel. */
export const BACKGROUND_NAME_MAX_CHARS = 100;
/**
 * A wake-up reason shows in a chip above the composer and opens the wake-up
 * turn. Longer notes belong in a file or in the session's memory.
 */
export const WAKEUP_REASON_MAX_CHARS = 1000;
/**
 * The latest a CI wake-up fires when the agent gives no time: three hours,
 * the same wait as a parked fix run. Then the agent reads CI itself.
 */
export const CI_WAKEUP_DEFAULT_WAIT_SECONDS = 3 * 3600;

/** A short label for a CI wake-up's outcome. */
export function ciWakeupOutcomeLabel(kind: CiWakeupOutcomeKind): string {
  switch (kind) {
    case 'passing': return 'CI passed';
    case 'failing': return 'CI failed';
    case 'head_moved': return 'The PR head moved';
    case 'timed_out': return 'CI did not finish in time';
    case 'merged': return 'The PR merged';
    case 'closed': return 'The PR closed';
  }
}

/** The trigger of a stored user-message event's `talyn` block, or null for a person's message. */
export function messageTrigger(talyn: unknown): WorkbenchMessageTrigger | null {
  if (!talyn || typeof talyn !== 'object') return null;
  const trigger = (talyn as { trigger?: unknown }).trigger;
  if (!trigger || typeof trigger !== 'object') return null;
  const kind = (trigger as { kind?: unknown }).kind;
  return kind === 'wakeup' || kind === 'job_exit' || kind === 'pr_retry' ? (trigger as WorkbenchMessageTrigger) : null;
}

/** The one line a client shows for a turn that a trigger started. */
export function messageTriggerText(trigger: WorkbenchMessageTrigger): string {
  if (trigger.kind === 'wakeup') {
    return trigger.ci ? `${ciWakeupOutcomeLabel(trigger.ci)}: ${trigger.reason}` : `Woke up: ${trigger.reason}`;
  }
  if (trigger.kind === 'pr_retry') return 'Talyn could not open the pull request. The agent tries to fix the cause.';
  const code = trigger.exitCode === null ? 'an unknown code' : `code ${trigger.exitCode}`;
  return `Background job ${trigger.jobName} exited with ${code}`;
}
