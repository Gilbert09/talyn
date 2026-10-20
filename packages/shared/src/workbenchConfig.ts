/**
 * A repository's workbench config: setup / run / archive scripts, run mode and
 * files to copy into a new workbench.
 *
 * Three files are read, first found wins:
 *
 *  1. `.talyn/settings.toml` — Talyn's own.
 *  2. `conductor.json` — Conductor's legacy file.
 *  3. `.conductor/settings.toml` — Conductor's current file.
 *
 * Reading Conductor's files as they stand, and exporting the `CONDUCTOR_*`
 * variables next to ours, is what lets a repository already set up for
 * Conductor work in Talyn with no change. The caller reads the files; nothing
 * here touches a filesystem, so both runtimes resolve config the same way.
 */
import type { WorkbenchNamedRunScript, WorkbenchRunMode, WorkbenchSettings } from './workbench.js';
import type { DetectedWorkbenchScripts } from './workbenchDetect.js';

// ============================================================================
// A TOML subset
// ============================================================================

export class TomlError extends Error {
  constructor(
    message: string,
    readonly line: number
  ) {
    super(`line ${line}: ${message}`);
    this.name = 'TomlError';
  }
}

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

/**
 * Parse the TOML a settings file uses: tables and dotted table headers, dotted
 * and quoted keys, basic / literal / multi-line strings, booleans, integers,
 * floats, arrays (multi-line, trailing comma, comments inside) and inline
 * tables. NOT supported, and refused with an error rather than misread: arrays
 * of tables (`[[x]]`), dates and times.
 *
 * Written here rather than added as a dependency because these files are small
 * and the subset is the whole of what they use; `croner` is this package's only
 * runtime dependency and it earns its place by doing DST.
 */
