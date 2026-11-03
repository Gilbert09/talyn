/**
 * The setup recipe: steps that sessions on a repository needed, learned from
 * their tool calls, kept per repository, and applied to the setup of later
 * sandboxes and to the repository's bake.
 *
 * Rules, not a model. A step is learned only from a shell command that
 * succeeded, and only when it has one of the shapes below. Each learned step is
 * rewritten into a fixed, quoted form, so what runs later is a command Talyn
 * wrote, not text an agent wrote.
 */
import { validateRepositoryBake, type BakeStep, type RepositoryBake } from './bake.js';
import {
  commandSegments,
  containsSecret,
  formatDurationMs,
  stripCommandPrefix,
  unwrapCommand,
  type TurnToolCall,
  type UnwrappedCommand,
} from './turnTiming.js';
import type { WorkbenchConfig } from './workbenchConfig.js';
import { shellQuote } from './workbenchGit.js';

export type SetupStepKind =
  | 'installer'
  | 'rustup'
  | 'apt'
  | 'brew'
  | 'cargo'
  | 'go'
  | 'gem'
  | 'pip'
  | 'uv'
  | 'node'
  | 'download'
  | 'env'
  | 'docker'
  | 'service'
  | 'compose'
  | 'database'
  | 'other';

/** `install` goes into the bake and the box setup; `start` only into the box setup. */
export type SetupStepPhase = 'install' | 'start';
export type SetupStepSource = 'learned' | 'agent';

export interface SetupStepCandidate {
  command: string;
  kind: SetupStepKind;
  phase: SetupStepPhase;
  why: string;
  /** Commands this step puts on the PATH, when known. */
  provides?: string[];
}

/**
 * - `waiting`: too few of the repository's recent sessions needed it
 *   ({@link setupStepVerdict}). It does not run.
 * - `live`: runs in the setup of every new box.
 * - `failing`: failed on {@link SETUP_STEP_MAX_BOX_FAILURES} boxes in a row. It does not run.
 * - `reverted`: a person reverted it.
 */
export type SetupStepState = 'waiting' | 'live' | 'failing' | 'reverted';

export interface SetupRecipeStep {
  id: string;
  command: string;
  kind: SetupStepKind;
  phase: SetupStepPhase;
  why: string | null;
  source: SetupStepSource;
  state: SetupStepState;
  /** The session that first needed the step. */
  sourceWorkbenchId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Each time a session or an agent recorded the step. */
  seenCount: number;
  /** The different sessions that recorded the step. */
  sessionCount: number;
  /** When the step was seen in enough sessions to run. Null: waiting. */
  confirmedAt: string | null;
  /** When the step went into the bake. Null: box setup only, until the recipe settles. */
  appliedAt: string | null;
  /** A person reverted the step. It is not learned again. */
  disabledAt: string | null;
  disabledReason: string | null;
  /** The step failed in a bake. It still runs in the box setup. */
  bakeDisabledAt: string | null;
  bakeDisabledReason: string | null;
  /** Box setups in a row where the step failed. A success sets it to 0. */
  boxFailureCount: number;
  /** The last box failure, for example `exit 100: E: Unable to locate package x`. */
  boxLastFailure: string | null;
  /** The step failed on too many boxes and no longer runs in the box setup or the bake. */
  boxDisabledAt: string | null;
  boxDisabledReason: string | null;
  /** How long the step took in the last box setup that measured it. */
  lastDurationMs?: number | null;
  /** The step's typical time in the box setup: a rolling mean, see {@link SETUP_STEP_TYPICAL_WEIGHT}. */
  typicalDurationMs?: number | null;
  /** The box setups that measured the step. */
  measuredBoxes?: number;
  /**
   * The repository's sandbox sessions that started in the last
   * {@link SETUP_STEP_WINDOW_DAYS} days and needed the step: they ran it, or,
   * for a live step, they used what it installs.
   */
  recentNeededSessions?: number;
  /** The repository's sandbox sessions that started in the last {@link SETUP_STEP_WINDOW_DAYS} days. */
  recentSessions?: number;
  /** `recentNeededSessions / recentSessions`, 0 to 1. Null: no recent sessions. */
  share?: number | null;
  /** The step installs a browser or a large package set, so it needs a higher share ({@link isHeavySetupStep}). */
  heavy?: boolean;
  /** Why the step is in its state, for example "Waiting: needed by 2 of 31 sessions in the last 14 days. ..." */
  stateReason?: string;
}

/** `GET /repositories/:id/setup-recipe`. */
export interface SetupRecipe {
  repositoryId: string;
  learningDisabled: boolean;
  maxSteps: number;
  /** The window that the share of each step counts sessions in. */
  windowDays?: number;
  /** The times of the last box setup that ran learned steps. Null: none measured yet. */
  lastSetupTiming?: SetupTiming | null;
  steps: SetupRecipeStep[];
}

/** One box setup's times: "Setup took 9m 40s: repository setup 2m 05s, learned steps 7m 35s". */
export interface SetupTiming {
  /** The whole setup script. */
  totalMs: number;
  /** The repository's own setup command. Null: the repository has none. */
  repositoryMs: number | null;
  /** All learned steps together. */
  learnedMs: number;
  measuredAt: string;
  /** The session whose box it was. */
  workbenchId: string | null;
}

/** `POST /repositories/:id/setup-recipe/steps`. */
export interface RecordSetupStepInput {
  command: string;
  why: string;
  /** The session that asks. It must be a session on this repository. */
  sessionId?: string;
}

export interface RecordSetupStepResult {
  steps: SetupRecipeStep[];
}

/**
 * Live steps per repository. Every step runs in the setup of every new box, so
 * this bounds what learning adds to a box's start. Twice the fleet's 10 bake
 * steps: more than that is noise that a person should look at.
 */
export const SETUP_RECIPE_MAX_STEPS = 20;
/** A learned step is one install line. Longer text is a script, not a step. */
export const SETUP_STEP_MAX_BYTES = 1000;
/**
 * New steps reach the bake only after the recipe has had no new step for this
 * long. A change of the bake makes the fleet bake again, so a burst of sessions
 * that each learn something gives one bake, not one per session.
 */
export const SETUP_RECIPE_SETTLE_MS = 15 * 60_000;
/** Learned bake steps are named `talyn-learned <step id>`, so a bake result names its step. */
export const LEARNED_BAKE_STEP_PREFIX = 'talyn-learned ';
/**
 * A step runs on every new box, so it must be a need of most work on the
 * repository, not of one task (a browser for one test, a database for one
 * script). Talyn measures the need as a share: the repository's sandbox
 * sessions of the last {@link SETUP_STEP_WINDOW_DAYS} days that needed the step.
 *
 * Two weeks holds a normal work cycle (a sprint, a release), so a step that
 * one week of work needed does not fall out in the next quiet week.
 */
export const SETUP_STEP_WINDOW_DAYS = 14;
/**
 * A step goes live only when at least this many different sessions needed it.
 * On a quiet repository, a share of 2 sessions can be 100%, and 2 sessions can
 * be the same task done twice.
 */
export const SETUP_STEP_MIN_SESSIONS = 3;
/** A step goes live at this share of recent sessions: about one session in three. */
export const SETUP_STEP_LIVE_SHARE = 0.3;
/**
 * A live step goes back to waiting below this share. Half of
 * {@link SETUP_STEP_LIVE_SHARE}, so a step near the bar does not go in and out
 * with each session.
 */
export const SETUP_STEP_DROP_SHARE = 0.15;
/**
 * The bars for a heavy step ({@link isHeavySetupStep}). A browser download
 * costs every box minutes and hundreds of megabytes, so it must be a need of
 * half the work.
 */
export const SETUP_STEP_HEAVY_LIVE_SHARE = 0.5;
export const SETUP_STEP_HEAVY_DROP_SHARE = 0.25;
/**
 * A live step leaves only when the window has at least this many sessions.
 * With 7 sessions, one session moves the share by less than 15 points, the gap
 * between {@link SETUP_STEP_LIVE_SHARE} and {@link SETUP_STEP_DROP_SHARE}. So
 * one session cannot take a step out, and the next put it back.
 */
export const SETUP_STEP_MIN_SESSIONS_TO_DROP = 7;
/**
 * A step that failed in the box setup this many times in a row stops running.
 * One failure can be a bad box (a full disk, a lost network); two in a row is
 * the step.
 */
