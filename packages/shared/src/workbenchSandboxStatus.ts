import type { SandboxSize } from './sandboxSize.js';
import type { WorkbenchDiffStat } from './workbench.js';

/**
 * What a session's sandbox is doing, in plain words, for the Sandbox panel in
 * both apps and the `talyn_session_sandbox_status` MCP tool. The backend
 * assembles it from the session row and a cached read of the fleet's record
 * (`GET /workbenches/:id/sandbox-status`). The apps only draw it.
 */

/**
 * - `starting`: Talyn is creating the box, cloning, or running the setup script.
 * - `running`: the box is awake and something runs on it.
 * - `idle`: the box is awake and nothing runs. It goes to sleep at `sleepsAt`.
 * - `asleep`: suspended on its host. It wakes in seconds.
 * - `hibernated`: suspended, and its only copy is in object storage. Waking takes minutes.
 * - `waking`: Talyn or the fleet is bringing the box back.
 * - `moving`: Talyn is moving the session to a new box.
 * - `lost`: the fleet no longer has the box. `replacementStarting` says whether a new one is starting.
 * - `failed`: the session could not start, or an archive failed. Retry starts it again.
 * - `archived`, `local`: no sandbox to describe.
 * - `unknown`: the fleet did not answer and the row says too little.
 */
export type SandboxStatusState =
  | 'starting'
  | 'running'
  | 'idle'
  | 'asleep'
  | 'hibernated'
  | 'waking'
  | 'moving'
  | 'lost'
  | 'failed'
  | 'archived'
  | 'local'
  | 'unknown';

export type SandboxActivityKind = 'turn' | 'queued' | 'capacity_wait' | 'waking' | 'setup' | 'script';

/** One thing that runs or waits on the session now. */
export interface SandboxActivity {
  kind: SandboxActivityKind;
  /** One line, for example "The agent is working". */
  text: string;
  /** When it started, when known. */
  since: string | null;
  chatId?: string;
  /** The script name, for `setup` and `script`. */
  name?: string;
}

export type SandboxStatusActionKind = 'wake' | 'retry' | 'resize' | 'show_setup_output';

export interface SandboxStatusAction {
  kind: SandboxStatusActionKind;
  label: string;
  /** Set when the action can lose work: the words of the confirmation. Null: no confirmation. */
  confirm: string | null;
}

export type SandboxWorkWarningLevel = 'warn' | 'danger';

export interface SandboxWorkSafety {
  /** When Talyn last stored a checkpoint of the work. Null: there is none. */
  savedAt: string | null;
  savedBytes: number | null;
  /**
   * When a save last confirmed that storage holds all of the box's work
   * (a new checkpoint, or a check that found nothing new). Null: never.
   */
  checkedAt: string | null;
  /** Commits that GitHub does not have, as the last save counted them. Null: not known. */
  unpushedCommits: number | null;
  /** Changes not committed, from the last diff stat. Null: not known. */
  uncommitted: WorkbenchDiffStat | null;
  /** Commits on the branch since the base, from the last diff stat. */
  committed: WorkbenchDiffStat | null;
  /** True when the last save found no commit that GitHub lacks. Null: not known. */
  branchPushed: boolean | null;
  /** Saves that failed in a row. 0 when the last save worked. */
  failures: number;
  lastFailureAt: string | null;
  lastFailure: string | null;
  /** A plain-words warning when the work may not be safe. Null: nothing to warn about. */
  warning: string | null;
  warningLevel: SandboxWorkWarningLevel | null;
}

export interface SandboxStatusProblem {
  text: string;
  at: string | null;
}

/** Resource use and limits from the fleet's cached sandbox record. */
export interface SandboxResources {
  /** The VMM's current resident memory. Null when the sandbox is not running or the fleet is too old. */
  memoryUsedMib: number | null;
  memoryLimitMib: number | null;
  /** CPU allocation. The fleet does not report live CPU utilization. */
  vcpus: number | null;
  /** Root filesystem capacity. The fleet does not report guest free space. */
  diskMib: number | null;
}

/** The image a box booted: `SandboxImageLayer` in `setupLayers.ts`. */
export type SandboxStartLayer = 'user' | 'repo' | 'legacy' | 'base';

/** The image the box booted, in plain words. */
export interface SandboxStartImage {
  /** Null: the fleet did not say. */
  layer: SandboxStartLayer | null;
  /** For example "Your image for this repository". */
  label: string;
  /** What the image holds and what the box did itself. */
  detail: string;
  /** The repository commit in the image. Null: the image holds no checkout, or the fleet did not say. */
  repoCommit: string | null;
  /** When the image was built. Null: the fleet does not say. */
  builtAt?: string | null;
  /** The fleet is building a newer user layer or repo layer. Null: not known. */
  userLayerPending: boolean | null;
  repoLayerPending: boolean | null;
  /** One line about a newer image that the fleet builds. Null: none. */
  pending: string | null;
  /** True: a box made now boots a newer image. Null: not known. */
  stale?: boolean | null;
}