export function parseToml(source: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  let pos = 0;
  let line = 1;
  /** Tables created by a `[header]`, which may not be opened twice. */
  const explicitTables = new Set<TomlTable>();
  /** Inline tables and values, which may not be extended. */
  const frozen = new Set<TomlTable>();

  const fail = (message: string): never => {
    throw new TomlError(message, line);
  };
  const peek = (offset = 0) => source[pos + offset];
  const startsWith = (s: string) => source.startsWith(s, pos);
  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (source[pos] === '\n') line++;
      pos++;
    }
  };

  const skipInlineSpace = () => {
    while (peek() === ' ' || peek() === '\t') advance();
  };
  const skipComment = () => {
    if (peek() === '#') while (pos < source.length && peek() !== '\n') advance();
  };
  /** Whitespace, newlines and comments — inside arrays. */
  const skipAllSpace = () => {
    for (;;) {
      skipInlineSpace();
      if (peek() === '#') skipComment();
      else if (peek() === '\n' || (peek() === '\r' && peek(1) === '\n')) advance(peek() === '\r' ? 2 : 1);
      else return;
    }
  };
  const expectLineEnd = () => {
    skipInlineSpace();
    skipComment();
    if (peek() === '\r' && peek(1) === '\n') advance(2);
    else if (peek() === '\n') advance();
    else if (pos < source.length) fail(`unexpected "${peek()}" after value`);
  };

  const parseEscape = (): string => {
    const c = peek();
    advance();
    switch (c) {
      case 'b':
        return '\b';
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'f':
        return '\f';
      case 'r':
        return '\r';
      case 'e':
        return '\x1b';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'u':
      case 'U': {
        const len = c === 'u' ? 4 : 8;
        const hex = source.slice(pos, pos + len);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) fail('invalid unicode escape');
        advance(len);
        return String.fromCodePoint(parseInt(hex, 16));
      }
      default:
        return fail(`invalid escape "\\${c ?? ''}"`);
    }
  };

  const parseBasicString = (): string => {
    advance(); // "
    let out = '';
    for (;;) {
      const c = peek();
      if (c === undefined || c === '\n') fail('unterminated string');
      if (c === '"') {
        advance();
        return out;
      }
      if (c === '\\') {
        advance();
        out += parseEscape();
      } else {
        out += c;
        advance();
      }
    }
  };

  const parseLiteralString = (): string => {
    advance(); // '
    const end = source.indexOf("'", pos);
    const nl = source.indexOf('\n', pos);
    if (end === -1 || (nl !== -1 && nl < end)) fail('unterminated literal string');
    const out = source.slice(pos, end);
    advance(end - pos + 1);
    return out;
  };

  const parseMultilineBasic = (): string => {
    advance(3);
    if (peek() === '\n') advance();
    else if (peek() === '\r' && peek(1) === '\n') advance(2);
    let out = '';
    for (;;) {
      if (pos >= source.length) fail('unterminated multi-line string');
      if (startsWith('"""')) {
        // Up to two quotes may sit right before the closing delimiter.
        let extra = 0;
        while (source[pos + 3 + extra] === '"' && extra < 2) extra++;
        out += '"'.repeat(extra);
        advance(3 + extra);
        return out;
      }
      const c = peek();
      if (c === '\\') {
        // A line-ending backslash trims the newline and following whitespace.
        let k = pos + 1;
        while (source[k] === ' ' || source[k] === '\t') k++;
        if (source[k] === '\n' || (source[k] === '\r' && source[k + 1] === '\n')) {
          advance(k - pos);
          while (/[ \t\r\n]/.test(peek() ?? '')) advance();
          continue;
        }
        advance();
        out += parseEscape();
        continue;
      }
      out += c;
      advance();
    }
  };

  const parseMultilineLiteral = (): string => {
    advance(3);
    if (peek() === '\n') advance();
    else if (peek() === '\r' && peek(1) === '\n') advance(2);
    const end = source.indexOf("'''", pos);
    if (end === -1) fail('unterminated multi-line literal string');
    let extra = 0;
    while (source[end + 3 + extra] === "'" && extra < 2) extra++;
    const out = source.slice(pos, end + extra);
    advance(end + extra + 3 - pos);
    return out;
  };

  const parseKeySegment = (): string => {
    skipInlineSpace();
    if (peek() === '"') return parseBasicString();
    if (peek() === "'") return parseLiteralString();
    const start = pos;
    while (/[A-Za-z0-9_-]/.test(peek() ?? '')) advance();
    if (pos === start) fail(`expected a key, found "${peek() ?? 'end of file'}"`);
    return source.slice(start, pos);
  };

  const parseDottedKey = (): string[] => {
    const parts = [parseKeySegment()];
    skipInlineSpace();
    while (peek() === '.') {
      advance();
      parts.push(parseKeySegment());
      skipInlineSpace();
    }
    return parts;
  };

  const isTable = (v: TomlValue | undefined): v is TomlTable =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  /** Walk/create intermediate tables for a dotted key. */
  const descend = (table: TomlTable, parts: string[]): TomlTable => {
    let t = table;
    for (const part of parts) {
      const existing = t[part];
      if (existing === undefined) {
        const next: TomlTable = {};
        t[part] = next;
        t = next;
      } else if (isTable(existing) && !frozen.has(existing)) {
        t = existing;
      } else {
        fail(`key "${part}" is already defined as a value`);
      }
    }
    return t;
  };

  const assign = (table: TomlTable, key: string[], value: TomlValue) => {
    const parent = descend(table, key.slice(0, -1));
    const leaf = key[key.length - 1];
    if (Object.prototype.hasOwnProperty.call(parent, leaf)) fail(`duplicate key "${key.join('.')}"`);
    parent[leaf] = value;
  };

  const parseNumberOrBool = (): TomlValue => {
    const start = pos;
    while (pos < source.length && /[A-Za-z0-9_+\-.]/.test(peek())) advance();
    const raw = source.slice(start, pos);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?(0|[1-9](_?\d)*)$/.test(raw)) return Number(raw.replace(/_/g, ''));
    if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(raw)) return Number(raw.replace(/_/g, ''));
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return fail('dates and times are not supported');
    return fail(raw ? `invalid value "${raw}"` : `expected a value, found "${peek() ?? 'end of file'}"`);
  };

  const parseArray = (): TomlValue[] => {
    advance(); // [
    const out: TomlValue[] = [];
    for (;;) {
      skipAllSpace();
      if (peek() === ']') {
        advance();
        return out;
      }
      out.push(parseValue());
      skipAllSpace();
      if (peek() === ',') {
        advance();
        continue;
      }
      if (peek() === ']') {
        advance();
        return out;
      }
      fail('expected "," or "]" in array');
    }
  };

  const parseInlineTable = (): TomlTable => {
    advance(); // {
    const table: TomlTable = {};
    skipInlineSpace();
    if (peek() === '}') {
      advance();
      frozen.add(table);
      return table;
    }
    for (;;) {
      const key = parseDottedKey();
      skipInlineSpace();
      if (peek() !== '=') fail('expected "=" in inline table');
      advance();
      skipInlineSpace();
      assign(table, key, parseValue());
      skipInlineSpace();
      if (peek() === ',') {
        advance();
        skipInlineSpace();
        continue;
      }
      if (peek() === '}') {
        advance();
        frozen.add(table);
        return table;
      }
      fail('expected "," or "}" in inline table');
    }
  };

  function parseValue(): TomlValue {
    if (startsWith('"""')) return parseMultilineBasic();
    if (startsWith("'''")) return parseMultilineLiteral();
    const c = peek();
    if (c === '"') return parseBasicString();
    if (c === "'") return parseLiteralString();
    if (c === '[') return parseArray();
    if (c === '{') return parseInlineTable();
    return parseNumberOrBool();
  }

  while (pos < source.length) {
    skipInlineSpace();
    const c = peek();
    if (c === undefined) break;
    if (c === '#') {
      skipComment();
      continue;
    }
    if (c === '\n' || (c === '\r' && peek(1) === '\n')) {
      advance(c === '\r' ? 2 : 1);
      continue;
    }
    if (c === '[') {
      if (peek(1) === '[') fail('arrays of tables ([[...]]) are not supported');
      advance();
      const key = parseDottedKey();
      skipInlineSpace();
      if (peek() !== ']') fail('expected "]" to close table header');
      advance();
      const table = descend(root, key);
      if (explicitTables.has(table)) fail(`table [${key.join('.')}] is defined twice`);
      explicitTables.add(table);
      current = table;
      expectLineEnd();
      continue;
    }
    const key = parseDottedKey();
    skipInlineSpace();
    if (peek() !== '=') fail(`expected "=" after key "${key.join('.')}"`);
    advance();
    skipInlineSpace();
    const value = parseValue();
    assign(current, key, value);
    expectLineEnd();
  }
  return root;
}