export const SETUP_STEP_MAX_BOX_FAILURES = 2;
/** The time limit of one learned step in the box setup, in seconds. */
export const SETUP_STEP_TIMEOUT_SEC: Record<SetupStepKind, number> = {
  installer: 600,
  rustup: 600,
  apt: 600,
  brew: 600,
  // A cargo install that compiles from source takes about ten minutes.
  cargo: 900,
  go: 600,
  gem: 600,
  pip: 600,
  uv: 600,
  node: 600,
  download: 300,
  env: 30,
  docker: 120,
  service: 120,
  // A compose start pulls its images first, which is an install in time.
  compose: 600,
  database: 120,
  other: 600,
};
/** After the time limit, `timeout` sends TERM, then KILL after this many seconds. */
export const SETUP_STEP_KILL_AFTER_SEC = 10;
/**
 * The weight of the newest box in a step's typical time:
 * `typical = typical * (1 - w) + last * w`. With 0.2, the last 10 boxes carry
 * about 90% of the value, so one slow box (a cold cache) moves it a little and
 * a step that became fast (it went into the bake) shows that within days.
 */
export const SETUP_STEP_TYPICAL_WEIGHT = 0.2;
/** The next typical time of a step, from its typical time and a new measurement. */
export function nextTypicalDurationMs(typical: number | null | undefined, lastMs: number): number {
  if (typical === null || typical === undefined) return Math.round(lastMs);
  return Math.round(typical * (1 - SETUP_STEP_TYPICAL_WEIGHT) + lastMs * SETUP_STEP_TYPICAL_WEIGHT);
}
/**
 * A step that typically takes this long on a box is slow: it gets the heavy
 * bars of the frequency rule ({@link setupStepVerdict}). Two minutes added to
 * every box start is what a person notices, and a step that few sessions need
 * is not worth that.
 */
export const SETUP_STEP_SLOW_MS = 2 * 60_000;

// ============================================================================
// Refusals
// ============================================================================

/**
 * Hosts whose install script may be piped into a shell. Each is the official
 * installer of a toolchain that a learned step can then use, and each is
 * served over HTTPS by the project itself:
 * - sh.rustup.rs: rustup, the Rust toolchain installer (cargo install needs it).
 * - astral.sh: uv and ruff, Python's package manager and linter.
 * - get.pnpm.io: pnpm, when the image has no corepack.
 * Docker is in the base image, so its installer is not needed.
 */
const INSTALLERS: ReadonlyArray<{ url: RegExp; kind: SetupStepKind; provides: (m: RegExpExecArray) => string[]; command: (url: string, m: RegExpExecArray) => string }> = [
  {
    url: /^https:\/\/(?:sh\.rustup\.rs|static\.rust-lang\.org\/rustup\/rustup-init\.sh)\/?$/,
    kind: 'rustup',
    provides: () => ['rustup', 'cargo', 'rustc'],
    command: () => "command -v cargo >/dev/null 2>&1 || curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal",
  },
  {
    url: /^https:\/\/astral\.sh\/(uv|ruff)\/(?:[0-9][\w.]*\/)?install\.sh$/,
    kind: 'installer',
    provides: (m) => (m[1] === 'uv' ? ['uv', 'uvx'] : [m[1]]),
    command: (url, m) => `command -v ${m[1]} >/dev/null 2>&1 || curl -LsSf ${url} | sh`,
  },
  {
    url: /^https:\/\/get\.pnpm\.io\/install\.sh$/,
    kind: 'installer',
    provides: () => ['pnpm'],
    command: () => 'command -v pnpm >/dev/null 2>&1 || curl -fsSL https://get.pnpm.io/install.sh | sh -',
  },
];

/**
 * Hosts a learned download may come from: public artifact hosts the fleet's
 * own bakes already reach. A file download stays inert until something runs
 * it, so this list is wider than {@link INSTALLERS}.
 */
const DOWNLOAD_URL = /^https:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/|objects\.githubusercontent\.com\/|release-assets\.githubusercontent\.com\/|dl\.google\.com\/|go\.dev\/dl\/|nodejs\.org\/dist\/|static\.rust-lang\.org\/|astral\.sh\/)\S+$/;

const PIPE_TO_SHELL = /\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da|k)?sh\b|\b(?:ba|z)?sh\s+(?:-\w+\s+)*<\(|\$\((?:curl|wget)\b|\beval\b|\bsource\s+<\(/;
const SENDS_DATA = /\b(?:curl|wget)\b[^|;&]*\s(?:-d|--data(?:-\w+)?|-F|--form|-T|--upload-file|-X\s*(?:POST|PUT|PATCH)|--post-(?:data|file))\b|\b(?:nc|ncat|netcat|scp|sftp|ssh|telnet)\s/;
const DANGEROUS = /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+\/(?:\s|$|\*)|\bgit\s+push\b|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{|\bchmod\s+-R\s+777\s+\//;
const CREDENTIAL_PATHS = /(?:\.ssh\/|\.git-credentials|\.netrc|\.aws\/|\.config\/gh\b|\/run\/fleet|\.docker\/config\.json|\.npmrc|\.pypirc)/;
const SECRET_VARIABLE = /\$\{?[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z0-9_]*\}?/i;

/**
 * Why a step must not be stored or applied, or null when it may. Learned and
 * agent-recorded steps both pass through here before they are stored.
 */
export function setupStepRefusal(command: string, opts: { canonical?: boolean } = {}): string | null {
  const bytes = new TextEncoder().encode(command).length;
  if (!command.trim()) return 'The command is empty.';
  if (bytes > SETUP_STEP_MAX_BYTES) return `The command is ${bytes} bytes. A setup step can have at most ${SETUP_STEP_MAX_BYTES}.`;
  if (command.includes('\0')) return 'The command contains a NUL byte.';
  if (containsSecret(command) || SECRET_VARIABLE.test(command)) return 'The command looks like it contains a secret (a token, key or password). Talyn never stores one in a setup step.';
  if (CREDENTIAL_PATHS.test(command)) return 'The command reads or writes a credential file.';
  if (SENDS_DATA.test(command)) return 'The command sends data out of the sandbox.';
  if (DANGEROUS.test(command)) return 'The command can destroy data or push code.';
  // Talyn's own installer commands pipe into sh on purpose; their hosts are allow-listed.
  if (!opts.canonical && PIPE_TO_SHELL.test(command)) {
    return 'The command runs a downloaded script. Only the official rustup, uv and pnpm installers are applied automatically.';
  }
  return null;
}

// ============================================================================
// Extraction
// ============================================================================

const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'exec_command', 'local_shell']);
const PACKAGE = /^[A-Za-z0-9@][A-Za-z0-9@+.:~=_/<>!,*^[\]-]*$/;
const SAFE_NAME = /^[A-Za-z0-9_][\w@.+-]*$/;

/** Split one simple command into words. Null when the shell would expand or redirect something. */
export function shellWords(segment: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < segment.length) cur += segment[++i];
      else if (c === '$' || c === '`') return null;
      else cur += c;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < segment.length) { cur += segment[++i]; has = true; continue; }
    if ('|<>;&`$(){}*?[]!#'.includes(c)) return null;
    cur += c;
    has = true;
  }
  if (quote) return null;
  if (has) out.push(cur);
  return out;
}

/** Remove output redirections and trailing output filters (`| tail -20`), which change nothing a step needs. */
function withoutOutputPlumbing(segment: string): string {
  return segment
    .replace(/\s*\|\s*(?:tail|head|grep|tee|cat|less|sort|uniq)\b[^|]*$/, '')
    .replace(/\s+(?:\d?>>?|&>>?)\s*(?:&\d|\/dev\/null|\S+\.log)\b/g, '')
    .replace(/\s+\d>&\d\b/g, '')
    .trim();
}

const quoteAll = (words: string[]) => words.map(shellQuote).join(' ');

/** Flags whose next word is a value, so the value is not a package name. */
const VALUE_FLAGS = new Set([
  '--version', '--features', '-F', '--git', '--branch', '--tag', '--rev', '--root', '--target', '--profile', '--bin',
  '--registry', '--index', '-j', '--jobs', '--index-url', '-i', '--extra-index-url', '--python', '-p', '--with',
  '--filter', '-C', '--dir', '--prefix', '-f', '--file', '--project-name', '--env-file', '--project-directory',
]);

function names(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith('-')) {
      if (VALUE_FLAGS.has(w)) i++;
      continue;
    }
    out.push(w);
  }
  return out;
}

