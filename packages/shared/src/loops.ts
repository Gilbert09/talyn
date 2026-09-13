/**
 * Loops — recurring prompts on a cron schedule.
 *
 * A loop is one sentence: *run this prompt, on this repository, with this
 * agent, on this schedule*. Every firing creates an ordinary cloud task, so
 * the poller, the transcript, the pull request the agent opens and the billing
 * gate all work unchanged. What Loops adds is the clock.
 *
 * # Why this file holds the schedule arithmetic
 *
 * The same reason `workflows.ts` holds the matcher and `prFilters.ts` holds the
 * predicate: two copies of "when does this next fire" drift, and the drift is
 * invisible. The editor draws "next run: tomorrow at 09:00" from these
 * functions and the backend scheduler picks the instant to fire from the same
 * ones, so a preview that disagrees with the behaviour is a type error rather
 * than a support ticket.
 *
 * # Why croner, and why it is the validator too
 *
 * `croner` is this package's first runtime dependency, and it earns that on one
 * job: daylight saving. An 02:30 daily loop has no 02:30 on the day the clocks
 * go forward, and two 01:30s on the day they go back — the arithmetic nobody
 * hand-rolls correctly and nobody notices is wrong until twice a year. Its
 * constructor throws on a pattern it cannot parse, so validation and evaluation
 * are the same code path and a schedule that previews cannot fail to run.
 *
 * # Presets are sugar; the cron string is the truth
 *
 * `LOOP_SCHEDULE_PRESETS` drives the editor's menu, but nothing stores a
 * preset. A loop stores a cron expression and an IANA timezone, and the editor
 * recovers "this is the Daily preset" by reading the expression back
 * ({@link presetForCron}). Storing both would be two sources of truth for one
 * fact, and the one that gets edited is not always the one that gets read.
 */

import { Cron } from 'croner';
import {
  DEFAULT_FLEET_MODEL_ID,
  DEFAULT_POSTHOG_CODE_MODEL_ID,
  FLEET_MODELS,
  POSTHOG_CODE_MODELS,
  isStoredFleetModelId,
  isStoredPostHogCodeModelId,
} from './index.js';

// ============================================================================
// Vocabulary
// ============================================================================

/**
 * Which cloud provider a loop runs on.
 *
 * A subset of `CloudProviderType`, listed here rather than imported so this
 * file states what a loop may actually pin. Codex Cloud is deferred and Claude
 * Code was removed; if a third provider lands, it lands here deliberately.
 */
export type LoopProvider = 'posthog_code' | 'selfhosted';

export const LOOP_PROVIDERS = ['posthog_code', 'selfhosted'] as const;

export const LOOP_PROVIDER_LABELS: Record<LoopProvider, string> = {
  posthog_code: 'PostHog Code',
  selfhosted: 'Talyn Fleet',
};

/** What a firing does when the previous run has not finished. */
export type LoopConcurrency = 'skip' | 'allow';

export const LOOP_CONCURRENCIES = ['skip', 'allow'] as const;

export const LOOP_CONCURRENCY_LABELS: Record<LoopConcurrency, string> = {
  skip: 'Skip this run',
  allow: 'Start it anyway',
};

/**
 * `skip` is the default, and it is what makes a tight schedule harmless.
 *
 * A loop set to every minute whose task takes twenty produces one real task and
 * nineteen recorded skips per cycle, rather than twenty agents racing each
 * other on one repository. That is why there is no minimum-interval rule: the
 * overlap answer already bounds the cost, so a floor would be a number with
 * nothing behind it.
 */
export const DEFAULT_LOOP_CONCURRENCY: LoopConcurrency = 'skip';

/** Why a run ended where it did. */
export type LoopRunStatus =
  /** Claimed, but the free-plan task cap was full. Retried until superseded. */
  | 'waiting_slot'
  /** A task exists and is waiting for the dispatcher. */
  | 'queued'
  /** The cloud agent is working. */
  | 'running'
  | 'succeeded'
  | 'failed'
  /** Deliberately not run — overlap, or a loop whose configuration has gone. */
  | 'skipped';

export const LOOP_RUN_STATUS_LABELS: Record<LoopRunStatus, string> = {
  waiting_slot: 'Waiting for a task slot',
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
};

/** Whether a person or the clock started this run. */
export type LoopRunTrigger = 'schedule' | 'manual';

/**
 * The machine-readable why, so the UI can explain a refusal instead of showing
 * a red dot. Every one of these is a state the user can act on.
 */