// ============================================================================
// Config
// ============================================================================

export interface WorkbenchScript {
  command: string;
}

export type WorkbenchConfigSource = 'talyn' | 'conductor-json' | 'conductor-toml' | 'none';

export interface WorkbenchConfig {
  detected?: DetectedWorkbenchScripts;
  setup?: WorkbenchScript;
  /** Named run scripts; exactly one has `default: true` when the list is non-empty. */
  run: WorkbenchNamedRunScript[];
  archive?: WorkbenchScript;
  /** `nonconcurrent`: starting a run script stops the others first. */
  runMode: WorkbenchRunMode;
  /** Gitignored files to copy from the main checkout into a new workbench (`.env`, …). */
  filesToCopy: string[];
  source: WorkbenchConfigSource;
  /** Parse problems, including those of a file that was skipped because it was broken. */
  errors: string[];
}

export interface WorkbenchConfigFiles {
  /** `.talyn/settings.toml` */
  talynToml?: string | null;
  /** `conductor.json` */
  conductorJson?: string | null;
  /** `.conductor/settings.toml` */
  conductorToml?: string | null;
}

type Shape = Omit<WorkbenchConfig, 'source' | 'errors'>;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** A script given as a string or as `{ command = "…" }`. Blank means absent. */
function scriptOf(v: unknown): WorkbenchScript | undefined {
  if (typeof v === 'string') return v.trim() ? { command: v } : undefined;
  const rec = asRecord(v);
  if (rec && typeof rec.command === 'string' && rec.command.trim()) return { command: rec.command };
  return undefined;
}

/**
 * `run = "…"`, or named scripts — `[scripts.run.web] command = "…" default = true`
 * or `[scripts.run] web = "…"`. Order is the file's order; when none says
 * `default`, the first is the default, and when several do, the first of them.
 */
function runScriptsOf(v: unknown): WorkbenchNamedRunScript[] {
  if (typeof v === 'string') return v.trim() ? [{ name: 'run', command: v, default: true }] : [];
  const rec = asRecord(v);
  if (!rec) return [];
  // `{ command = "…" }` alone is one script, not a script named "command".
  if (typeof rec.command === 'string' && Object.values(rec).every((x) => typeof x !== 'object')) {
    const one = scriptOf(rec);
    return one ? [{ name: 'run', command: one.command, default: true }] : [];
  }
  const out: WorkbenchNamedRunScript[] = [];
  for (const [name, entry] of Object.entries(rec)) {
    const script = scriptOf(entry);
    if (!script) continue;
    const wantsDefault = asRecord(entry)?.default === true;
    out.push({ name, command: script.command, default: wantsDefault });
  }
  return normaliseDefault(out);
}

function normaliseDefault(scripts: WorkbenchNamedRunScript[]): WorkbenchNamedRunScript[] {
  if (scripts.length === 0) return scripts;
  const first = Math.max(0, scripts.findIndex((s) => s.default));
  return scripts.map((s, i) => ({ ...s, default: i === first }));
}

function runModeOf(...candidates: unknown[]): WorkbenchRunMode {
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const v = c.trim().toLowerCase().replace(/[_-]/g, '');
    if (v === 'nonconcurrent') return 'nonconcurrent';
    if (v === 'concurrent') return 'concurrent';
  }
  return 'concurrent';
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