const packageName = (spec: string) => spec.replace(/^@/, '\u0000').split(/[@=<>!~[\s]/)[0].replace('\u0000', '@');

interface Parsed {
  command: string;
  kind: SetupStepKind;
  phase: SetupStepPhase;
  provides?: string[];
  /** Runs where the checkout is, so it needs the directory it ran in. */
  inCheckout?: boolean;
  why?: string;
}

type ParseResult = Parsed | { refused: string } | null;

/**
 * The Docker start that Talyn used to learn. Docker now starts on demand in the
 * sandbox: the first client on /var/run/docker.sock starts dockerd. This start
 * also failed as uid 1000 (it writes /var/log/dockerd.log), and its
 * `docker info` loop could hang. Stored steps with this exact command are
 * skipped when a box is set up, so no migration is needed.
 */
export const LEGACY_DOCKER_START_COMMAND =
  "pgrep -x dockerd >/dev/null 2>&1 || (nohup dockerd >/var/log/dockerd.log 2>&1 &); for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done";

const DOCKER_ON_DEMAND = 'Docker starts on demand in the sandbox, so Talyn does not learn a Docker start.';

/** How the original command ran: under sudo, as which user, and with which variables. */
interface RunAs {
  sudo: boolean;
  user: string | null;
  /** Leading `NAME=value` words that are kept, see {@link KEPT_ENV}. */
  env: string[];
}

/**
 * Leading variables a step keeps. Each one configures the tool that the step
 * runs, for example `PIP_BREAK_SYSTEM_PACKAGES=1 pip install x`, which fails
 * on Debian without it. Other variables are dropped: a variable such as
 * LD_PRELOAD or BASH_ENV changes what runs, so it must not reach every box.
 */
const KEPT_ENV = /^(?:(?:PIP|UV|NPM_CONFIG|npm_config|PNPM|YARN|CARGO|RUSTUP|PLAYWRIGHT|BUNDLE|GEM)_\w+|RUSTFLAGS|GOFLAGS|GOPROXY|GOPRIVATE|GONOSUMDB|GOBIN|GOTOOLCHAIN|CGO_ENABLED)$/;
const SECRET_NAME = /TOKEN|AUTH|PASS|SECRET|KEY|CRED/i;
const SAFE_USER = /^[a-z_][a-z0-9_-]*$/;

function runAsOf(u: UnwrappedCommand): RunAs | null {
  if (u.sudoUser !== null && !SAFE_USER.test(u.sudoUser)) return null;
  const env: string[] = [];
  for (const word of u.assignments) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(?:'([^']*)'|"([^"]*)"|(\S*))$/.exec(word);
    if (!m || !KEPT_ENV.test(m[1]) || SECRET_NAME.test(m[1])) continue;
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (/^[\w@%+=:,./-]*$/.test(value)) env.push(`${m[1]}=${value}`);
  }
  return { sudo: u.sudo, user: u.sudoUser, env };
}

/**
 * The words in front of a step's command. A step runs as the user its
 * command ran as: `sudo` in the command gives `sudo -n` in the step, so it can
 * run as uid 1000 and never waits for a password. `root` forces sudo for the
 * commands that only root can run.
 */
function runPrefix(run: RunAs, opts: { root?: boolean; env?: boolean; user?: boolean } = {}): string {
  const words: string[] = [];
  if (run.sudo || opts.root) {
    words.push('sudo', '-n');
    if (opts.user !== false && run.user) words.push('-u', run.user);
  }
  if (opts.env !== false && run.env.length > 0) words.push('env', ...run.env);
  return words.length > 0 ? `${quoteAll(words)} ` : '';
}

function parseInstaller(segment: string): ParseResult {
  if (!PIPE_TO_SHELL.test(segment) || !/\b(?:curl|wget)\b/.test(segment)) return null;
  const url = /https?:\/\/[^\s'"|)]+/.exec(segment)?.[0];
  if (!url) return { refused: 'The command runs a downloaded script.' };
  for (const installer of INSTALLERS) {
    const m = installer.url.exec(url);
    if (m) return { command: installer.command(url, m), kind: installer.kind, phase: 'install', provides: installer.provides(m) };
  }
  return { refused: `The command runs a script from ${url}, which is not one of the installers Talyn applies automatically (rustup, uv, pnpm).` };
}

/**
 * apt runs as root, so the step always has `sudo -n`. Kept options:
 * `--no-install-recommends` (without it the step installs more than the
 * session did) and the target release. `-o` and `-c` can run any command as
 * root, so a command with them is not learned.
 */
function parseApt(w: string[]): ParseResult {
  const at = w.indexOf('install');
  if (at < 0) return null;
  const args = w.slice(at + 1);
  const pkgs: string[] = [];
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['-o', '-c', '--option', '--config-file'].includes(a) || /^--(?:option|config-file)=/.test(a) || /^-[oc]./.test(a)) return null;
    if (a === '-t' || a === '--target-release') {
      const release = args[++i];
      if (!release || !SAFE_NAME.test(release)) return null;
      kept.push('-t', release);
    } else if (a === '--no-install-recommends') {
      if (!kept.includes(a)) kept.push(a);
    } else if (!a.startsWith('-')) {
      pkgs.push(a);
    }
  }
  const list = [...new Set(pkgs)].sort();
  if (list.length === 0 || !list.every((p) => /^[A-Za-z0-9][A-Za-z0-9+.:~=_-]*$/.test(p))) return null;
  const install = `sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y ${quoteAll([...kept, ...list])}`;
  return {
    command: `${install} || (sudo -n apt-get update && ${install})`,
    kind: 'apt',
    phase: 'install',
    provides: list.map(packageName),
  };
}

function parsePip(w: string[], head: string[], run: RunAs): ParseResult {
  const at = w.indexOf('install');
  if (at < 0) return null;
  const args = w.slice(at + 1);
  if (args.length === 0) return null;
  const project = args.some((a) => ['-r', '--requirement', '-e', '--editable', '.'].includes(a));
  const pkgs = names(args);
  if (!project && (pkgs.length === 0 || !pkgs.every((p) => PACKAGE.test(p)))) return null;
  return { command: runPrefix(run) + quoteAll([...head, 'install', ...args]), kind: 'pip', phase: 'install', inCheckout: project, provides: project ? [] : pkgs.map(packageName) };
}

function parseUv(w: string[], run: RunAs): ParseResult {
  const sub = w[1];
  const command = runPrefix(run) + quoteAll(w);
  if (sub === 'sync') return { command, kind: 'uv', phase: 'install', inCheckout: true };
  if (sub === 'pip' && w[2] === 'install' && w.length > 3) return { command, kind: 'uv', phase: 'install', inCheckout: true };
  if ((sub === 'tool' || sub === 'python') && w[2] === 'install') {
    const pkgs = names(w.slice(3));
    if (pkgs.length === 0 || !pkgs.every((p) => PACKAGE.test(p))) return null;
    return { command, kind: 'uv', phase: 'install', provides: sub === 'tool' ? pkgs.map(packageName) : [] };
  }
  return null;
}

function parseNode(w: string[], run: RunAs): ParseResult {
  const [tool, sub] = w;
  const rest = w.slice(2);
  const global = rest.includes('-g') || rest.includes('--global');
  const pkgs = names(rest);
  const pre = runPrefix(run);
  if (tool === 'corepack' && ['enable', 'prepare', 'install'].includes(sub ?? '')) {
    return { command: pre + quoteAll(w), kind: 'node', phase: 'install' };
  }
  if (tool === 'playwright' && sub === 'install') {
    return { command: `${pre}npx ${quoteAll(w)}`, kind: 'node', phase: 'install', inCheckout: true, provides: ['playwright'] };
  }
  if (tool === 'yarn' && sub === 'global' && w[2] === 'add' && w.length > 3) {
    return { command: pre + quoteAll(w), kind: 'node', phase: 'install', provides: names(w.slice(3)).map(packageName) };
  }
  const installs = (tool === 'npm' && ['install', 'i', 'ci', 'add'].includes(sub ?? ''))
    || ((tool === 'pnpm' || tool === 'bun') && ['install', 'i', 'add'].includes(sub ?? ''))
    || (tool === 'yarn' && (sub === undefined || sub === 'install' || sub.startsWith('-')));
  if (!installs) return null;
  if (global) {
    if (pkgs.length === 0 || !pkgs.every((p) => PACKAGE.test(p))) return null;
    return { command: pre + quoteAll(w), kind: 'node', phase: 'install', provides: pkgs.map(packageName) };
  }
  // A package named without -g is a dependency change, which belongs in the code, not the setup.
  if (pkgs.length > 0 || sub === 'add') return null;
  return { command: pre + quoteAll(w), kind: 'node', phase: 'install', inCheckout: true };
}