export type LoopRunFailureCode =
  | 'overlap'
  | 'task_limit_reached'
  | 'repo_missing'
  | 'environment_missing'
  | 'fleet_not_allowed'
  | 'agent_not_connected'
  | 'loops_not_allowed'
  | 'task_deleted'
  | 'dispatch_lost'
  | 'dispatch_failed';

export const LOOP_RUN_FAILURE_LABELS: Record<LoopRunFailureCode, string> = {
  overlap: 'The previous run was still going',
  task_limit_reached: 'The plan’s task limit was full',
  repo_missing: 'The repository is no longer connected',
  environment_missing: 'The agent is no longer connected',
  fleet_not_allowed: 'This workspace lost access to Talyn Fleet',
  agent_not_connected: 'That fleet agent is not connected',
  loops_not_allowed: 'This workspace lost access to Loops',
  task_deleted: 'The task was deleted before it finished',
  dispatch_lost: 'The run was claimed but never started',
  dispatch_failed: 'The task could not be created',
};

/** Why the engine — not the user — switched a loop off. */
export type LoopDisabledReason =
  | 'repo_missing'
  | 'environment_missing'
  | 'never_fires'
  | 'too_many_failures';

export const LOOP_DISABLED_REASON_LABELS: Record<LoopDisabledReason, string> = {
  repo_missing: 'Turned off because its repository is no longer connected.',
  environment_missing: 'Turned off because its agent is no longer connected.',
  never_fires: 'Turned off because its schedule has no future runs.',
  too_many_failures: 'Turned off after five runs failed in a row.',
};

export const MAX_LOOP_NAME_LENGTH = 80;

/**
 * How many consecutive failures switch a loop off.
 *
 * Not a tidy round number for its own sake: the point is to tell a transient
 * provider blip (which recovers on the next firing) from a loop that is broken
 * for good — a revoked fleet subscription, a prompt the agent cannot act on.
 * Five firings is long enough that a single bad afternoon does not disable a
 * daily loop, and short enough that a permanently broken hourly one stops
 * burning a task slot within the day. Any success resets the count.
 */
export const LOOP_FAILURE_LIMIT = 5;

// ============================================================================
// The stored shape
// ============================================================================

export interface LoopDefinition {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  prompt: string;
  /** Five-field cron. The one source of truth for the schedule. */
  cron: string;
  /** IANA zone name, e.g. `Europe/London`. */
  timezone: string;
  provider: LoopProvider;
  model: string;
  concurrency: LoopConcurrency;
  /** Null only after the repository row was deleted; `repoFullName` survives. */
  repositoryId: string | null;
  repoFullName: string;
  /** The next firing, maintained by the scheduler. Null while disabled. */
  nextRunAt: string | null;
  /** Set when the engine switched the loop off; null when the user did. */
  disabledReason: LoopDisabledReason | null;
  createdAt: string;
  updatedAt: string;
}

/** What a create or update sends. */
export interface LoopInput {
  name: string;
  enabled?: boolean;
  prompt: string;
  cron: string;
  timezone: string;
  provider: LoopProvider;
  model: string;
  concurrency?: LoopConcurrency;
  repositoryId: string;
  repoFullName: string;
}

/** The validator's output: exactly the columns a row holds. */
export interface NormalizedLoop {
  name: string;
  enabled: boolean;
  prompt: string;
  cron: string;
  timezone: string;
  provider: LoopProvider;
  model: string;
  concurrency: LoopConcurrency;
  repositoryId: string;
  repoFullName: string;
}

/**
 * The task a run started, joined at read time.
 *
 * Denormalising the task's status onto the run row would mean two rows to keep
 * in step across two settlement paths, so the run stores only the id and the
 * history reads the truth.
 */
export interface LoopRunTask {
  id: string;
  status: string;
  completedAt: string | null;
  prUrl: string | null;
  prNumber: number | null;
}

export interface LoopRun {
  id: string;
  loopId: string;
  workspaceId: string;
  /** The occurrence this run stands for — and its idempotency key. */
  scheduledFor: string;
  trigger: LoopRunTrigger;
  repositoryId: string | null;
  repoFullName: string;
  /** Copied from the loop at fire time, so history survives an edit. */
  provider: LoopProvider;
  model: string;
  taskId: string | null;
  status: LoopRunStatus;
  failureCode: LoopRunFailureCode | null;
  error: string | null;
  retryAfter: string | null;
  createdAt: string;
  settledAt: string | null;
  task?: LoopRunTask | null;
}

export interface LoopStats {
  runsTotal: number;
  runs7d: number;
  failures7d: number;
  lastRunAt: string | null;
  lastStatus: LoopRunStatus | null;
}

export interface LoopWithStats extends LoopDefinition {
  stats: LoopStats;
}