/**
 * - `capacity_wait`: the box waited for a free sandbox.
 * - `box`: the fleet made the box and booted it.
 * - `checkout` or `clone`: the branch, on the image's checkout or from a full clone.
 * - `repository_setup`: the repository's own setup command.
 * - `box_steps`: the Setup list steps on the box, all together. `setup_step` rows follow it.
 * - `setup_step`: one Setup list step.
 * - `ready`: from the request for the box to the end of the setup.
 */
export type SandboxStartStepKind =
  | 'capacity_wait'
  | 'box'
  | 'checkout'
  | 'clone'
  | 'repository_setup'
  | 'box_steps'
  | 'setup_step'
  | 'ready';

/** One row of the start timeline. */
export interface SandboxStartStep {
  kind: SandboxStartStepKind;
  label: string;
  /** Null: not measured. */
  durationMs: number | null;
  /** False: it failed. Null: not known, or the row cannot fail. */
  ok: boolean | null;
  /** For example "exit 1" or "timed out". */
  detail?: string | null;
}

/** How this box started, as Talyn measured it. */
export interface SandboxStartTimeline {
  sandboxId: string | null;
  /** Why Talyn made this box. */
  cause: 'new' | 'move' | 'lost' | 'restore' | null;
  /** When Talyn asked the fleet for the box. Null: not measured. */
  requestedAt: string | null;
  /** From the request for the box to the end of the setup. Null: not measured. */
  totalMs: number | null;
  /** The wait for a free sandbox. Null or 0: no wait. */
  capacityWaitMs: number | null;
  steps: SandboxStartStep[];
}

/** The last time Talyn woke this box. */
export interface SandboxWake {
  at: string;
  durationMs: number | null;
  /** `host`: the box woke from its host's disk. `storage`: the fleet restored it from object storage. */
  from: 'host' | 'storage';
  ok: boolean;
  /** For example "Restored from storage in 2m 10s." */
  text: string;
}

/** One recent box start of the repository. */
export interface SandboxRecentStart {
  at: string;
  totalMs: number;
  layer: SandboxStartLayer | null;
  /** A box of this session. */
  thisSession: boolean;
}

/** The "How this box started" section. */
export interface SandboxStartInfo {
  image: SandboxStartImage | null;
  timeline: SandboxStartTimeline | null;
  lastWake: SandboxWake | null;
  /** The repository's recent box starts, newest first. */
  recent: SandboxRecentStart[];
  /** The median start of the repository's other recent boxes. Null: too few to say. */
  medianMs: number | null;
  /** For example "This start took 6m 20s. The median start for this repository is 48s." */
  comparison: string | null;
  /** This start took much longer than the median. */
  slow: boolean;
  /** What Talyn does not know, in words. Null: nothing to say. */
  note: string | null;
}

/** A start is slow when it takes this many times the median, and at least {@link SANDBOX_SLOW_START_MIN_EXTRA_MS} more. */
export const SANDBOX_SLOW_START_FACTOR = 2;
/** A start under a minute over the median is not slow, whatever the factor says. */
export const SANDBOX_SLOW_START_MIN_EXTRA_MS = 60_000;
/** Fewer other starts than this give no median. */
export const SANDBOX_START_MEDIAN_MIN = 3;

export interface WorkbenchSandboxStatus {
  workbenchId: string;
  /** When the backend assembled this answer. */
  checkedAt: string;
  state: SandboxStatusState;
  /** One line, for example "Idle. It goes to sleep in 12 minutes." */
  headline: string;
  /** Extra words, for example the session's status message. Null: none. */
  detail: string | null;
  /** For `idle`: when the fleet suspends the box. */
  sleepsAt: string | null;
  /** For a box that is awake: when it started. For a box that sleeps: when it went to sleep. */
  since: string | null;
  /** For `lost`: true when Talyn is already starting a new box. */
  replacementStarting: boolean;
  /** The fleet's own record. `known: false` when the fleet did not answer or was not asked. */
  fleet: { known: boolean; status: string | null; phase: string | null; error: string | null };
  /** The fleet host that holds the box. */
  host: string | null;
  size: { key: SandboxSize | null; label: string; memMib: number | null; vcpus: number | null } | null;
  /** Current resource use and limits. Null when no resource fact is known. */
  resources?: SandboxResources | null;
  /** What runs or waits now. Empty: nothing. */
  activity: SandboxActivity[];
  work: SandboxWorkSafety | null;
  /** The last error or recovery note, with its time. */
  problem: SandboxStatusProblem | null;
  actions: SandboxStatusAction[];
  /** How the box started: its image, its start timeline and recent starts. Absent on an older backend. */
  start?: SandboxStartInfo | null;
}

/** Unsaved work older than this shows a warning in the Sandbox panel. */
export const SANDBOX_WORK_WARN_AFTER_MS = 30 * 60_000;
