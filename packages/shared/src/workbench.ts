/**
 * Workbenches — one branch of one repository, with a long-running agent chat,
 * a live diff, a terminal, scripts and checkpoints. See `docs/WORKBENCHES.md`.
 *
 * This module holds the vocabulary both runtimes share: the public shapes the
 * API returns, the runtime seam, the city-name picker and the "what is the next
 * thing to do with this branch" derivation. It is pure on purpose — the backend
 * (sandbox runtime) and the Electron main process (local runtime) both import
 * it, and neither may pull the other's dependencies in through here.
 */
import type { AgentEvent } from './index.js';
import type { AgentEventDraft } from './agentStream.js';
import type { WorkbenchPrDraft } from './workbenchPullRequest.js';

// ============================================================================
// Vocabulary
// ============================================================================

/** Where the branch lives: a Talyn Fleet microVM, or a git worktree on the user's machine. */
export type WorkbenchRuntimeKind = 'sandbox' | 'local';

/** Which coding-agent CLI drives a chat. */
export type WorkbenchAgent = 'claude' | 'codex';

export type WorkbenchStatus = 'provisioning' | 'ready' | 'error' | 'archived';

/** The fleet's view of a sandbox workbench's microVM. Always `none` for a local workbench. */
export type WorkbenchSandboxState =
  | 'none'
  | 'creating'
  | 'running'
  | 'suspended'
  | 'deleted'
  | 'error';

export type WorkbenchChatStatus = 'idle' | 'running' | 'awaiting_input' | 'error';

/**
 * Reasoning effort, in Claude Code's vocabulary (`--effort`). Codex has no
 * `max`; `agentStream.ts` maps it to Codex's highest level.
 */
export type WorkbenchEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const WORKBENCH_EFFORTS: readonly WorkbenchEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** What a session or turn with no stored effort runs at. */
export const DEFAULT_WORKBENCH_EFFORT: WorkbenchEffort = 'high';

/**
 * The prompt-driven actions whose wording a workbench may override. Create PR
 * is not one: Talyn opens the PR itself (see `workbenchPullRequest.ts`).
 */
export type WorkbenchPromptAction = 'fix_checks' | 'resolve_conflicts' | 'rename_branch';

// ============================================================================
// Public shapes (what the API returns)
// ============================================================================

export interface WorkbenchDiffStat {
  added: number;
  removed: number;
  files: number;
}

/**
 * Per-workbench overrides. Everything is optional: an absent key means "use
 * the repository's config file" (scripts) or "use Talyn's default" (prompts).
 */
export interface WorkbenchSettings {
  scripts?: {
    setup?: string | null;
    /** One command, or named run scripts. */
    run?: string | WorkbenchNamedRunScript[] | null;
    archive?: string | null;
    runMode?: WorkbenchRunMode;
  };
  prompts?: Partial<Record<WorkbenchPromptAction, string>> & {
    /** Extra instructions for the Create PR draft, appended to Talyn's draft prompt. */
    create_pr?: string;
  };
}

export type WorkbenchRunMode = 'concurrent' | 'nonconcurrent';

export interface WorkbenchNamedRunScript {
  name: string;
  command: string;
  /** The script the Run button starts. Exactly one is the default after resolution. */
  default: boolean;
}