// ============================================================================
// Schedule presets — the editor's menu, as data
// ============================================================================

export type LoopSchedulePresetKind = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'cron';

/** The field a preset asks the editor to draw. */
export type LoopScheduleField = 'minute' | 'hour' | 'weekday' | 'expression';

export interface LoopSchedulePreset {
  kind: LoopSchedulePresetKind;
  label: string;
  hint: string;
  fields: readonly LoopScheduleField[];
}

/**
 * The "Schedule" menu. Data rather than a switch in the editor, for the reason
 * `WORKFLOW_CONDITION_SPECS` is: both front ends are forks, and a menu written
 * twice is a menu that says two different things.
 */
export const LOOP_SCHEDULE_PRESETS: readonly LoopSchedulePreset[] = [
  { kind: 'hourly', label: 'Hourly', hint: 'Every hour, at the minute you pick.', fields: ['minute'] },
  { kind: 'daily', label: 'Daily', hint: 'Once a day, at the time you pick.', fields: ['hour', 'minute'] },
  {
    kind: 'weekdays',
    label: 'Weekdays',
    hint: 'Monday to Friday, at the time you pick.',
    fields: ['hour', 'minute'],
  },
  { kind: 'weekly', label: 'Weekly', hint: 'Once a week, on the day you pick.', fields: ['weekday', 'hour', 'minute'] },
  { kind: 'cron', label: 'Custom cron', hint: 'A five-field cron expression.', fields: ['expression'] },
];

export interface LoopScheduleFields {
  minute: number;
  hour: number;
  weekday: number;
  expression: string;
}

export const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const DEFAULT_LOOP_SCHEDULE_FIELDS: LoopScheduleFields = {
  minute: 0,
  hour: 9,
  weekday: 1,
  expression: '0 9 * * *',
};

/** Render a preset choice to the cron expression that is actually stored. */
export function cronForPreset(
  kind: LoopSchedulePresetKind,
  fields: LoopScheduleFields
): string {
  const minute = clampInt(fields.minute, 0, 59, 0);
  const hour = clampInt(fields.hour, 0, 23, 9);
  const weekday = clampInt(fields.weekday, 0, 6, 1);
  switch (kind) {
    case 'hourly':
      return `${minute} * * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`;
    case 'weekly':
      return `${minute} ${hour} * * ${weekday}`;
    case 'cron':
      return fields.expression.trim();
  }
}

export interface LoopPresetMatch {
  kind: LoopSchedulePresetKind;
  fields: LoopScheduleFields;
}

/**
 * Read a stored cron back into the preset that would produce it.
 *
 * This is what lets the editor re-open on "Daily, 09:00" rather than dropping
 * every saved loop into the raw cron box. An expression no preset produces
 * answers `cron`, which is the honest result and not a failure.
 */
export function presetForCron(cron: string): LoopPresetMatch {
  const parts = cron.trim().split(/\s+/);
  const custom: LoopPresetMatch = {
    kind: 'cron',
    fields: { ...DEFAULT_LOOP_SCHEDULE_FIELDS, expression: cron.trim() },
  };
  if (parts.length !== 5) return custom;

  const [min, hr, dom, mon, dow] = parts;
  const minute = plainInt(min);
  if (minute === null || dom !== '*' || mon !== '*') return custom;

  const base = { ...DEFAULT_LOOP_SCHEDULE_FIELDS, minute, expression: cron.trim() };

  if (hr === '*' && dow === '*') return { kind: 'hourly', fields: base };

  const hour = plainInt(hr);
  if (hour === null) return custom;

  if (dow === '*') return { kind: 'daily', fields: { ...base, hour } };
  if (dow === '1-5') return { kind: 'weekdays', fields: { ...base, hour } };

  const weekday = plainInt(dow);
  if (weekday !== null && weekday >= 0 && weekday <= 6) {
    return { kind: 'weekly', fields: { ...base, hour, weekday } };
  }
  return custom;
}

// ============================================================================
// Schedule arithmetic
// ============================================================================

/** Whether the runtime knows this IANA zone. Works in a browser and in Node. */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone || typeof timezone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export type CronCheck = { ok: true } | { ok: false; error: string };

/**
 * Whether an expression is one Talyn can run.
 *
 * Five fields only. croner also accepts a sixth (seconds), and that is refused
 * deliberately: each firing writes a durable row and creates a cloud task whose
 * own dispatcher ticks at five seconds, so a per-second schedule promises a
 * cadence the rest of the system cannot keep. Refusing it with a reason beats
 * accepting it and quietly firing once a minute.
 */
