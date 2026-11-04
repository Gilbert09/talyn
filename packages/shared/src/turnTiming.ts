/**
 * Where a session turn spent its time.
 *
 * A turn is the wall time from its first stored event to its last. Each tool
 * call runs from its `tool_use` event to the `tool_result` event with the same
 * id. Model time is the wall time that no tool call covers, so parallel tool
 * calls are not counted twice there. The category totals are plain sums, so two
 * parallel calls can make a category larger than the wall time.
 *
 * Event times are the times the backend stored the events. They are batched
 * about every 250 ms, so a very short call can read as 0 ms.
 */

export const TURN_TIME_CATEGORIES = [
  'model',
  'tests',
  'installs',
  'builds',
  'services',
  'waiting',
  'git',
  'reading',
  'other',
] as const;

export type TurnTimeCategory = (typeof TURN_TIME_CATEGORIES)[number];

export const TURN_TIME_CATEGORY_LABELS: Record<TurnTimeCategory, string> = {
  model: 'Model',
  tests: 'Tests',
  installs: 'Installs',
  builds: 'Builds',
  services: 'Docker and services',
  waiting: 'Waiting (sleep and polling)',
  git: 'Git',
  reading: 'Reading files',
  other: 'Other tool calls',
};

/** One tool call of a turn, as the backend reads it from the transcript. */
export interface TurnToolCall {
  id: string;
  name: string;
  /** The shell command, for a Bash call. */
  command?: string;
  /** Epoch milliseconds. */
  startedAt: number;
  /** Null when the turn ended before the result arrived. */
  endedAt: number | null;
  isError?: boolean;
  /** Part of the result text. The backend reads it only for failed calls. */
  output?: string;
}

export interface TurnTimeBucket {
  ms: number;
  count: number;
}

export interface TurnSlowCall {
  category: TurnTimeCategory;
  name: string;
  /** Shortened, with secrets replaced by `***`. */
  command?: string;
  ms: number;
  isError?: boolean;
}

export interface TurnTimeReport {
  wallMs: number;
  /** Wall time covered by at least one tool call. */
  toolMs: number;
  /** Wall time minus tool time, never below 0. */
  modelMs: number;
  calls: number;
  categories: Partial<Record<TurnTimeCategory, TurnTimeBucket>>;
  slowest: TurnSlowCall[];
}

export interface TurnTimeSummary {
  chatId: string;
  turn: number;
  wallMs: number;
  toolMs: number;
  modelMs: number;
  calls: number;
  /** When the report was stored (ISO). */
  at: string;
}

/** `GET /workbenches/:id/timing`. */
export interface WorkbenchTiming {
  workbenchId: string;
  turns: number;
  wallMs: number;
  toolMs: number;
  modelMs: number;
  calls: number;
  categories: Partial<Record<TurnTimeCategory, TurnTimeBucket>>;
  slowest: TurnSlowCall[];
  /** Newest first. */
  recentTurns: TurnTimeSummary[];
}

/** Calls kept per turn, and per session in the totals. */
export const TURN_SLOWEST_LIMIT = 5;
export const SESSION_SLOWEST_LIMIT = 10;
const COMMAND_PREVIEW_CHARS = 160;

// ============================================================================
// Secrets
// ============================================================================

const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH|COOKIE|SESSION_?KEY|SIGNING_?KEY|DSN)/i;

const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:[^\s@'"]+@/i,
  /\bauthorization:\s*\S+/i,
  /(?:^|\s)--?(?:password|passwd|token|api-key|secret)(?:[=\s]+)\S+/i,
];

/** A long run of letters and digits with both cases and a digit: a key, not a word or a hex hash. */
function looksRandom(token: string): boolean {
  return token.length >= 32 && /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token);
}

/**
 * Whether text holds something that looks like a credential: a known token
 * shape, a `NAME=value` whose name says secret, a URL with a password, an auth
 * header or flag, or a long random string.
 */