export interface Workbench {
  id: string;
  workspaceId: string;
  repositoryId: string;
  /** `owner/name`, denormalised so a list renders without a repository lookup. */
  repoFullName: string;
  /** A city name, unique per workspace among live workbenches. */
  name: string;
  branch: string;
  baseBranch: string;
  runtime: WorkbenchRuntimeKind;
  /**
   * The workbench's agent. FIXED at creation for a sandbox workbench: the
   * sandbox's egress route table is built from its LLM vendor, so a Codex chat
   * has no route to Anthropic and vice versa. A local workbench may mix.
   */
  agent: WorkbenchAgent;
  /** Local runtime only: the device that owns the worktree. */
  deviceId: string | null;
  /** Local runtime only: the worktree's absolute path on that device. */
  localPath: string | null;
  /** Sandbox runtime only: the fleet sandbox id. */
  sandboxId: string | null;
  sandboxState: WorkbenchSandboxState;
  status: WorkbenchStatus;
  /** The PR opened from this branch, once there is one. */
  pullRequestId: string | null;
  settings: WorkbenchSettings;
  /** Null until a diff has been computed once. */
  diffStat: WorkbenchDiffStat | null;
  /**
   * Why `status` is what it is, in words a person can act on — set on `error`
   * (what failed while provisioning) and cleared when there is nothing to say.
   */
  statusMessage?: string | null;
  /**
   * The linked pull request, as {@link nextWorkbenchAction} reads it. Present on
   * the single-workbench GET once a PR from this branch exists; null otherwise.
   */
  pr?: WorkbenchPullRequestSummary | null;
  /**
   * What went wrong, when provisioning or the sandbox failed; null otherwise.
   * The same words as `statusMessage` on an `error` status, kept separate so
   * an informational message ("Running the setup script") never reads as one.
   */
  error?: string | null;
  /** The open chats, oldest first. Embedded in the list and single GET responses. */
  chats?: WorkbenchChat[];
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The linked PR, narrowed to what the header's next-action button needs. */
export interface WorkbenchPullRequestSummary {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
  mergeable: 'conflicting' | 'mergeable' | 'unknown';
  ciStatus: 'success' | 'failure' | 'pending' | 'none';
}

/** A file attached to a message. Exactly one of `dataBase64` / `path` is set. */
export interface WorkbenchAttachment {
  name: string;
  mimeType: string;
  /** Inline content (small files, images pasted into the composer). */
  dataBase64?: string;
  /** A path inside the workbench (a file the user picked from the tree). */
  path?: string;
}

/**
 * A message sent while a turn was running.
 *
 * A sandbox `exec` has no stdin, so there is no mid-turn steering: a message
 * sent during a turn is queued and drained, in order, when the turn ends.
 */
export interface WorkbenchQueuedMessage {
  id: string;
  text: string;
  attachments?: WorkbenchAttachment[];
  planMode?: boolean;
  model?: string;
  effort?: WorkbenchEffort;
  queuedAt: string;
}

export interface WorkbenchChat {
  id: string;
  workbenchId: string;
  title: string;
  agent: WorkbenchAgent;
  model: string | null;
  effort: WorkbenchEffort | null;
  planMode: boolean;
  /** The CLI's own session id (`--resume` / `codex exec resume`). Null before the first turn. */
  agentSessionId: string | null;
  status: WorkbenchChatStatus;
  queuedMessages: WorkbenchQueuedMessage[];
  createdAt: string;
  updatedAt: string;
}

/**
 * One stored transcript event. `seq` is per chat and monotonic; `turn` counts
 * the user messages that produced it, starting at 1. The event itself is the
 * Claude stream-json shape `transcript.ts` renders — Codex output is converted
 * to it by `agentStream.ts`.
 */
export interface WorkbenchEvent {
  chatId: string;
  seq: number;
  turn: number;
  event: AgentEvent;
}

/** A hidden commit under `refs/talyn/checkpoints/<chatId>/<turn>`. See `workbenchGit.ts`. */
export interface WorkbenchCheckpoint {
  chatId: string;
  turn: number;
  ref: string;
  sha: string;
  createdAt: string;
}

export type WorkbenchChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface WorkbenchChangedFile {
  path: string;
  /** Set for a rename: the path on the base side. */
  oldPath?: string;
  status: WorkbenchChangedFileStatus;
  added: number;
  removed: number;
  binary: boolean;
}

export interface WorkbenchChanges {
  files: WorkbenchChangedFile[];
  /** The merge-base sha the diff was taken against. */
  base: string;
  headSha: string;
}

/** The agent's to-do list, from Claude's `TodoWrite` or Codex's `todo_list` item. */
export interface WorkbenchTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

/** How full the agent's context window is, as of the last model call. */
export interface WorkbenchContextUsage {
  usedTokens: number;
  contextWindow: number;
  /** usedTokens / contextWindow, clamped to [0, 1]. */
  fraction: number;
}

// ============================================================================
// Request shapes (what the API accepts)
// ============================================================================

export interface CreateWorkbenchInput {
  workspaceId: string;
  repositoryId: string;
  runtime: WorkbenchRuntimeKind;
  agent: WorkbenchAgent;
  model?: string;
  baseBranch?: string;
  /** An existing branch to check out. Absent: a new branch named after the workbench. */
  branch?: string;
  /** Start from an open PR's head branch, linking the workbench to it. */
  fromPullRequestId?: string;
  name?: string;
  /** The first message of the first chat. */
  prompt?: string;
  deviceId?: string;
  localPath?: string;
}

export interface UpdateWorkbenchInput {
  name?: string;
  settings?: WorkbenchSettings;
}

export interface CreateWorkbenchChatInput {
  title?: string;
  model?: string;
  effort?: WorkbenchEffort;
  planMode?: boolean;
}

export interface UpdateWorkbenchChatInput {
  title?: string;
  model?: string | null;
  effort?: WorkbenchEffort | null;
  planMode?: boolean;
}

export interface SendWorkbenchMessageInput {
  text: string;
  attachments?: WorkbenchAttachment[];
  planMode?: boolean;
  model?: string;
  effort?: WorkbenchEffort;
}

/** A local runtime reports its chat state to the backend, which owns the row. */
export interface UpdateLocalWorkbenchChatInput {
  status: WorkbenchChatStatus;
  agentSessionId?: string | null;
}

// ============================================================================
// WebSocket payloads
// ============================================================================

export interface WorkbenchScriptFrame {
  workbenchId: string;
  name: string;
  stream: 'stdout' | 'stderr' | 'exit';
  data?: string;
  exitCode?: number | null;
}

/** Why a runtime or an agent cannot run now. `message` is shown to the user as it is. */
export interface WorkbenchReadinessReason {
  code:
    | 'flag_off'
    | 'fleet_disabled'
    | 'fleet_not_deployed'
    | 'fleet_not_allowed'
    | 'agent_not_connected'
    | 'agent_reauth_required'
    | (string & {});
  message: string;
}

export interface WorkbenchAgentReadiness {
  ok: boolean;
  reason?: WorkbenchReadinessReason;
}

/**
 * What the backend can run for a workspace, asked BEFORE a create so the UI can
 * disable a choice with its reason instead of failing late. The create route
 * checks the same answer.
 */
export interface WorkbenchReadiness {
  sandbox: {
    ok: boolean;
    reasons: WorkbenchReadinessReason[];
    agents: Record<WorkbenchAgent, WorkbenchAgentReadiness>;
  };
}

/** What this machine can run for a local workbench (from Electron main). */
export interface WorkbenchLocalReadiness {
  claude: { ok: boolean; path?: string };
  codex: { ok: boolean; path?: string };
  pty: { ok: boolean; error?: string };
  git: { ok: boolean; path?: string };
}

/** Payload per workbench WS event type. The type names are in `WSEventType`. */
export interface WorkbenchWsPayloads {
  'workbench:updated': { workbench: Workbench };
  'workbench:deleted': { id: string };
  'workbench:chat': { chat: WorkbenchChat };
  'workbench:event': { chatId: string; events: WorkbenchEvent[] };
  'workbench:script': WorkbenchScriptFrame;
}

// ============================================================================
// The runtime seam
// ============================================================================

export interface WorkbenchExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface WorkbenchExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface WorkbenchTurnRequest {
  chatId: string;
  turn: number;
  agent: WorkbenchAgent;
  prompt: string;
  model?: string;
  effort?: WorkbenchEffort;
  planMode: boolean;
  /** The CLI session to continue. Absent on a chat's first turn. */
  resumeSessionId?: string;
  appendSystemPrompt?: string;
  attachments?: WorkbenchAttachment[];
}

export interface WorkbenchTurnOutcome {
  /** The CLI's session id, as the stream reported it. */
  sessionId: string | null;
  isError: boolean;
  /** The agent's final message, or the error text. */
  resultText: string;
  cancelled: boolean;
}

/**
 * What a runtime can do. Both implement it: the sandbox runtime in the backend
 * (over the fleet's `/exec`), the local runtime in the Electron main process
 * (over `child_process`). Git work goes through `exec` with the argv builders in
 * `workbenchGit.ts`, so the two runtimes cannot disagree about a git command.
 *
 * This is documentation of the seam as much as a type: a method a runtime
 * cannot honour should reject with a clear error, never resolve with a guess.
 */
export interface WorkbenchRuntime {
  readonly kind: WorkbenchRuntimeKind;
  /**
   * Run one agent turn: spawn the CLI, parse its stream with `agentStream.ts`,
   * hand each event to `onEvent` (unsequenced — the caller assigns `seq`), and
   * resolve when the process exits.
   */
  startTurn(
    request: WorkbenchTurnRequest,
    onEvent: (event: AgentEventDraft) => void
  ): Promise<WorkbenchTurnOutcome>;
  /** Stop the running turn for `chatId`. Resolves once the process is gone. */
  cancelTurn(chatId: string): Promise<void>;
  exec(argv: string[], opts?: WorkbenchExecOptions): Promise<WorkbenchExecResult>;
  /** Working tree (including untracked files) vs the merge-base with `base`. */
  diff(base: string): Promise<WorkbenchChanges>;
  readFile(relativePath: string): Promise<{ content: string; binary: boolean }>;
  /** Tracked and untracked, gitignored files excluded. */
  listFiles(): Promise<string[]>;
  /** Sandbox: suspend the microVM. Local: a no-op. */
  suspend(): Promise<void>;
  /** Sandbox: delete the microVM. Local: remove the worktree. */
  destroy(): Promise<void>;
}

// ============================================================================
// The local bridge (Electron preload → `window.electron.workbench`)
// ============================================================================

/**
 * The `window.electron.workbench` API the desktop preload exposes. Every
 * argument and result crosses IPC, so everything here is structured-clone
 * serialisable: no functions except the subscription callbacks, no classes.
 */
export interface WorkbenchLocalBridge {
  /** `git worktree add` from a local clone, or clone first when only a URL is given. */
  createWorktree(input: {
    repoPath?: string;
    cloneUrl?: string;
    workbenchId: string;
    name: string;
    branch: string;
    baseBranch: string;
  }): Promise<{ path: string }>;
  removeWorktree(input: { path: string; force?: boolean }): Promise<void>;
  startTurn(input: {
    workbenchId: string;
    chatId: string;
    turn: number;
    path: string;
    agent: WorkbenchAgent;
    prompt: string;
    model?: string;
    effort?: WorkbenchEffort;
    planMode: boolean;
    resumeSessionId?: string;
    appendSystemPrompt?: string;
    attachments?: WorkbenchAttachment[];
  }): Promise<void>;
  cancelTurn(chatId: string): Promise<void>;
  /**
   * A one-shot, hidden agent run that drafts a pull request (see
   * `workbenchPullRequest.ts`). Nothing reaches the chat's transcript, and a
   * Claude run forks `resumeSessionId` rather than continuing it.
   */
  draftPullRequest(input: {
    path: string;
    agent: WorkbenchAgent;
    prompt: string;
    resumeSessionId?: string;
    model?: string;
  }): Promise<WorkbenchPrDraft>;
  /** Run argv steps (see `workbenchGit.ts` `GitStep`) in `path`, in order, stopping at the first failure. */
  exec(
    path: string,
    steps: Array<{ argv: string[]; env?: Record<string, string>; allowFailure?: boolean; capture?: string }>
  ): Promise<WorkbenchExecResult>;
  readFile(path: string, relativePath: string): Promise<{ content: string; binary: boolean }>;
  listFiles(path: string): Promise<string[]>;
  terminal: {
    open(input: { workbenchId: string; path: string; kind: 'shell' | 'agent' }): Promise<string>;
    write(terminalId: string, data: string): void;
    resize(terminalId: string, cols: number, rows: number): void;
    close(terminalId: string): void;
    onData(callback: (frame: { terminalId: string; data: string } | { terminalId: string; exitCode: number }) => void): () => void;
  };
  scripts: {
    run(input: { workbenchId: string; path: string; name: string; command: string; env: Record<string, string> }): Promise<void>;
    stop(input: { workbenchId: string; name: string }): Promise<void>;
    onFrame(callback: (frame: WorkbenchScriptFrame) => void): () => void;
  };
  /** Each parsed, unsequenced event of a running turn. */
  onTurnEvent(callback: (frame: { chatId: string; turn: number; event: AgentEventDraft }) => void): () => void;
  onTurnEnd(callback: (frame: { chatId: string; turn: number } & WorkbenchTurnOutcome) => void): () => void;
  /** Absolute path of each CLI on the user's PATH, or null. */
  detectAgents(): Promise<{ claude: string | null; codex: string | null }>;
  /** Native folder picker. Null when the user cancels. */
  pickRepoFolder(): Promise<string | null>;
  /** What this machine can run. Cached for 30 s in main; `force` bypasses the cache. */
  readiness(force?: boolean): Promise<WorkbenchLocalReadiness>;
  /** Per-machine map of `owner/name` to local checkout path. */
  repoPaths: {
    get(): Promise<Record<string, string>>;
    set(input: { repoFullName: string; path: string }): Promise<Record<string, string>>;
    remove(repoFullName: string): Promise<Record<string, string>>;
  };
}

// ============================================================================
// Names
// ============================================================================

/**
 * Workbench names. Short, distinct, typeable, and safe as a branch name and a
 * directory name as they stand: lowercase ASCII, words joined by hyphens.
 */
export const WORKBENCH_CITY_NAMES: readonly string[] = [
  'amsterdam', 'athens', 'auckland', 'austin', 'baghdad', 'baku', 'bangkok', 'barcelona',
  'beirut', 'belgrade', 'bergen', 'berlin', 'bern', 'bilbao', 'bogota', 'bologna',
  'bordeaux', 'boston', 'bratislava', 'brisbane', 'bristol', 'bruges', 'brussels', 'bucharest',
  'budapest', 'buenos-aires', 'cairo', 'calgary', 'cape-town', 'caracas', 'cardiff', 'casablanca',
  'chicago', 'copenhagen', 'cork', 'dakar', 'dallas', 'delhi', 'denver', 'detroit',
  'doha', 'dubai', 'dublin', 'dubrovnik', 'durban', 'edinburgh', 'florence', 'frankfurt',
  'geneva', 'genoa', 'glasgow', 'granada', 'hamburg', 'hanoi', 'havana', 'helsinki',
  'hobart', 'hong-kong', 'honolulu', 'houston', 'istanbul', 'jakarta', 'jerusalem', 'kampala',
  'karachi', 'kathmandu', 'kigali', 'kingston', 'kyoto', 'lagos', 'la-paz', 'leeds',
  'lima', 'lisbon', 'liverpool', 'ljubljana', 'london', 'los-angeles', 'luanda', 'lyon',
  'madrid', 'malaga', 'manila', 'marrakesh', 'marseille', 'melbourne', 'memphis', 'mexico-city',
  'miami', 'milan', 'minsk', 'montevideo', 'montreal', 'moscow', 'mumbai', 'munich',
  'nairobi', 'nagoya', 'nantes', 'naples', 'nashville', 'new-orleans', 'new-york', 'nice',
  'osaka', 'oslo', 'ottawa', 'oxford', 'palermo', 'panama', 'paris', 'perth',
  'philadelphia', 'phoenix', 'porto', 'prague', 'quebec', 'quito', 'reykjavik', 'riga',
  'rio', 'rome', 'rotterdam', 'salvador', 'san-diego', 'san-francisco', 'santiago', 'sao-paulo',
  'sapporo', 'sarajevo', 'seattle', 'seoul', 'seville', 'shanghai', 'singapore', 'sofia',
  'stockholm', 'sydney', 'taipei', 'tallinn', 'tangier', 'tbilisi', 'tokyo', 'toronto',
  'tunis', 'turin', 'valencia', 'vancouver', 'venice', 'vienna', 'vilnius', 'warsaw',
  'wellington', 'yerevan', 'zagreb', 'zurich',
];

/**
 * A name nobody in `taken` is using.
 *
 * A free city first, picked at random so two workbenches made in the same
 * minute do not read as a sequence. Once all are taken, `city-v2`, then
 * `city-v3`, and so on: the lowest suffix that still has a free city.
 */
export function pickWorkbenchName(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set<string>();
  for (const name of taken) used.add(name.trim().toLowerCase());
  const pick = (candidates: string[]): string => {
    const i = Math.min(candidates.length - 1, Math.max(0, Math.floor(random() * candidates.length)));
    return candidates[i];
  };
  for (let version = 1; ; version++) {
    const candidates = WORKBENCH_CITY_NAMES.map((city) => (version === 1 ? city : `${city}-v${version}`)).filter(
      (name) => !used.has(name)
    );
    if (candidates.length > 0) return pick(candidates);
  }
}

/** Longest name `workbenchNameFromTask` builds from the words, before a `-2` suffix. */
export const WORKBENCH_TASK_NAME_MAX = 24;

/**
 * Words that say nothing about the task. Verbs that do (`fix`, `add`,
 * `remove`, `update`) are kept: "fix-login-redirect" reads better than
 * "login-redirect".
 */
const TASK_NAME_STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'and', 'or', 'but', 'of', 'in', 'into', 'on', 'onto', 'for', 'with', 'without',
  'at', 'by', 'from', 'as', 'about', 'so', 'then', 'than', 'if', 'when', 'while', 'up',
  'please', 'pls', 'plz', 'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must',
  'you', 'your', 'we', 'our', 'us', 'i', 'im', 'me', 'my', 'it', 'its', 'lets', 'let',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'make', 'get',
  'this', 'that', 'these', 'those', 'there', 'here', 'some', 'any', 'all',
  'just', 'also', 'now', 'need', 'needs', 'want', 'wants', 'try', 'help', 'hey', 'hi', 'ok', 'okay',
]);

