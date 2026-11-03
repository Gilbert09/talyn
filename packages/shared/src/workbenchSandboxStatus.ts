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
  /** What runs or waits now. Empty: nothing. */
  activity: SandboxActivity[];
  work: SandboxWorkSafety | null;
  /** The last error or recovery note, with its time. */
  problem: SandboxStatusProblem | null;
  actions: SandboxStatusAction[];
}

/** Unsaved work older than this shows a warning in the Sandbox panel. */
export const SANDBOX_WORK_WARN_AFTER_MS = 30 * 60_000;