export function containsSecret(text: string): boolean {
  if (TOKEN_PATTERNS.some((p) => p.test(text))) return true;
  for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)=(\S+)/g)) {
    if (SECRET_NAME.test(m[1]) && m[2].replace(/^['"]|['"]$/g, '') !== '') return true;
  }
  return text.split(/[^A-Za-z0-9+/_=-]+/).some(looksRandom);
}

/** Replace anything {@link containsSecret} would find with `***`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const p of TOKEN_PATTERNS) {
    out = out.replace(new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`), (match) => {
      const url = /^([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:)[^\s@'"]+@$/i.exec(match);
      if (url) return `${url[1]}***@`;
      const flag = /^(\s*--?[\w-]+)[=\s]/.exec(match);
      return flag ? `${flag[1]} ***` : '***';
    });
  }
  out = out.replace(/\b([A-Za-z_][A-Za-z0-9_]*)=(\S+)/g, (whole, name: string) => (SECRET_NAME.test(name) ? `${name}=***` : whole));
  return out.replace(/[A-Za-z0-9+/_=-]{32,}/g, (token) => (looksRandom(token) ? '***' : token));
}

// ============================================================================
// Classifier
// ============================================================================

type CommandCategory = Exclude<TurnTimeCategory, 'model'>;

/**
 * The rules, tried in order on one simple command (see {@link commandSegments}).
 * The first match names the segment's category.
 */
export const COMMAND_RULES: ReadonlyArray<{ category: CommandCategory; test: RegExp }> = [
  // Tests
  { category: 'tests', test: /^(?:python3?\s+-m\s+)?(?:pytest|py\.test|unittest)\b/ },
  { category: 'tests', test: /^(?:jest|vitest|mocha|ava|tap|karma|cypress\s+run|playwright\s+test|rspec|phpunit|tox|nox|ctest)\b/ },
  { category: 'tests', test: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w:-]+)?(?:\s|$)/ },
  { category: 'tests', test: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w-]*:?test[\w:-]*(?:\s|$)/ },
  { category: 'tests', test: /^(?:go|cargo|dotnet|mvn|gradlew?|\.\/gradlew|swift|deno|bun)\s+test\b/ },
  { category: 'tests', test: /^(?:python3?\s+)?(?:\.\/)?manage\.py\s+test\b/ },
  { category: 'tests', test: /^(?:rake|make)\s+(?:test|check)\b/ },
  { category: 'tests', test: /^(?:\.\/)?bin\/tests?\b/ },
  // Installs
  { category: 'installs', test: /^apt(?:-get)?\b.*\b(?:install|update|upgrade)\b/ },
  { category: 'installs', test: /^(?:apk\s+add|dnf\s+install|yum\s+install|brew\s+(?:install|upgrade))\b/ },
  { category: 'installs', test: /^(?:pip3?|python3?\s+-m\s+pip)\s+install\b/ },
  { category: 'installs', test: /^uv\s+(?:sync|add|venv|pip\s+(?:install|sync)|tool\s+install|python\s+install)\b/ },
  { category: 'installs', test: /^(?:poetry|pipenv)\s+(?:install|add|sync)\b/ },
  { category: 'installs', test: /^npm\s+(?:install|i|ci|add)(?:\s|$)/ },
  { category: 'installs', test: /^(?:pnpm|bun)\s+(?:install|i|add)(?:\s|$)/ },
  { category: 'installs', test: /^yarn(?:\s+(?:install|add))?(?:\s+-|$)/ },
  { category: 'installs', test: /^yarn\s+(?:install|add)\b/ },
  { category: 'installs', test: /^cargo\s+(?:install|binstall|fetch)\b/ },
  { category: 'installs', test: /^(?:rustup|corepack|nvm|mise|asdf|pyenv|sdk)\b/ },
  { category: 'installs', test: /^go\s+(?:install|get|mod\s+download)\b/ },
  { category: 'installs', test: /^(?:gem\s+install|bundle(?:\s+install)?$)/ },
  { category: 'installs', test: /^bundle\s+install\b/ },
  { category: 'installs', test: /^(?:curl|wget)\b.*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/ },
  // Builds
  { category: 'builds', test: /^cargo\s+(?:build|check|clippy|run|b|c)\b/ },
  { category: 'builds', test: /^(?:go\s+build|make|cmake|ninja|gcc|g\+\+|clang|rustc|tsc|webpack|esbuild|rollup|mvn|gradlew?|\.\/gradlew|dotnet\s+build)\b/ },
  { category: 'builds', test: /^(?:vite|next|nuxt|astro|turbo|nx)\s+(?:run\s+)?build\b/ },
  { category: 'builds', test: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|compile|typecheck|tsc)(?::[\w:-]+)?(?:\s|$)/ },
  // Docker and services
  { category: 'services', test: /^(?:docker(?:-compose)?|podman|dockerd|containerd|systemctl|service|supervisorctl|redis-server|pg_ctl|pg_ctlcluster|postgres|mysqld|kubectl|minikube|kind|k3d)\b/ },
  { category: 'services', test: /^\/etc\/init\.d\// },
  // Waiting
  { category: 'waiting', test: /^(?:sleep|wait)\b/ },
  // Git
  { category: 'git', test: /^(?:git|gh)\b/ },
  // Reading
  { category: 'reading', test: /^(?:cat|head|tail|less|more|grep|egrep|fgrep|rg|ag|find|fd|ls|tree|wc|sed\s+-n|awk|jq|yq|file|stat|du|diff|nl|bat)\b/ },
];