const BINSTALL_YES = new Set(['-y', '--no-confirm']);

/**
 * One form for one cargo install: `crate --version v` becomes `crate@v`, and
 * `cargo binstall` gets one `-y` after `binstall`. cargo-binstall refuses `-y`
 * and `--no-confirm` together ("cannot be used multiple times"), because `-y`
 * is `--no-confirm`.
 */
export function canonicalCargoWords(w: string[]): string[] {
  const sub = w[1];
  let rest = w.slice(2);
  if (sub === 'binstall') rest = rest.filter((a) => !BINSTALL_YES.has(a));
  const v = rest.indexOf('--version');
  const version = v >= 0 ? rest[v + 1] : undefined;
  if (version && /^[\w.+-]+$/.test(version) && !rest.includes('--git')) {
    const without = rest.filter((_, i) => i !== v && i !== v + 1);
    const crates = names(without);
    if (crates.length === 1 && !crates[0].includes('@')) {
      let done = false;
      rest = without.map((a, i) => {
        if (done || a !== crates[0] || (i > 0 && VALUE_FLAGS.has(without[i - 1]))) return a;
        done = true;
        return `${a}@${version}`;
      });
    }
  }
  return [w[0], sub, ...(sub === 'binstall' ? ['-y'] : []), ...rest];
}

function parseCargo(w: string[], run: RunAs): ParseResult {
  const sub = w[1];
  if (sub !== 'install' && sub !== 'binstall') return null;
  const rest = w.slice(2);
  if (rest.includes('--path')) return null;
  const crates = names(rest);
  if (crates.length === 0 && !rest.includes('--git')) return null;
  if (!crates.every((c) => /^[A-Za-z0-9_][\w-]*(?:@[\w.+-]+)?$/.test(c))) return null;
  return { command: runPrefix(run) + quoteAll(canonicalCargoWords(w)), kind: 'cargo', phase: 'install', provides: crates.map(packageName) };
}

function parseRustup(w: string[], run: RunAs): ParseResult {
  const sub = w[1];
  const ok = (sub === 'toolchain' && w[2] === 'install') || sub === 'default' || sub === 'install'
    || ((sub === 'target' || sub === 'component') && w[2] === 'add');
  if (!ok || w.length < 3 || !names(w.slice(2)).every((n) => SAFE_NAME.test(n))) return null;
  return { command: runPrefix(run) + quoteAll(w), kind: 'rustup', phase: 'install', provides: sub === 'target' || sub === 'component' ? [] : ['rustc', 'cargo'] };
}

function parseGo(w: string[], run: RunAs): ParseResult {
  if (w[1] === 'mod' && w[2] === 'download') return { command: runPrefix(run) + quoteAll(w), kind: 'go', phase: 'install', inCheckout: true };
  if (w[1] !== 'install') return null;
  const pkgs = names(w.slice(2));
  if (pkgs.length === 0 || !pkgs.every((p) => /^[\w.~/-]+@[\w.+-]+$/.test(p))) return null;
  return { command: runPrefix(run) + quoteAll(w), kind: 'go', phase: 'install', provides: pkgs.map((p) => p.split('@')[0].split('/').pop() ?? p) };
}

/** brew refuses to run as root, so a brew step never gets sudo. */
function parseBrewOrGem(w: string[], run: RunAs): ParseResult {
  const [tool, sub] = w;
  const pre = tool === 'brew' ? runPrefix({ ...run, sudo: false }) : runPrefix(run);
  if (tool === 'bundle' && (sub === undefined || sub === 'install')) return { command: pre + quoteAll(w), kind: 'gem', phase: 'install', inCheckout: true };
  if (sub !== 'install') return null;
  const pkgs = names(w.slice(2));
  if (pkgs.length === 0 || !pkgs.every((p) => SAFE_NAME.test(p))) return null;
  return { command: pre + quoteAll(w), kind: tool === 'brew' ? 'brew' : 'gem', phase: 'install', provides: pkgs };
}

/** /usr/local/bin belongs to root, so the download and the chmod have `sudo -n`. */
function parseDownload(w: string[]): ParseResult {
  const tool = w[0];
  const url = w.find((x) => /^https?:\/\//.test(x));
  const outFlag = tool === 'curl' ? ['-o', '--output'] : ['-O', '--output-document'];
  const at = w.findIndex((x) => outFlag.includes(x));
  const dest = at >= 0 ? w[at + 1] : undefined;
  if (!url || !dest || !/^\/usr\/local\/bin\/[\w.+-]+$/.test(dest)) return null;
  if (!DOWNLOAD_URL.test(url)) {
    return { refused: `The download comes from ${url}. Talyn applies downloads automatically only from public artifact hosts such as GitHub releases.` };
  }
  return {
    command: `[ -x ${dest} ] || { sudo -n curl -fsSL ${shellQuote(url)} -o ${dest} && sudo -n chmod +x ${dest}; }`,
    kind: 'download',
    phase: 'install',
    provides: [dest.split('/').pop()!],
  };
}

function parseCompose(w: string[], run: RunAs): ParseResult {
  const base = w[0] === 'docker-compose' ? 1 : w[0] === 'docker' && w[1] === 'compose' ? 2 : -1;
  if (base < 0) return null;
  const up = w.indexOf('up', base);
  if (up < 0) return null;
  const global = w.slice(base, up);
  const args = w.slice(up + 1);
  if (![...global, ...args].every((x) => /^[\w@%+=:,./-]+$/.test(x))) return null;
  const detached = args.some((a) => a === '-d' || a === '--detach' || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(a));
  return {
    command: runPrefix(run) + quoteAll(['docker', 'compose', ...global, 'up', ...(detached ? [] : ['-d']), ...args]),
    kind: 'compose',
    phase: 'start',
    inCheckout: true,
  };
}

/**
 * Service starts. `service`, `systemctl`, init scripts and `pg_ctlcluster`
 * need root, so they always get `sudo -n`. A Docker start is recognised and
 * refused: Docker starts on demand in the sandbox.
 */
function parseService(w: string[], run: RunAs): ParseResult {
  const [tool] = w;
  if (tool === 'dockerd') return { refused: DOCKER_ON_DEMAND };
  let name: string | undefined;
  if (tool === 'service' && ['start', 'restart'].includes(w[2] ?? '')) name = w[1];
  else if (tool === 'systemctl' && ['start', 'restart'].includes(w[1] ?? '')) name = w[2];
  else if (/^\/etc\/init\.d\/[\w@.-]+$/.test(tool) && ['start', 'restart'].includes(w[1] ?? '')) name = tool.split('/').pop();
  if (name === 'docker' || name === 'docker.service') return { refused: DOCKER_ON_DEMAND };
  if (name && SAFE_NAME.test(name) && w.length <= 3) return { command: runPrefix(run, { root: true, env: false }) + quoteAll(w), kind: 'service', phase: 'start' };
  if ((tool === 'pg_ctlcluster' && w.length === 4 && w[3] === 'start') || (tool === 'redis-server' && w.includes('--daemonize'))) {
    const pre = runPrefix(run, { root: tool === 'pg_ctlcluster', env: false });
    if (w.every((x) => /^[\w@%+=:,./-]+$/.test(x))) return { command: pre + quoteAll(w), kind: 'service', phase: 'start' };
  }
  return null;
}

/** `sudo -u postgres createdb x` keeps its user: as uid 1000 it fails, and `|| true` would hide that. */
function parseDatabase(w: string[], run: RunAs): ParseResult {
  const pre = runPrefix(run, { env: false });
  if (w[0] === 'createdb' && names(w.slice(1)).length >= 1) {
    return { command: `${pre}${quoteAll(w)} 2>/dev/null || true`, kind: 'database', phase: 'start' };
  }
  if (w[0] === 'psql') {
    const at = w.findIndex((x) => x === '-c' || x === '--command');
    const sql = at >= 0 ? w[at + 1] : undefined;
    if (sql && /^\s*create\s+(?:database|role|user|extension|schema)\b/i.test(sql) && !/;\s*\S/.test(sql)) {
      return { command: `${pre}${quoteAll(w)} || true`, kind: 'database', phase: 'start' };
    }
  }
  return null;
}

/** `export NAME=value`, kept as a line in ~/.bashrc so later shells have it. */
function parseExport(segment: string): ParseResult {
  const m = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"`\\]*)"|'([^']*)'|([^\s'"`\\;|&]*))$/.exec(segment.trim());
  if (!m) return null;
  const value = m[2] ?? m[3] ?? m[4] ?? '';
  if (value.includes('$(') || /[\n"]/.test(value)) return null;
  const line = `export ${m[1]}="${value}"`;
  return {
    command: `grep -qxF ${shellQuote(line)} ~/.bashrc 2>/dev/null || echo ${shellQuote(line)} >> ~/.bashrc`,
    kind: 'env',
    phase: 'start',
  };
}

/** Runners that pick the environment a command runs in. `npx` and friends only find a JS tool. */
const ENV_RUNNERS = /^(?:uv|poetry|pipenv|hatch|pdm) run$|^bundle exec$/;

function parseSegment(raw: string, opts: { inVenv?: boolean } = {}): ParseResult {
  const installer = parseInstaller(stripCommandPrefix(raw));
  if (installer) return installer;
  const unwrapped = unwrapCommand(raw);
  const run = runAsOf(unwrapped);
  if (!run) return null;
  const segment = withoutOutputPlumbing(unwrapped.command);
  if (/^export\s/.test(segment)) return null;
  const w = shellWords(segment);
  if (!w || w.length === 0) return null;
  const [tool] = w;
  // `uv run pip install x` installs into the project's environment. Without
  // the runner the step would install into the system Python, so it is not learned.
  if (unwrapped.runner && ENV_RUNNERS.test(unwrapped.runner)) return null;
  if (tool === 'apt' || tool === 'apt-get') return parseApt(w);
  const isPip = tool === 'pip' || tool === 'pip3' || (/^python3?(?:\.\d+)?$/.test(tool) && w[1] === '-m' && w[2] === 'pip');
  // The same for a pip after `source .venv/bin/activate`: the box has no such environment yet.
  if (isPip && opts.inVenv) return null;
  if (tool === 'pip' || tool === 'pip3') return parsePip(w.slice(1), [tool], run);
  if (isPip) return parsePip(w.slice(3), w.slice(0, 3), run);
  if (tool === 'uv') return parseUv(w, run);
  if (['npm', 'pnpm', 'yarn', 'bun', 'corepack', 'playwright'].includes(tool)) return parseNode(w, run);
  if (tool === 'cargo') return parseCargo(w, run);
  if (tool === 'rustup') return parseRustup(w, run);
  if (tool === 'go') return parseGo(w, run);
  if (tool === 'brew' || tool === 'gem' || tool === 'bundle') return parseBrewOrGem(w, run);
  if (tool === 'curl' || tool === 'wget') return parseDownload(w);
  if (tool === 'docker' || tool === 'docker-compose') return parseCompose(w, run);
  if (tool === 'createdb' || tool === 'psql') return parseDatabase(w, run);
  return parseService(w, run);
}

/** The directory after `cd <dir>`, relative to the checkout. Null: not known. */
function nextDir(current: string | null, target: string | undefined, repoDir?: string): string | null {
  if (!target || target === '-' || target.startsWith('~') || target.includes('$')) return null;
  if (target.startsWith('/')) {
    if (!repoDir) return null;
    if (target === repoDir || target === `${repoDir}/`) return '';
    if (!target.startsWith(`${repoDir}/`)) return null;
    target = target.slice(repoDir.length + 1);
    current = '';
  }
  if (current === null) return null;
  const parts = current ? current.split('/') : [];
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' || !/^[\w.@+-]+$/.test(part)) return null;
    parts.push(part);
  }
  return parts.join('/');
}