/** The shared TOML shape: `[scripts]` with setup/run/archive, `run_mode` top-level or in `[scripts]`. */
function fromToml(doc: TomlTable): Shape {
  const scripts = asRecord(doc.scripts) ?? {};
  return {
    setup: scriptOf(scripts.setup),
    run: runScriptsOf(scripts.run),
    archive: scriptOf(scripts.archive),
    runMode: runModeOf(doc.run_mode, scripts.run_mode),
    filesToCopy: stringList(doc.files_to_copy ?? scripts.files_to_copy),
  };
}

/** `{ "scripts": { "setup", "run", "archive" }, "runScriptMode": "nonconcurrent" }`. */
function fromConductorJson(doc: unknown): Shape {
  const rec = asRecord(doc);
  if (!rec) throw new Error('conductor.json must be a JSON object');
  const scripts = asRecord(rec.scripts) ?? {};
  return {
    setup: scriptOf(scripts.setup),
    run: runScriptsOf(scripts.run),
    archive: scriptOf(scripts.archive),
    runMode: runModeOf(rec.runScriptMode, rec.run_mode, scripts.runScriptMode),
    filesToCopy: stringList(rec.filesToCopy ?? rec.files_to_copy),
  };
}

/**
 * The repository's config, from the first of the three files that is present
 * AND parses. A file that is present but broken is skipped with its error in
 * `errors` — the next file down is a better answer than no scripts at all, and
 * the error is still there for the settings screen to show.
 */
export function resolveWorkbenchConfig(files: WorkbenchConfigFiles): WorkbenchConfig {
  const errors: string[] = [];
  const attempts: Array<[Exclude<WorkbenchConfigSource, 'none'>, string, string | null | undefined, (text: string) => Shape]> = [
    ['talyn', '.talyn/settings.toml', files.talynToml, (t) => fromToml(parseToml(t))],
    ['conductor-json', 'conductor.json', files.conductorJson, (t) => fromConductorJson(JSON.parse(t))],
    ['conductor-toml', '.conductor/settings.toml', files.conductorToml, (t) => fromToml(parseToml(t))],
  ];
  for (const [source, fileName, text, parse] of attempts) {
    if (text === undefined || text === null || !text.trim()) continue;
    try {
      return { ...parse(text), source, errors };
    } catch (err) {
      errors.push(`${fileName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { run: [], runMode: 'concurrent', filesToCopy: [], source: 'none', errors };
}

/**
 * The workbench's own overrides on top of the repository's config. A string
 * replaces, an explicit `null` removes, an absent key keeps the file's value.
 */
export function applyWorkbenchScriptOverrides(
  config: WorkbenchConfig,
  settings: WorkbenchSettings | null | undefined
): WorkbenchConfig {
  const o = settings?.scripts;
  if (!o) return config;
  const out: WorkbenchConfig = { ...config };
  const pick = (value: string | null | undefined, fallback: WorkbenchScript | undefined) =>
    value === undefined ? fallback : value === null || !value.trim() ? undefined : { command: value };
  out.setup = pick(o.setup, config.setup);
  out.archive = pick(o.archive, config.archive);
  if (o.run !== undefined) {
    out.run = o.run === null ? [] : typeof o.run === 'string' ? runScriptsOf(o.run) : normaliseDefault(o.run.filter((s) => s.command.trim()));
  }
  if (o.runMode) out.runMode = o.runMode;
  return out;
}

// ============================================================================
// Environment
// ============================================================================

/** Ports reserved per workbench: `port` … `port + 9`. */
export const WORKBENCH_PORT_COUNT = 10;

/**
 * Variables every workbench script gets. `TALYN_PORT` is the first of
 * {@link WORKBENCH_PORT_COUNT} consecutive ports reserved for this workbench —
 * a script that needs more than one uses `$TALYN_PORT`, `$((TALYN_PORT+1))`, …
 * The `CONDUCTOR_*` names carry the same values, so scripts written for
 * Conductor run unchanged.
 */
export function workbenchEnv(opts: {
  workbenchPath: string;
  rootPath: string;
  name: string;
  port: number;
  defaultBranch?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    TALYN_WORKBENCH_PATH: opts.workbenchPath,
    TALYN_WORKBENCH_NAME: opts.name,
    TALYN_ROOT_PATH: opts.rootPath,
    TALYN_PORT: String(opts.port),
    CONDUCTOR_WORKSPACE_PATH: opts.workbenchPath,
    CONDUCTOR_WORKSPACE_NAME: opts.name,
    CONDUCTOR_ROOT_PATH: opts.rootPath,
    CONDUCTOR_PORT: String(opts.port),
  };
  if (opts.defaultBranch) {
    env.TALYN_DEFAULT_BRANCH = opts.defaultBranch;
    env.CONDUCTOR_DEFAULT_BRANCH = opts.defaultBranch;
  }
  return env;
}