export function validateCron(expression: string, timezone = 'UTC'): CronCheck {
  const expr = (expression ?? '').trim();
  if (!expr) return { ok: false, error: 'a schedule needs a cron expression' };

  const fields = expr.split(/\s+/).length;
  if (fields === 6) {
    return {
      ok: false,
      error: 'a loop schedule takes five fields (minute hour day month weekday) — seconds are not supported',
    };
  }
  if (fields !== 5) {
    return { ok: false, error: `a cron expression has five fields, this one has ${fields}` };
  }

  const zone = isValidTimezone(timezone) ? timezone : 'UTC';
  let next: Date | null;
  try {
    next = new Cron(expr, { timezone: zone }).nextRun();
  } catch {
    return { ok: false, error: `"${expr}" is not a cron expression Talyn understands` };
  }
  // croner answering null IS the "never fires" answer — `0 0 30 2 *` parses and
  // has no occurrence, ever. There is deliberately NO cap on how far away the
  // next run may be: the longest legitimate cron period is annual, and
  // `0 9 29 2 *` (09:00 every 29 February) can be three years out. A horizon
  // check here refused exactly that schedule.
  if (!next) return { ok: false, error: `"${expr}" has no future runs` };
  return { ok: true };
}

/**
 * The next instant this schedule fires, strictly after `from`.
 *
 * Null means the schedule is spent (`0 0 30 2 *` — 30 February). The scheduler
 * treats that as a reason to switch the loop off rather than leave it with no
 * next run, so a dead schedule is visible instead of silently inert.
 */
export function nextLoopRun(cron: string, timezone: string, from: Date): Date | null {
  const zone = isValidTimezone(timezone) ? timezone : 'UTC';
  try {
    return new Cron(cron.trim(), { timezone: zone }).nextRun(from);
  } catch {
    return null;
  }
}

/** The next `count` firings — the editor's preview. */
export function nextLoopRuns(
  cron: string,
  timezone: string,
  from: Date,
  count: number
): Date[] {
  const zone = isValidTimezone(timezone) ? timezone : 'UTC';
  try {
    return new Cron(cron.trim(), { timezone: zone }).nextRuns(count, from);
  } catch {
    return [];
  }
}

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** A one-line description of a schedule, for the list row and the editor. */
export function describeSchedule(cron: string, timezone: string): string {
  const match = presetForCron(cron);
  const { minute, hour, weekday } = match.fields;
  const at = `${two(hour)}:${two(minute)}`;
  const zone = timezone ? ` (${timezone})` : '';
  switch (match.kind) {
    case 'hourly':
      return `Every hour at :${two(minute)}${zone}`;
    case 'daily':
      return `Every day at ${at}${zone}`;
    case 'weekdays':
      return `Weekdays at ${at}${zone}`;
    case 'weekly':
      return `Every ${WEEKDAY_LABELS[weekday]} at ${at}${zone}`;
    case 'cron':
      return `Cron: ${cron.trim()}${zone}`;
  }
}

// ============================================================================
// Validation
// ============================================================================