const DEFAULT_WHY: Record<SetupStepKind, string> = {
  installer: 'A session installed this toolchain.',
  rustup: 'A session installed this Rust toolchain.',
  apt: 'A session installed these system packages.',
  brew: 'A session installed this package.',
  cargo: 'A session installed this tool with cargo.',
  go: 'A session installed this Go tool or module.',
  gem: 'A session installed these gems.',
  pip: 'A session installed these Python packages.',
  uv: 'A session installed these Python packages with uv.',
  node: 'A session installed these JavaScript packages.',
  download: 'A session downloaded this tool.',
  env: 'A session set this environment variable.',
  docker: 'A session started the Docker daemon.',
  service: 'A session started this service.',
  compose: 'A session started these Docker Compose services.',
  database: 'A session created this database.',
  other: 'An agent recorded this step.',
};

export interface SetupExtraction {
  steps: SetupStepCandidate[];
  refused: Array<{ command: string; reason: string }>;
}

/**
 * The setup steps in one shell command. `cd` moves the directory that later
 * steps in the checkout run in; a step in the checkout after a `cd` Talyn
 * cannot follow is dropped.
 */
export function stepsFromCommand(command: string, opts: { repoDir?: string } = {}): SetupExtraction {
  const out: SetupExtraction = { steps: [], refused: [] };
  const segments = commandSegments(command);
  // Only a command made of exports is an environment setup; `export X=1 && pytest` is a one-off.
  const onlyExports = segments.length > 0 && segments.every((s) => /^export\s/.test(s.trim()));
  let dir: string | null = '';
  let inVenv = false;
  for (const raw of segments) {
    const stripped = stripCommandPrefix(raw);
    const cd = /^(?:cd|pushd)(?:\s+(.*))?$/.exec(stripped);
    if (cd) {
      const words = shellWords(cd[1] ?? '');
      dir = words && words.length === 1 ? nextDir(dir, words[0], opts.repoDir) : null;
      continue;
    }
    if (/^(?:source|\.)\s+\S*bin\/activate\b/.test(stripped)) {
      inVenv = true;
      continue;
    }
    const parsed = onlyExports ? parseExport(stripped) : parseSegment(raw, { inVenv });
    if (!parsed) continue;
    if ('refused' in parsed) {
      out.refused.push({ command: raw.trim(), reason: parsed.refused });
      continue;
    }
    if (parsed.inCheckout && dir === null) continue;
    const full = parsed.inCheckout && dir ? `cd ${shellQuote(dir)} && ${parsed.command}` : parsed.command;
    const refusal = containsSecret(raw) ? 'The command looks like it contains a secret (a token, key or password). Talyn never stores one in a setup step.'
      : setupStepRefusal(full, { canonical: true });
    if (refusal) {
      out.refused.push({ command: raw.trim(), reason: refusal });
      continue;
    }
    out.steps.push({
      command: full,
      kind: parsed.kind,
      phase: parsed.phase,
      why: parsed.why ?? DEFAULT_WHY[parsed.kind],
      ...(parsed.provides?.length ? { provides: parsed.provides } : {}),
    });
  }
  return out;
}

const NOT_FOUND: RegExp[] = [
  /([A-Za-z0-9][\w.+-]*): command not found/g,
  /command not found: ([A-Za-z0-9][\w.+-]*)/g,
  /\bsh: \d+: ([A-Za-z0-9][\w.+-]*): not found/g,
];

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/** The commands a failed call's output says are missing. */
export function missingCommands(output: string): string[] {
  const found: string[] = [];
  for (const pattern of NOT_FOUND) {
    for (const m of output.matchAll(pattern)) {
      // `zsh: command not found: uv` names the shell first.
      if (!SHELLS.has(m[1]) && !found.includes(m[1])) found.push(m[1]);
    }
  }
  return found;
}

function provides(step: SetupStepCandidate, bin: string): boolean {
  return (step.provides ?? []).some((p) => {
    const name = p.split('/').pop() ?? p;
    return name === bin || name === `${bin}-cli` || name.startsWith(`${bin}-`) || name === `cargo-${bin}`;
  });
}

/**
 * The setup steps of one turn, in order and without duplicates. A failed call
 * that printed "command not found" is linked to the next install that
 * provides that command (or, failing a match, the next install at all): the
 * step says what it fixed, and its replay first checks whether the command is
 * already there.
 *
 * Only installs are learned. A start (a service, a compose stack, an exported
 * variable, a database) is what one task needed, so Talyn never learns one
 * from tool calls. An agent can still record one with `talyn_record_setup_step`.
 */