function taskNameWords(text: string): string[] {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !TASK_NAME_STOP_WORDS.has(w));
}

/**
 * A workbench name from the user's first message: the first two or three
 * significant words as a lowercase slug, at most `WORKBENCH_TASK_NAME_MAX`
 * characters. A name in `taken` gets `-2`, `-3`, … When the text has no usable
 * word (empty, only stop words, a script with no ASCII form), it falls back to
 * a city from `pickWorkbenchName`.
 *
 * No model is asked: there is no metered key to ask with, and this runs on
 * every create.
 */
export function workbenchNameFromTask(
  text: string,
  taken: Iterable<string>,
  random: () => number = Math.random
): string {
  const used = new Set<string>();
  for (const name of taken) used.add(name.trim().toLowerCase());

  let base = '';
  for (const word of taskNameWords(text).slice(0, 3)) {
    const next = base ? `${base}-${word}` : word;
    if (next.length > WORKBENCH_TASK_NAME_MAX) {
      if (!base) base = word.slice(0, WORKBENCH_TASK_NAME_MAX);
      break;
    }
    base = next;
  }
  if (!base) return pickWorkbenchName(used, random);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

// ============================================================================
// The next action
// ============================================================================

export type WorkbenchNextAction = 'create_pr' | 'resolve_conflicts' | 'fix_checks' | 'merge' | 'archive' | null;

export interface WorkbenchNextActionInput {
  /** Uncommitted or committed-but-not-on-base changes exist. */
  hasChanges: boolean;
  hasUnpushedCommits?: boolean;
  pr: null | {
    state: 'open' | 'merged' | 'closed';
    mergeable?: 'conflicting' | 'mergeable' | 'unknown';
    ciStatus?: 'success' | 'failure' | 'pending' | 'none';
  };
}

/**
 * The one button the header offers, in Conductor's order: open a PR, then get
 * it mergeable, then green, then merged, then put the workbench away.
 *
 * Conflicts come BEFORE failing checks: a branch that conflicts with its base
 * reruns its checks after the conflict is fixed, so fixing the checks first is
 * work done twice. `pending` CI and `unknown` mergeability answer null — the
 * right action is to wait, and a button that says "Merge" on a PR GitHub has
 * not finished evaluating is a guess. `none` (no checks configured) counts as
 * green, or a repository without CI could never reach Merge.
 */
export function nextWorkbenchAction(input: WorkbenchNextActionInput): WorkbenchNextAction {
  const { pr } = input;
  if (!pr) return input.hasChanges || input.hasUnpushedCommits ? 'create_pr' : null;
  if (pr.state === 'merged' || pr.state === 'closed') return 'archive';
  if (pr.mergeable === 'conflicting') return 'resolve_conflicts';
  if (pr.ciStatus === 'failure') return 'fix_checks';
  if (pr.mergeable === 'unknown' || pr.ciStatus === 'pending') return null;
  if (pr.ciStatus === 'success' || pr.ciStatus === 'none' || pr.ciStatus === undefined) return 'merge';
  return null;
}

// ============================================================================
// Action prompts
// ============================================================================

const SANDBOX_GIT_NOTE =
  'If you are in a Talyn sandbox, `git` and `gh` already work: their traffic goes through the ' +
  'fleet proxy, which attaches the credentials. Do not ask for a token, do not run `gh auth login`, ' +
  'and do not change the git remote URL.';

/**
 * Talyn's default wording for each prompt-driven action. `{{branch}}` and
 * `{{baseBranch}}` (and any other variable the caller passes) are filled in by
 * {@link resolveWorkbenchActionPrompt}.
 */
export const DEFAULT_WORKBENCH_ACTION_PROMPTS: Readonly<Record<WorkbenchPromptAction, string>> = {
  fix_checks: [
    'The CI checks on this branch\'s pull request are failing. Make them pass.',
    '',
    '1. Run `gh pr checks` to see which checks fail, then `gh run view <run-id> --log-failed` for the logs.',
    '2. Find the root cause of each failure. Reproduce it locally when you can (run the same test,',
    '   lint or type check).',
    '3. Fix the cause in the code. Do not skip, delete or weaken a test to make it pass, and do not',
    '   disable a lint rule, unless the check itself is wrong — and then say so.',
    '4. Commit the fix and push the current branch with `git push`.',
    '5. Reply with what failed, why, and what you changed.',
    '',
    SANDBOX_GIT_NOTE,
  ].join('\n'),
  resolve_conflicts: [
    'This branch conflicts with `{{baseBranch}}`. Resolve the conflicts.',
    '',
    '1. Run `git fetch origin {{baseBranch}}` and then `git merge origin/{{baseBranch}}`.',
    '2. For each conflicted file, read both sides and keep the intent of both changes. Do not simply',
    '   take one side.',
    '3. Run the build and the tests for the code you touched to make sure the merge result works.',
    '4. Commit the merge and push the current branch with `git push`.',
    '5. Reply with the files that conflicted and how you resolved each one.',
    '',
    'Do not rebase and do not force-push: the branch may already have reviews on it.',
    '',
    SANDBOX_GIT_NOTE,
  ].join('\n'),
  rename_branch: [
    'Give this branch a descriptive name.',
    '',
    'Read the changes on it (`git diff {{baseBranch}}...HEAD --stat` and the commit messages), then',
    'rename it with `git branch -m <new-name>`. The name: lowercase, words joined by hyphens, a',
    'conventional prefix (`feat/`, `fix/`, `chore/`), under 50 characters.',
    '',
    'If the branch was already pushed, push the new name with `git push -u origin HEAD` and delete',
    'the old remote branch with `git push origin --delete {{branch}}`, but only when no pull request',
    'is open from it.',
    '',
    'Reply with the new name only.',
    '',
    SANDBOX_GIT_NOTE,
  ].join('\n'),
};

/**
 * The prompt for an action: the workbench's override when it has a non-blank
 * one, else Talyn's default, with `{{variable}}` placeholders filled in. An
 * unknown placeholder is left as it stands rather than replaced with nothing,
 * so a typo in an override is visible in the transcript.
 */
export function resolveWorkbenchActionPrompt(
  action: WorkbenchPromptAction,
  settings: WorkbenchSettings | null | undefined,
  variables: Record<string, string> = {}
): string {
  const override = settings?.prompts?.[action];
  const template = override && override.trim() ? override : DEFAULT_WORKBENCH_ACTION_PROMPTS[action];
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match
  );
}

// ============================================================================
// Offered
// ============================================================================

/**
 * Whether the Workbenches surface should be drawn at all.
 *
 * Three-state, exactly `loopsOffered`: `null` means the capability answer has
 * not arrived, and drawing on that flashes the nav item in on every launch. Not
 * authorisation — every route and the terminal bridge gate independently.
 */
export function workbenchesOffered(features: { workbenches?: boolean } | null | undefined): boolean {
  return features?.workbenches === true;
}