function fail(message: string): never {
  throw new Error(message);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function plainInt(raw: string): number | null {
  if (!/^\d{1,2}$/.test(raw)) return null;
  return Number(raw);
}

/** Every model the chosen provider may actually run. */
export function modelsForLoopProvider(
  provider: LoopProvider
): readonly { id: string; label: string; blurb: string }[] {
  return provider === 'selfhosted' ? FLEET_MODELS : POSTHOG_CODE_MODELS;
}

export function defaultModelForLoopProvider(provider: LoopProvider): string {
  return provider === 'selfhosted' ? DEFAULT_FLEET_MODEL_ID : DEFAULT_POSTHOG_CODE_MODEL_ID;
}

/**
 * A model belongs to its provider, or the loop is refused.
 *
 * The two catalogues OVERLAP — `claude-opus-5` is in both — which is exactly
 * why a loop stores the provider as well as the model. Where they do not
 * overlap, the refusal names the right catalogue: telling someone "invalid
 * model" when the real answer is "that one is a fleet model" costs them the
 * next ten minutes.
 */
function validateProviderModel(provider: LoopProvider, model: string): void {
  if (provider === 'posthog_code') {
    if (isStoredPostHogCodeModelId(model)) return;
    if (isStoredFleetModelId(model)) {
      fail(`${model} is a Talyn Fleet model — PostHog Code runs Claude models only`);
    }
    fail(`${model} is not a model PostHog Code can run`);
  }
  if (isStoredFleetModelId(model)) return;
  fail(`${model} is not a model Talyn Fleet can run`);
}

/**
 * Validate a create or update body.
 *
 * Throws a user-facing message the route passes straight through as a 400, the
 * `validateWorkflow` contract: the person editing the loop reads this text, so
 * it says what to do rather than which field failed a type check.
 *
 * What this CANNOT check is anything that needs the database — that the
 * repository belongs to the workspace, that the fleet agent is connected, that
 * the workspace is still in the Loops audience. Those are route checks, and
 * they are re-checked again at fire time, because access can be taken away
 * after a loop is saved.
 */
export function validateLoop(raw: unknown): NormalizedLoop {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('loop must be an object');
  const l = raw as Record<string, unknown>;

  const name = typeof l.name === 'string' ? l.name.trim() : '';
  if (!name) fail('name must be a non-empty string');
  if (name.length > MAX_LOOP_NAME_LENGTH) {
    fail(`name must be ${MAX_LOOP_NAME_LENGTH} characters or fewer`);
  }

  if (l.enabled !== undefined && typeof l.enabled !== 'boolean') {
    fail('enabled must be a boolean');
  }

  const prompt = typeof l.prompt === 'string' ? l.prompt.trim() : '';
  if (!prompt) fail('a loop needs a prompt — it is the whole instruction the agent gets');

  const timezone = typeof l.timezone === 'string' ? l.timezone.trim() : '';
  if (!timezone) fail('timezone must be an IANA zone name, such as Europe/London');
  if (!isValidTimezone(timezone)) fail(`"${timezone}" is not a timezone this system knows`);

  const cron = typeof l.cron === 'string' ? l.cron.trim() : '';
  const check = validateCron(cron, timezone);
  if (!check.ok) fail(check.error);

  const provider = l.provider as LoopProvider;
  if (!(LOOP_PROVIDERS as readonly string[]).includes(provider)) {
    fail('provider must be posthog_code or selfhosted');
  }

  const model = typeof l.model === 'string' ? l.model.trim() : '';
  if (!model) fail('a loop needs a model');
  validateProviderModel(provider, model);

  let concurrency = DEFAULT_LOOP_CONCURRENCY;
  if (l.concurrency !== undefined) {
    if (!(LOOP_CONCURRENCIES as readonly string[]).includes(l.concurrency as string)) {
      fail('concurrency must be skip or allow');
    }
    concurrency = l.concurrency as LoopConcurrency;
  }

  const repositoryId = typeof l.repositoryId === 'string' ? l.repositoryId.trim() : '';
  if (!repositoryId) fail('a loop must pick a repository — the agent has to have something to clone');

  const repoFullName = typeof l.repoFullName === 'string' ? l.repoFullName.trim() : '';
  if (!/^[^/\s]+\/[^/\s]+$/.test(repoFullName)) {
    fail('repoFullName must look like owner/repo');
  }

  return {
    name,
    enabled: l.enabled === undefined ? true : (l.enabled as boolean),
    prompt,
    cron,
    timezone,
    provider,
    model,
    concurrency,
    repositoryId,
    repoFullName,
  };
}

// ============================================================================
// Editor helpers
// ============================================================================

/**
 * Whether the Loops surface should be drawn at all.
 *
 * The three-state rule `workflowsOffered` documents: `null` means the
 * capability answer has not arrived, and drawing on that flashes the nav item
 * in on every launch. Not authorisation — every route and the scheduler gate
 * independently.
 */
export function loopsOffered(features: { loops?: boolean } | null | undefined): boolean {
  return features?.loops === true;
}

/** The browser's zone, or UTC where there is no browser. */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A blank loop the editor opens on. Save stays refused until it is complete. */
export function emptyLoopInput(timezone = localTimezone()): LoopInput {
  return {
    name: '',
    enabled: true,
    prompt: '',
    cron: '0 9 * * *',
    timezone,
    provider: 'posthog_code',
    model: DEFAULT_POSTHOG_CODE_MODEL_ID,
    concurrency: DEFAULT_LOOP_CONCURRENCY,
    repositoryId: '',
    repoFullName: '',
  };
}

export function loopToInput(loop: LoopDefinition): LoopInput {
  return {
    name: loop.name,
    enabled: loop.enabled,
    prompt: loop.prompt,
    cron: loop.cron,
    timezone: loop.timezone,
    provider: loop.provider,
    model: loop.model,
    concurrency: loop.concurrency,
    repositoryId: loop.repositoryId ?? '',
    repoFullName: loop.repoFullName,
  };
}

/**
 * Why Save is refused, or null when it is not.
 *
 * Runs the real validator rather than a second set of rules, so the disabled
 * button and the server's 400 can never disagree about what is wrong.
 */
export function loopInputProblem(input: LoopInput): string | null {
  try {
    validateLoop(input);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'this loop is not valid';
  }
}