/** Higher wins when one command has several segments. */
const PRIORITY: CommandCategory[] = ['tests', 'installs', 'builds', 'services', 'waiting', 'git', 'reading', 'other'];

const TOOL_CATEGORIES: Record<string, CommandCategory> = {
  Read: 'reading',
  Grep: 'reading',
  Glob: 'reading',
  LS: 'reading',
  NotebookRead: 'reading',
  WebFetch: 'reading',
  WebSearch: 'reading',
  BashOutput: 'waiting',
  TaskOutput: 'waiting',
};

const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'exec_command', 'local_shell']);

/**
 * Split a shell command into simple commands at `&&`, `||`, `;`, `&` and
 * newlines, outside quotes. A pipe stays inside its segment, so `curl … | sh`
 * and `pytest … | tail` keep their first word.
 */
export function commandSegments(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < command.length) {
        current += c + command[++i];
        continue;
      }
      if (c === quote) quote = null;
      current += c;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      // A line continuation joins lines; any other escape is kept.
      if (command[i + 1] === '\n') { i++; current += ' '; continue; }
      current += c + command[++i];
      continue;
    }
    if (c === '"' || c === "'") { quote = c; current += c; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { out.push(current); current = ''; i++; continue; }
    if (c === ';' || c === '\n') { out.push(current); current = ''; continue; }
    if (c === '&' && command[i - 1] !== '>' && command[i - 1] !== '<' && command[i + 1] !== '>') {
      out.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

const LEADING_WORDS = /^(?:if|then|else|elif|while|until|do|time|nohup|exec|command|builtin|!|\(|\{)(?:\s+|$)/;
const WRAPPERS = /^((?:uv|poetry|pipenv|hatch|pdm)\s+run|npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+(?:exec|dlx)|bundle\s+exec)\s+(?:--?[\w-]+(?:=\S+)?\s+)*/;

/** sudo and its options. Only the options in the first group take a value. */
const SUDO = /^sudo((?:\s+(?:-[ugCDhprtTU]\s*(?!-)[^\s-]\S*|--(?:user|group|chdir|prompt|role|type|host|other-user|close-from)=\S+|-[A-Za-z]+|--[\w-]+(?:=\S+)?))*)\s+/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*))\s+/;

/** A segment without its wrappers, and what the wrappers said. */
export interface UnwrappedCommand {
  command: string;
  /** The segment ran under sudo. */
  sudo: boolean;
  /** The user of `sudo -u`, or null for root. */
  sudoUser: string | null;
  /** Leading `NAME=value` words, as written. */
  assignments: string[];
  /** A runner such as `uv run` or `npx`, without its options. */
  runner: string | null;
}

/**
 * One segment with what only wraps a command removed: `sudo`, `env`, leading
 * variable assignments, `timeout`, loop and `if` keywords, and runners such as
 * `uv run` or `npx`. The result also says which wrappers were there, because
 * a setup step must run as the same user as the command it came from.
 */
export function unwrapCommand(segment: string): UnwrappedCommand {
  let s = segment.trim();
  const out: UnwrappedCommand = { command: '', sudo: false, sudoUser: null, assignments: [], runner: null };
  for (let guard = 0; guard < 12; guard++) {
    const before = s;
    s = s.replace(/^[({]\s*/, '').replace(/\s*[)}]\s*$/, '');
    s = s.replace(LEADING_WORDS, '');
    const sudo = SUDO.exec(s);
    if (sudo) {
      out.sudo = true;
      const user = /(?:^|\s)(?:-u\s*|--user=)(\S+)/.exec(sudo[1])?.[1] ?? null;
      out.sudoUser = user === 'root' || user === '0' || user === '#0' ? null : user;
      s = s.slice(sudo[0].length);
    }
    s = s.replace(/^env(?:\s+-\S+)*\s+/, '');
    const assignment = ASSIGNMENT.exec(s);
    if (assignment) {
      out.assignments.push(assignment[1]);
      s = s.slice(assignment[0].length);
    }
    s = s.replace(/^timeout(?:\s+-\S+)*\s+\d+[smhd]?\s+/, '');
    const runner = WRAPPERS.exec(s);
    if (runner) {
      out.runner = runner[1].replace(/\s+/g, ' ');
      s = s.slice(runner[0].length);
    }
    if (s === before) break;
  }
  out.command = s.trim();
  return out;
}

/** {@link unwrapCommand}, the command only. */
export function stripCommandPrefix(segment: string): string {
  return unwrapCommand(segment).command;
}

function unwrapShell(segment: string): string | null {
  const m = /^(?:ba|z|da)?sh\s+(?:-[a-z]*c[a-z]*|-c)\s+(['"])([\s\S]*)\1$/.exec(segment);
  return m ? m[2] : null;
}

function segmentCategory(segment: string, depth: number): CommandCategory {
  const s = stripCommandPrefix(segment);
  const inner = depth < 2 ? unwrapShell(s) : null;
  if (inner !== null) return classifyCommand(inner, depth + 1);
  for (const rule of COMMAND_RULES) if (rule.test.test(s)) return rule.category;
  return 'other';
}

const POLL_LOOP = /\b(?:while|until|for)\b[\s\S]*\bdo\b[\s\S]*\bsleep\b/;

/** The category of one shell command. */
export function classifyCommand(command: string, depth = 0): CommandCategory {
  const categories = commandSegments(command).map((s) => segmentCategory(s, depth));
  // A loop that sleeps is a poll, whatever it polls. Tests inside it still win.
  if (POLL_LOOP.test(command) && !categories.includes('tests')) return 'waiting';
  // `sleep 300 && tail log` waits first: the sleep is the time.
  if (categories[0] === 'waiting' && !categories.includes('tests') && !categories.includes('installs') && !categories.includes('builds')) {
    return 'waiting';
  }
  let best: CommandCategory = 'other';
  for (const c of categories) if (PRIORITY.indexOf(c) < PRIORITY.indexOf(best)) best = c;
  return best;
}

/** The category of one tool call. */
export function classifyToolCall(name: string, command?: string): CommandCategory {
  if (SHELL_TOOLS.has(name)) return command ? classifyCommand(command) : 'other';
  return TOOL_CATEGORIES[name] ?? 'other';
}

// ============================================================================
// Report
// ============================================================================

function preview(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const flat = redactSecrets(command).replace(/\s+/g, ' ').trim();
  return flat.length > COMMAND_PREVIEW_CHARS ? `${flat.slice(0, COMMAND_PREVIEW_CHARS - 1)}…` : flat;
}

function add(target: Partial<Record<TurnTimeCategory, TurnTimeBucket>>, category: TurnTimeCategory, ms: number, count: number): void {
  const bucket = target[category] ?? { ms: 0, count: 0 };
  bucket.ms += ms;
  bucket.count += count;
  target[category] = bucket;
}

/** The time report of one turn. */
export function computeTurnTiming(input: { startedAt: number; endedAt: number; calls: TurnToolCall[] }): TurnTimeReport {
  const start = input.startedAt;
  const end = Math.max(start, input.endedAt);
  const wallMs = end - start;
  const categories: Partial<Record<TurnTimeCategory, TurnTimeBucket>> = {};
  const intervals: Array<[number, number]> = [];
  const timed: TurnSlowCall[] = [];
  for (const call of input.calls) {
    const from = Math.min(Math.max(call.startedAt, start), end);
    const to = Math.min(Math.max(call.endedAt ?? end, from), end);
    const ms = to - from;
    const category = classifyToolCall(call.name, call.command);
    add(categories, category, ms, 1);
    intervals.push([from, to]);
    timed.push({ category, name: call.name, ms, ...(call.command ? { command: preview(call.command) } : {}), ...(call.isError ? { isError: true } : {}) });
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let toolMs = 0;
  let open: [number, number] | null = null;
  for (const [a, b] of intervals) {
    if (open && a <= open[1]) open[1] = Math.max(open[1], b);
    else {
      if (open) toolMs += open[1] - open[0];
      open = [a, b];
    }
  }
  if (open) toolMs += open[1] - open[0];
  const modelMs = Math.max(0, wallMs - toolMs);
  add(categories, 'model', modelMs, 0);
  return {
    wallMs,
    toolMs,
    modelMs,
    calls: input.calls.length,
    categories,
    slowest: timed.sort((a, b) => b.ms - a.ms).slice(0, TURN_SLOWEST_LIMIT),
  };
}

/** A session's totals from its stored turn reports. */
export function sumTurnTimings(
  workbenchId: string,
  turns: Array<TurnTimeReport & { chatId: string; turn: number; at: string }>,
): WorkbenchTiming {
  const categories: Partial<Record<TurnTimeCategory, TurnTimeBucket>> = {};
  const slowest: TurnSlowCall[] = [];
  let wallMs = 0;
  let toolMs = 0;
  let modelMs = 0;
  let calls = 0;
  for (const t of turns) {
    wallMs += t.wallMs;
    toolMs += t.toolMs;
    modelMs += t.modelMs;
    calls += t.calls;
    for (const c of TURN_TIME_CATEGORIES) {
      const b = t.categories[c];
      if (b) add(categories, c, b.ms, b.count);
    }
    slowest.push(...t.slowest);
  }
  const recentTurns = [...turns]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.turn - a.turn))
    .map(({ chatId, turn, wallMs: w, toolMs: tm, modelMs: m, calls: n, at }) => ({ chatId, turn, wallMs: w, toolMs: tm, modelMs: m, calls: n, at }));
  return {
    workbenchId,
    turns: turns.length,
    wallMs,
    toolMs,
    modelMs,
    calls,
    categories,
    slowest: slowest.sort((a, b) => b.ms - a.ms).slice(0, SESSION_SLOWEST_LIMIT),
    recentTurns,
  };
}

/** `1h 4m`, `3m 20s`, `12s`, `0s`. */
export function formatDurationMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
