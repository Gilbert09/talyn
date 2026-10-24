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
import { parsePreviewConfig, type PreviewConfig } from './previewDetect.js';
import { parseToml, type TomlTable } from './toml.js';

// ============================================================================
// A TOML subset
// ============================================================================

export { parseToml, TomlError } from './toml.js';
export type { TomlValue, TomlTable } from './toml.js';

// ============================================================================
// Config
// ============================================================================

export interface WorkbenchScript {
  command: string;
}

export type WorkbenchConfigSource = 'talyn' | 'conductor-json' | 'conductor-toml' | 'none';

export interface WorkbenchConfig {
  detected?: DetectedWorkbenchScripts;
  preview?: PreviewConfig;
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
    ['talyn', '.talyn/settings.toml', files.talynToml, (t) => {
      const doc = parseToml(t);
      return { ...fromToml(doc), preview: parsePreviewConfig(doc.preview, (message) => errors.push(`.talyn/settings.toml: ${message}`)) };
    }],
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