export function extractSetupSteps(calls: TurnToolCall[], opts: { repoDir?: string } = {}): SetupExtraction {
  const out: SetupExtraction = { steps: [], refused: [] };
  const seen = new Set<string>();
  const missing: Array<{ bin: string; at: number }> = [];
  const found: Array<{ step: SetupStepCandidate; at: number; linked?: string }> = [];
  [...calls].sort((a, b) => a.startedAt - b.startedAt).forEach((call, at) => {
    if (!SHELL_TOOLS.has(call.name) || !call.command) return;
    if (call.isError) {
      for (const bin of missingCommands(call.output ?? '')) {
        if (!missing.some((m) => m.bin === bin)) missing.push({ bin, at });
      }
      return;
    }
    const steps = stepsFromCommand(call.command, opts);
    out.refused.push(...steps.refused);
    for (const step of steps.steps) {
      if (step.phase !== 'install' || seen.has(step.command)) continue;
      seen.add(step.command);
      found.push({ step, at });
    }
  });
  // First the installs that name the missing command, then any later install.
  const link = (bin: string, entry: (typeof found)[number] | undefined) => {
    if (entry) entry.linked = bin;
    return Boolean(entry);
  };
  const unlinked = missing.filter(({ bin, at }) => !link(bin, found.find((f) => !f.linked && f.at > at && provides(f.step, bin))));
  for (const { bin, at } of unlinked) link(bin, found.find((f) => !f.linked && f.at > at && f.step.phase === 'install'));
  for (const { step, linked } of found) {
    if (linked) {
      step.why = `\`${linked}\` was missing ("command not found"). This step installed it.`;
      if (/^[\w.+-]+$/.test(linked) && !step.command.startsWith(`command -v ${linked} `)) {
        step.command = `command -v ${linked} >/dev/null 2>&1 || ${step.command}`;
      }
    }
    out.steps.push(step);
  }
  return out;
}

/**
 * An agent's own step (`talyn_record_setup_step`). A command with a known shape
 * becomes Talyn's fixed form of it; any other command is kept as written, runs
 * only in the box setup, and must pass {@link setupStepRefusal}.
 */
export function prepareRecordedStep(command: string, why: string): SetupExtraction {
  const trimmed = command.trim();
  const plain = setupStepRefusal(trimmed);
  const known = stepsFromCommand(trimmed);
  if (known.steps.length > 0 && known.refused.length === 0 && !plain) {
    return { steps: known.steps.map((s) => ({ ...s, why: why.trim() || s.why })), refused: [] };
  }
  const reason = known.refused[0]?.reason ?? plain;
  if (reason) return { steps: [], refused: [{ command: trimmed, reason }] };
  return { steps: [{ command: trimmed, kind: 'other', phase: 'start', why: why.trim() || DEFAULT_WHY.other }], refused: [] };
}

/**
 * What makes two steps the same step, for the dedupe key. The command itself,
 * except a cargo install, whose `crate@v` and `crate --version v` forms, and
 * `-y` and `--no-confirm`, are one step. For every other command the identity
 * is the command, so the stored keys of those steps do not change.
 */
export function setupStepIdentity(kind: SetupStepKind, command: string): string {
  if (kind !== 'cargo') return command;
  const m = /^(command -v [\w.+-]+ >\/dev\/null 2>&1 \|\| )?(.*)$/s.exec(command)!;
  const w = shellWords(m[2]);
  if (!w) return command;
  const at = w.indexOf('cargo');
  if (at < 0 || !['install', 'binstall'].includes(w[at + 1] ?? '')) return command;
  return `${m[1] ?? ''}${quoteAll([...w.slice(0, at), ...canonicalCargoWords(w.slice(at))])}`;
}

// ============================================================================
// Applying
// ============================================================================

export interface AppliedSetupStep {
  id: string;
  command: string;
  kind: SetupStepKind;
  phase: SetupStepPhase;
  sourceWorkbenchId?: string | null;
}

/** The line the box setup prints for each learned step, after all of them ran. */
export const LEARNED_STEP_RESULT_PREFIX = '[talyn] learned step result ';

export interface LearnedStepResult {
  id: string;
  exitCode: number;
  /** The step ran into its time limit. */
  timedOut: boolean;
  /** The last line the step printed, at most 300 characters. */
  lastLine: string;
  /** How long the step ran. Absent in the output of a script from before the step was timed. */
  durationMs?: number;
}

/** The line the box setup prints last, with the times of the whole setup. */
export const SETUP_TIMING_PREFIX = '[talyn] setup timing ';

/** Installs first, then services, then what needs the services. */
const KIND_ORDER: SetupStepKind[] = [
  'installer', 'rustup', 'apt', 'brew', 'cargo', 'go', 'gem', 'pip', 'uv', 'node', 'download',
  'env', 'docker', 'service', 'compose', 'database', 'other',
];

/** Stable: steps of one kind keep the order they were learned in. */
export function orderSetupSteps<T extends Pick<AppliedSetupStep, 'kind'>>(steps: T[]): T[] {
  return steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => KIND_ORDER.indexOf(a.step.kind) - KIND_ORDER.indexOf(b.step.kind) || a.index - b.index)
    .map(({ step }) => step);
}

/** Where learned installs put their commands. */
export const LEARNED_PATH_LINE =
  'export PATH="$HOME/.cargo/bin:$HOME/go/bin:$HOME/.local/bin:$HOME/.local/share/pnpm:$PATH"';

/**
 * The box-setup script for the learned steps, or null when there are none.
 *
 * Each step runs on its own, with no stdin and with a time limit
 * ({@link SETUP_STEP_TIMEOUT_SEC}): one hung step must not hold the setup. A
 * failed step does not stop the others. Its output goes to the setup output
 * and to a file, for its last line. After all steps, one result line per step
 * ({@link LEARNED_STEP_RESULT_PREFIX}) says how it ended. The lines come last
 * because the backend keeps only the end of a script's output, and a long
 * install must not push out the result of an earlier step.
 */
/**
 * Milliseconds since the epoch, in bash. `EPOCHREALTIME` (bash 5) has
 * microseconds; its decimal mark depends on the locale. Then GNU `date`
 * (`%3N`). Last, whole seconds, which still time a slow step.
 */
const NOW_MS_FUNCTION = [
  'talyn_now_ms() {',
  '  local t="${EPOCHREALTIME:-}"',
  '  if [ -n "$t" ]; then t="${t/[.,]/}"; echo "${t%???}"; return; fi',
  '  t="$(date +%s%3N 2>/dev/null)"',
  '  case "$t" in \'\'|*[!0-9]*) echo "$(( $(date +%s) * 1000 ))" ;; *) echo "$t" ;; esac',
  '}',
];

export function learnedSetupScript(steps: AppliedSetupStep[]): string | null {
  if (steps.length === 0) return null;
  const lines = [
    '# Setup that Talyn learned from earlier sessions on this repository.',
    '# Each step runs on its own. A failed step does not stop the others.',
    LEARNED_PATH_LINE,
    ...NOW_MS_FUNCTION,
    'talyn_learned_start="$(talyn_now_ms)"',
    'talyn_learned_run() {',
    '  bash -c "$1" </dev/null 2>&1 | tee "$2"',
    '  return "${PIPESTATUS[0]}"',
    '}',
    'export -f talyn_learned_run',
    "talyn_learned_results=''",
    'talyn_learned_step() {',
    '  local log code last start ms',
    '  echo "[talyn] learned step $1 (from session $2): $4"',
    '  log="$(mktemp)"',
    '  start="$(talyn_now_ms)"',
    `  timeout -k ${SETUP_STEP_KILL_AFTER_SEC} "$3" bash -c 'talyn_learned_run "$1" "$2"' talyn-learned-step "$4" "$log"`,
    '  code=$?',
    '  ms="$(( $(talyn_now_ms) - start ))"',
    "  last=\"$(grep -v '^[[:space:]]*$' \"$log\" | tail -n 1 | tr -d '\\r' | cut -c1-300)\"",
    '  rm -f "$log"',
    '  if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then',
    '    echo "[talyn] learned step $1 timed out after $3 seconds. A person can revert it in the repository settings." >&2',
    '  elif [ "$code" -ne 0 ]; then',
    '    echo "[talyn] learned step $1 failed with exit $code. A person can revert it in the repository settings." >&2',
    '  fi',
    `  talyn_learned_results="$talyn_learned_results${LEARNED_STEP_RESULT_PREFIX}$1 exit $code ms $ms: $last"$'\\n'`,
    '}',
  ];
  for (const step of orderSetupSteps(steps)) {
    lines.push(`talyn_learned_step ${shellQuote(step.id)} ${shellQuote(step.sourceWorkbenchId ?? 'unknown')} ${SETUP_STEP_TIMEOUT_SEC[step.kind] ?? SETUP_STEP_TIMEOUT_SEC.other} ${shellQuote(step.command)}`);
  }
  lines.push(`printf '%s' "$talyn_learned_results"`);
  lines.push('talyn_learned_ms="$(( $(talyn_now_ms) - talyn_learned_start ))"');
  return lines.join('\n');
}

/** The timing line, after the learned steps. `talyn_setup_start` and `talyn_own_ms` are set when the repository has its own setup. */
const TIMING_LINE = [
  'if [ -n "${talyn_setup_start:-}" ]; then',
  `  echo "${SETUP_TIMING_PREFIX}total $(( $(talyn_now_ms) - talyn_setup_start )) repository $talyn_own_ms learned $talyn_learned_ms"`,
  'else',
  `  echo "${SETUP_TIMING_PREFIX}total $talyn_learned_ms learned $talyn_learned_ms"`,
  'fi',
].join('\n');

const RESULT_LINE = /^\[talyn\] learned step result (\S+) exit (\d+)(?: ms (\d+))?: ?(.*)$/;

/**
 * The learned-step results in a box setup's output. The last line for a step
 * wins. Output that has no result line (a setup that was stopped) gives none.
 */
export function parseLearnedStepResults(output: string): LearnedStepResult[] {
  const found = new Map<string, LearnedStepResult>();
  for (const line of output.split(/\r?\n/)) {
    const m = RESULT_LINE.exec(line);
    if (!m) continue;
    const exitCode = Number(m[2]);
    found.delete(m[1]);
    found.set(m[1], {
      id: m[1],
      exitCode,
      timedOut: exitCode === 124 || exitCode === 137,
      lastLine: m[4].trim(),
      ...(m[3] !== undefined ? { durationMs: Number(m[3]) } : {}),
    });
  }
  return [...found.values()];
}

const TIMING = /^\[talyn\] setup timing total (\d+)(?: repository (\d+))? learned (\d+)\s*$/;

/** The times of a box setup, from its last timing line. Null: the output has none. */
export function parseSetupTiming(output: string): Pick<SetupTiming, 'totalMs' | 'repositoryMs' | 'learnedMs'> | null {
  let found: Pick<SetupTiming, 'totalMs' | 'repositoryMs' | 'learnedMs'> | null = null;
  for (const line of output.split(/\r?\n/)) {
    const m = TIMING.exec(line);
    if (m) found = { totalMs: Number(m[1]), repositoryMs: m[2] !== undefined ? Number(m[2]) : null, learnedMs: Number(m[3]) };
  }
  return found;
}

/**
 * The repository's setup, then the learned steps. The repository's own setup
 * runs first and in a subshell, so an `exit` in it cannot skip the learned
 * steps, and the setup still ends with its exit code.
 */
export function mergeLearnedSetup(config: WorkbenchConfig, steps: AppliedSetupStep[]): WorkbenchConfig {
  const learned = learnedSetupScript(steps);
  if (!learned) return config;
  const own = config.setup?.command?.trim();
  const command = own
    ? [
        ...NOW_MS_FUNCTION,
        'talyn_setup_start="$(talyn_now_ms)"',
        `(\n${own}\n)`,
        'talyn_setup_status=$?',
        'talyn_own_ms="$(( $(talyn_now_ms) - talyn_setup_start ))"',
        learned,
        TIMING_LINE,
        'exit $talyn_setup_status',
      ].join('\n')
    : `${learned}\n${TIMING_LINE}`;
  return { ...config, setup: { command } };
}

/**
 * The hosts the fleet lets every bake reach (`proxy.BakeConnectHosts` in the
 * fleet, plus the read-only Debian route). A learned step needs a host added
 * only when it is not one of these.
 */
const FLEET_BAKE_HOSTS = new Set([
  'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'raw.githubusercontent.com',
  'nodejs.org', 'go.dev', 'dl.google.com', 'static.rust-lang.org', 'www.python.org', 'astral.sh', 'mise-versions.jdx.dev',
  'registry.npmjs.org', 'registry.yarnpkg.com', 'npm.jsr.io', 'jsr.io', 'codeload.github.com', 'pypi.org',
  'files.pythonhosted.org', 'proxy.golang.org', 'sum.golang.org', 'auth.docker.io', 'registry-1.docker.io',
  'production.cloudflare.docker.com', 'production.cloudfront.docker.com', 'ghcr.io', 'quay.io',
  'pkg-containers.githubusercontent.com', 'cdn.quay.io', 'cdn01.quay.io', 'cdn02.quay.io', 'cdn03.quay.io',
  'deb.debian.org',
]);

const KIND_HOSTS: Partial<Record<SetupStepKind, string[]>> = {
  cargo: ['crates.io', 'index.crates.io', 'static.crates.io'],
  rustup: ['sh.rustup.rs'],
  gem: ['rubygems.org', 'index.rubygems.org'],
  brew: ['formulae.brew.sh'],
};

/** The hosts a step needs in a bake, beyond what every bake can reach. */
export function bakeHostsFor(step: Pick<AppliedSetupStep, 'kind' | 'command'>): string[] {
  const hosts = new Set(KIND_HOSTS[step.kind] ?? []);
  for (const m of step.command.matchAll(/https:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1].toLowerCase());
  return [...hosts].filter((h) => !FLEET_BAKE_HOSTS.has(h)).sort();
}

const BAKE_MAX_STEPS = 10;
const BAKE_MAX_HOSTS = 10;
const BAKE_TOTAL_SEC = 1800;
const BAKE_DEFAULT_STEP_SEC = 300;
/** One learned install. A cargo install that compiles from source takes about ten minutes. */
const LEARNED_STEP_MAX_SEC = 900;
/** Less than this is not enough time for a step to finish, so the step stays out of the bake. */
const LEARNED_STEP_MIN_SEC = 120;

/**
 * The repository's own bake with the learned install steps after it, inside the
 * fleet's limits (10 steps, 10 hosts, 1800 s in all). Steps that do not fit
 * stay box-setup only. With no learned step, the repository's own bake as it
 * is: an explicit `{ steps: [] }` clears the fleet's stored bake, so it must
 * reach the fleet unchanged.
 */
export function bakeWithLearnedSteps(
  own: RepositoryBake | null | undefined,
  steps: AppliedSetupStep[],
): RepositoryBake | null {
  const base: RepositoryBake = own ? { steps: [...own.steps], ...(own.hosts ? { hosts: [...own.hosts] } : {}) } : { steps: [] };
  const installs = orderSetupSteps(steps.filter((s) => s.phase === 'install'));
  if (installs.length === 0) return own ?? null;
  const used = base.steps.reduce((sum, s) => sum + (s.timeoutSec ?? BAKE_DEFAULT_STEP_SEC), 0);
  const hosts = new Set(base.hosts ?? []);
  const chosen: AppliedSetupStep[] = [];
  for (const step of installs) {
    if (base.steps.length + chosen.length >= BAKE_MAX_STEPS) break;
    const needed = bakeHostsFor(step).filter((h) => !hosts.has(h));
    if (hosts.size + needed.length > BAKE_MAX_HOSTS) continue;
    needed.forEach((h) => hosts.add(h));
    chosen.push(step);
  }
  while (chosen.length > 0 && Math.floor((BAKE_TOTAL_SEC - used) / chosen.length) < LEARNED_STEP_MIN_SEC) chosen.pop();
  if (chosen.length === 0) return own ?? null;
  const timeoutSec = Math.min(LEARNED_STEP_MAX_SEC, Math.floor((BAKE_TOTAL_SEC - used) / chosen.length));
  const learned: BakeStep[] = chosen.map((step) => ({
    name: `${LEARNED_BAKE_STEP_PREFIX}${step.id}`,
    run: `${LEARNED_PATH_LINE}\n${step.command}`,
    timeoutSec,
  }));
  const bake: RepositoryBake = { steps: [...base.steps, ...learned], ...(hosts.size ? { hosts: [...hosts].sort() } : {}) };
  try {
    return validateRepositoryBake(bake);
  } catch {
    return own ?? null;
  }
}

/** The step id in a learned bake step's name, or null for a step the repository wrote. */
export function learnedBakeStepId(name: string): string | null {
  return name.startsWith(LEARNED_BAKE_STEP_PREFIX) ? name.slice(LEARNED_BAKE_STEP_PREFIX.length) : null;
}

// ============================================================================
// Frequency: does every session need the step?
// ============================================================================

/** Browsers. Each is hundreds of megabytes, often with dozens of system packages. */
const HEAVY_INSTALL = /\bplaywright\b[^|;&]*\binstall\b|(?:@puppeteer\/browsers|\bpuppeteer\b)[^|;&]*\b(?:install|browsers)\b/;
/** The same, and TeX, as apt packages. `texlive-full` alone is gigabytes. */
const HEAVY_APT_PACKAGE = /^(?:chromium(?:-[\w.-]+)?|google-chrome[\w.-]*|firefox(?:-esr)?|texlive(?:-[\w.-]+)?)$/;

/**
 * A step that installs a browser (playwright, puppeteer, chrome, chromium,
 * firefox) or TeX. It costs every box minutes and gigabytes, so it needs
 * {@link SETUP_STEP_HEAVY_LIVE_SHARE}, not {@link SETUP_STEP_LIVE_SHARE}.
 */
export function isHeavySetupStep(command: string): boolean {
  if (HEAVY_INSTALL.test(command)) return true;
  for (const segment of commandSegments(command)) {
    const w = shellWords(unwrapCommand(segment).command);
    if (!w || !['apt', 'apt-get'].includes(w[0]) || !w.includes('install')) continue;
    if (names(w.slice(w.indexOf('install') + 1)).some((p) => HEAVY_APT_PACKAGE.test(packageName(p)))) return true;
  }
  return false;
}

/** The commands of a language's tools. A dependency install in the checkout is used by any of them. */
const ECOSYSTEM_COMMANDS: Partial<Record<SetupStepKind, string[]>> = {
  uv: ['uv', 'uvx', 'python', 'python3', 'pytest'],
  pip: ['python', 'python3', 'pytest', 'pip', 'pip3'],
  node: ['node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx'],
  go: ['go'],
  gem: ['ruby', 'bundle', 'rake', 'rails'],
};
/** System libraries for a build. No command names them: the dependency install and the compilers use them. */
const BUILD_LIBRARY = /^(?:lib[\w.+-]*-dev|build-essential|pkg-config|[\w.+-]+-dev)$/;
const BUILD_COMMANDS = [...new Set([...Object.values(ECOSYSTEM_COMMANDS).flat(), 'cargo', 'rustc', 'make', 'cmake', 'cc', 'gcc'])];

/**
 * The commands that show that a session used a live step. A box that ran the
 * step already has what it installs, so the agent does not install it again.
 * Without this, a step that every session needs looks unneeded once it runs.
 *
 * - The command a step guards: `command -v uv || ...` gives `uv`.
 * - The tools it installs: `cargo install sqlx-cli` gives `sqlx-cli`, which
 *   `sqlx` matches ({@link setupStepUsed}).
 * - For a dependency install in the checkout (`uv sync`, `pnpm install`), the
 *   language's own commands.
 * - For build libraries (`libpq-dev`), every build command.
 *
 * A start step has none: it is a one-off by nature, and a session that needs
 * it every time records it again.
 */
export function setupStepUses(step: Pick<AppliedSetupStep, 'kind' | 'command' | 'phase'>): string[] {
  if (step.phase !== 'install') return [];
  const out = new Set<string>();
  for (const m of step.command.matchAll(/command -v ([\w.+-]+)/g)) out.add(m[1]);
  for (const parsed of stepsFromCommand(step.command).steps) {
    const provided = (parsed.provides ?? []).map((p) => p.split('/').pop() ?? p);
    if (parsed.kind === 'apt' && provided.length > 0 && provided.every((p) => BUILD_LIBRARY.test(p))) {
      BUILD_COMMANDS.forEach((c) => out.add(c));
    } else if (provided.length > 0) {
      provided.forEach((p) => out.add(p));
    } else {
      (ECOSYSTEM_COMMANDS[parsed.kind] ?? []).forEach((c) => out.add(c));
    }
  }
  return [...out];
}

/**
 * The commands that a turn's shell calls ran: the tool of each part, its
 * runner (`uv` of `uv run pytest`), `tool-sub` for a subcommand
 * (`cargo-nextest` of `cargo nextest run`), and the module of `python -m`.
 */
export function turnCommandWords(calls: TurnToolCall[]): Set<string> {
  const out = new Set<string>();
  for (const call of calls) {
    if (!SHELL_TOOLS.has(call.name) || !call.command) continue;
    for (const segment of commandSegments(call.command).flatMap(pipeParts)) {
      const u = unwrapCommand(segment);
      if (u.runner) out.add(u.runner.split(' ')[0]);
      const w = u.command.split(/\s+/).map((x) => x.replace(/^['"]|['"]$/g, ''));
      const tool = w[0]?.split('/').pop();
      if (!tool || !/^[\w.+-]+$/.test(tool)) continue;
      out.add(tool);
      if (w[1] && /^[a-z][\w-]*$/.test(w[1])) out.add(`${tool}-${w[1]}`);
      if (/^python3?(?:\.\d+)?$/.test(tool) && w[1] === '-m' && w[2]) out.add(w[2]);
    }
  }
  return out;
}

/** The commands of a pipeline: `cat x | jq .` is `cat x` and `jq .`. Quotes keep their `|`. */
function pipeParts(segment: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const c of segment) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '|') {
      out.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  out.push(current);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** Whether a session that ran {@link turnCommandWords} used the step. `sqlx` uses `sqlx-cli`. */
export function setupStepUsed(step: Pick<AppliedSetupStep, 'kind' | 'command' | 'phase'>, words: Set<string>): boolean {
  return setupStepUses(step).some((use) => words.has(use) || (use.endsWith('-cli') && words.has(use.slice(0, -4))));
}

export interface SetupStepVerdictInput {
  /** The step runs on new boxes now. */
  live: boolean;
  heavy: boolean;
  /** Recent sessions that needed the step. */
  neededBy: number;
  /** All recent sandbox sessions on the repository. */
  sessions: number;
  /** The step's typical time in the box setup. At {@link SETUP_STEP_SLOW_MS} or more, the heavy bars apply. */
  typicalDurationMs?: number | null;
  /**
   * The window has the full {@link SETUP_STEP_WINDOW_DAYS} days of data. Until
   * then a live step stays live: its sessions before Talyn counted uses look
   * like sessions that did not need it.
   */
  canDrop: boolean;
}

const pct = (share: number) => `${Math.round(share * 100)}%`;

/**
 * Whether a step runs on new boxes, and why, from its share of the
 * repository's recent sessions. A waiting step goes live at
 * {@link SETUP_STEP_MIN_SESSIONS} sessions and {@link SETUP_STEP_LIVE_SHARE}.
 * A live step goes back to waiting below {@link SETUP_STEP_DROP_SHARE}, but only
 * with full data and at least {@link SETUP_STEP_MIN_SESSIONS_TO_DROP} sessions.
 * Heavy and slow steps use the heavy bars.
 */
export function setupStepVerdict(input: SetupStepVerdictInput): { live: boolean; reason: string } {
  const { neededBy, sessions } = input;
  const share = sessions > 0 ? neededBy / sessions : 0;
  const slow = (input.typicalDurationMs ?? 0) >= SETUP_STEP_SLOW_MS;
  const strict = input.heavy || slow;
  const liveBar = strict ? SETUP_STEP_HEAVY_LIVE_SHARE : SETUP_STEP_LIVE_SHARE;
  const dropBar = strict ? SETUP_STEP_HEAVY_DROP_SHARE : SETUP_STEP_DROP_SHARE;
  const counted = `needed by ${neededBy} of ${sessions} sessions in the last ${SETUP_STEP_WINDOW_DAYS} days`;
  const heavy = input.heavy
    ? ', because it installs a browser or a large package set'
    : slow ? `, because it takes about ${formatDurationMs(input.typicalDurationMs!)} on each box` : '';
  if (!input.live) {
    if (neededBy >= SETUP_STEP_MIN_SESSIONS && share >= liveBar) return { live: true, reason: `Live: ${counted} (${pct(share)}).` };
    return {
      live: false,
      reason: `Waiting: ${counted}. It runs on new boxes when at least ${SETUP_STEP_MIN_SESSIONS} sessions and ${pct(liveBar)} need it${heavy}.`,
    };
  }
  if (sessions === 0 || share >= dropBar) return { live: true, reason: `Live: ${counted}${sessions ? ` (${pct(share)})` : ''}.` };
  if (!input.canDrop) {
    return { live: true, reason: `Live: ${counted} (${pct(share)}). It stays until Talyn has ${SETUP_STEP_WINDOW_DAYS} days of data.` };
  }
  if (sessions < SETUP_STEP_MIN_SESSIONS_TO_DROP) {
    return { live: true, reason: `Live: ${counted} (${pct(share)}). Talyn needs ${SETUP_STEP_MIN_SESSIONS_TO_DROP} recent sessions to take a step out.` };
  }
  return { live: false, reason: `Waiting: ${counted} (${pct(share)}), under ${pct(dropBar)}. It no longer runs on new boxes.` };
}
