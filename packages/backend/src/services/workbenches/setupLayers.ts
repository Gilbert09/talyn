import { createHash, randomUUID } from 'node:crypto';
import { and, asc, count, eq, gt, gte, inArray, isNotNull, isNull, lte, max, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  boxSetupScript,
  buildUserLayerSpec,
  defaultRunOn,
  isHeavySetupStep,
  learnedBakeStepId,
  legacyBakeFor,
  LEGACY_DOCKER_START_COMMAND,
  parseLearnedStepResults,
  parseSetupTiming,
  phaseOfRunOn,
  redactSecrets,
  repoSetupRunsOnBox,
  SETUP_LIST_LIMITS,
  SETUP_LIST_MAX_USER_STEPS,
  SETUP_RECIPE_MAX_STEPS,
  SETUP_RECIPE_SETTLE_MS,
  SETUP_STEP_MAX_BOX_FAILURES,
  SETUP_STEP_TIMEOUT_SEC,
  SETUP_STEP_TYPICAL_WEIGHT,
  SETUP_STEP_WINDOW_DAYS,
  SETUP_TIMING_HISTORY,
  setupStepIdentity,
  setupStepName,
  setupStepUsed,
  setupStepVerdict,
  turnCommandWords,
  USER_STEP_MAX_SEC,
  userSetupStepCheck,
  validateRepositoryBake,
  type AppliedSetupStep,
  type BakeStepResult,
  type BoxCandidate,
  type BoxLayerContext,
  type CreateSandboxLayers,
  type LayerCandidate,
  type LayerStepResult,
  type LearnedStepResult,
  type PutRepositorySetupInput,
  type PutWorkspaceSandboxSetupInput,
  type RepositoryBake,
  type RepositorySetup,
  type RepoSetupInfo,
  type RepoSetupRunOnBox,
  type RepoSetupSource,
  type SandboxDotfiles,
  type SetupImageStatus,
  type SetupListStep,
  type SetupListStepInput,
  type SetupRecipe,
  type SetupRecipeStep,
  type SetupStepAcceptedBy,
  type SetupStepCandidate,
  type SetupStepKind,
  type SetupStepOrigin,
  type SetupStepRunOn,
  type SetupStepSource,
  type SetupStepStatus,
  type SetupTiming,
  type TurnToolCall,
  type UserLayerSpec,
  type WorkbenchConfig,
  type WorkbenchSettings,
  type WorkspaceSandboxSetup,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import {
  repositories,
  repositorySetupStepSessions as stepSessions,
  setupSteps as steps,
  workbenches,
  workspaces,
} from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { scriptOutput } from './scriptStore.js';

/**
 * The Setup list: storage, the box setup, and the image layers. The pure rules
 * are in `packages/shared/src/setupLayers.ts` (lists, layers, the box script)
 * and `packages/shared/src/setupRecipe.ts` (what Talyn learns, and the
 * frequency rule).
 *
 * One table, `setup_steps`: the repository's steps (`repository_id` set) and
 * the workspace's steps (`repository_id` null). A learned step starts as
 * `suggested`. The frequency rule ({@link reconcileSetupSteps}) accepts it
 * (`accepted_by = 'talyn'`), and removes it again when few sessions need it.
 * Talyn never removes a step that a person wrote or accepted.
 *
 * No lock anywhere. The unique (workspace, repository, step key) index makes
 * a step that two sessions learn at once one row, and every change is one
 * statement that matches only the state it changes.
 */

const db = () => getPoolDbClient();

export const STEP_COLUMNS = {
  id: steps.id,
  repositoryId: steps.repositoryId,
  position: steps.position,
  name: steps.name,
  command: steps.command,
  kind: steps.kind,
  runOn: steps.runOn,
  origin: steps.origin,
  status: steps.status,
  statusReason: steps.statusReason,
  statusChangedAt: steps.statusChangedAt,
  acceptedBy: steps.acceptedBy,
  timeoutSec: steps.timeoutSec,
  why: steps.why,
  sourceWorkbenchId: steps.sourceWorkbenchId,
  seenCount: steps.seenCount,
  firstSeenAt: steps.firstSeenAt,
  lastSeenAt: steps.lastSeenAt,
  sessionCount: steps.sessionCount,
  confirmedAt: steps.confirmedAt,
  imageAppliedAt: steps.imageAppliedAt,
  imageFailedAt: steps.imageFailedAt,
  imageFailureReason: steps.imageFailureReason,
  boxFailureCount: steps.boxFailureCount,
  boxLastFailure: steps.boxLastFailure,
  lastDurationMs: steps.lastDurationMs,
  typicalDurationMs: steps.typicalDurationMs,
  measuredBoxes: steps.measuredBoxes,
  createdAt: steps.createdAt,
  updatedAt: steps.updatedAt,
} as const;

export type StepRow = Pick<typeof steps.$inferSelect, keyof typeof STEP_COLUMNS>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

interface StepUsage {
  neededBy: number;
  sessions: number;
  heavy: boolean;
  reason: string | null;
}

const learned = (row: Pick<StepRow, 'origin'>) => row.origin !== 'user';

export function rowToListStep(row: StepRow, usage?: StepUsage): SetupListStep {
  const check = row.origin === 'user' ? userSetupStepCheck(row.command) : null;
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    position: row.position,
    name: row.name,
    command: row.command,
    kind: row.kind as SetupStepKind,
    runOn: row.runOn as SetupStepRunOn,
    origin: row.origin as SetupStepOrigin,
    status: row.status as SetupStepStatus,
    statusReason: row.statusReason,
    statusChangedAt: iso(row.statusChangedAt),
    acceptedBy: (row.acceptedBy as SetupStepAcceptedBy | null) ?? null,
    timeoutSec: row.timeoutSec,
    boxOnlyReason: check?.forceBox ?? null,
    why: row.why,
    sourceWorkbenchId: row.sourceWorkbenchId,
    seenCount: row.seenCount,
    sessionCount: row.sessionCount,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    confirmedAt: iso(row.confirmedAt),
    imageAppliedAt: iso(row.imageAppliedAt),
    imageFailedAt: iso(row.imageFailedAt),
    imageFailureReason: row.imageFailureReason,
    boxFailureCount: row.boxFailureCount,
    boxLastFailure: row.boxLastFailure,
    lastDurationMs: row.lastDurationMs,
    typicalDurationMs: row.typicalDurationMs,
    measuredBoxes: row.measuredBoxes,
    ...(usage && learned(row)
      ? {
          recentNeededSessions: usage.neededBy,
          recentSessions: usage.sessions,
          share: usage.sessions > 0 ? usage.neededBy / usage.sessions : null,
          heavy: usage.heavy,
          ...(usage.reason ? { verdictReason: usage.reason } : {}),
        }
      : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The dedupe key. Keyed on {@link setupStepIdentity}, which is the command for every kind but cargo. */
export function stepKey(kind: SetupStepKind, command: string): string {
  return createHash('sha256').update(`${kind}\0${setupStepIdentity(kind, command)}`).digest('hex');
}

const newStepId = () => `st_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

// ============================================================================
// Settings
// ============================================================================

interface SetupSettings {
  exists: boolean;
  workspaceId: string | null;
  disabled: boolean;
  /** When Talyn first counted uses of live steps for this repository (`recordStepUses`). */
  usageSince: Date | null;
  timing: SetupTiming | null;
  history: SetupTiming[];
  hosts: string[];
  repoSetup: RepoSetupInfo;
  image: SetupImageStatus | null;
  /** The repository stored a bake once, or a person saved the list: the legacy bake is sent even when empty. */
  explicitBake: boolean;
}

const jsonOf = <T>(value: unknown): T | null =>
  (typeof value === 'string' ? (JSON.parse(value) as T) : (value as T)) ?? null;
const RUN_ON_BOX = new Set<RepoSetupRunOnBox>(['always', 'moved', 'never']);

/** Only the fields the list needs: `repositories.settings` also holds the preview detection. */
export function setupSettingsQuery(repositoryId: string) {
  return db()
    .select({
      workspaceId: repositories.workspaceId,
      disabled: sql<boolean>`coalesce((${repositories.settings} -> 'setupLearning' ->> 'disabled')::boolean, false)`,
      usageSince: sql<string | null>`${repositories.settings} ->> 'setupUsageSince'`,
      timing: sql<SetupTiming | null>`${repositories.settings} -> 'setupTiming'`,
      history: sql<SetupTiming[] | null>`${repositories.settings} -> 'setupTimingHistory'`,
      hosts: sql<string[] | null>`${repositories.settings} -> 'setupHosts'`,
      repoSetup: sql<SetupSettings['repoSetup'] | null>`${repositories.settings} -> 'repoSetup'`,
      image: sql<SetupImageStatus | null>`${repositories.settings} -> 'setupImage'`,
      explicitBake: sql<boolean>`(coalesce(${repositories.settings}, '{}'::jsonb) ? 'bake' OR coalesce((${repositories.settings} ->> 'setupListEdited')::boolean, false))`,
    })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
}

const bool = (value: unknown) => value === true || value === 't' || value === 'true';

async function repositorySetupSettings(repositoryId: string): Promise<SetupSettings> {
  const [row] = await setupSettingsQuery(repositoryId);
  const none: RepoSetupInfo = { command: null, source: null, readAt: null, runOnBox: 'always' };
  if (!row) {
    return {
      exists: false, workspaceId: null, disabled: false, usageSince: null, timing: null, history: [], hosts: [],
      repoSetup: none, image: null, explicitBake: false,
    };
  }
  const usageSince = row.usageSince ? new Date(row.usageSince) : null;
  const repoSetup = jsonOf<Partial<RepoSetupInfo>>(row.repoSetup) ?? {};
  const hosts = jsonOf<string[]>(row.hosts);
  const history = jsonOf<SetupTiming[]>(row.history);
  return {
    exists: true,
    workspaceId: row.workspaceId,
    disabled: bool(row.disabled),
    usageSince: usageSince && !Number.isNaN(usageSince.getTime()) ? usageSince : null,
    timing: jsonOf<SetupTiming>(row.timing),
    history: Array.isArray(history) ? history : [],
    hosts: Array.isArray(hosts) ? hosts.filter((h) => typeof h === 'string') : [],
    repoSetup: {
      command: repoSetup.command ?? null,
      source: repoSetup.source ?? null,
      readAt: repoSetup.readAt ?? null,
      runOnBox: repoSetup.runOnBox && RUN_ON_BOX.has(repoSetup.runOnBox) ? repoSetup.runOnBox : 'always',
    },
    image: jsonOf<SetupImageStatus>(row.image),
    explicitBake: bool(row.explicitBake),
  };
}

/** Merge a small object into `repositories.settings`, one statement. */
async function mergeRepositorySettings(repositoryId: string, patch: Record<string, unknown>): Promise<void> {
  await db().update(repositories).set({
    settings: sql`coalesce(${repositories.settings}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
  }).where(eq(repositories.id, repositoryId));
}

interface WorkspaceSetupSettings {
  dotfiles: SandboxDotfiles | null;
  hosts: string[];
}

export function workspaceSetupQuery(workspaceId: string) {
  return db()
    .select({ sandboxSetup: sql<WorkspaceSetupSettings | null>`${workspaces.settings} -> 'sandboxSetup'` })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
}

async function workspaceSetupSettings(workspaceId: string): Promise<WorkspaceSetupSettings & { exists: boolean }> {
  const [row] = await workspaceSetupQuery(workspaceId);
  if (!row) return { exists: false, dotfiles: null, hosts: [] };
  const raw = jsonOf<Partial<WorkspaceSetupSettings>>(row.sandboxSetup) ?? {};
  const dotfiles = raw.dotfiles && typeof raw.dotfiles.slug === 'string' && raw.dotfiles.slug
    ? { slug: raw.dotfiles.slug, ref: typeof raw.dotfiles.ref === 'string' ? raw.dotfiles.ref : '', install: raw.dotfiles.install ?? null }
    : null;
  return { exists: true, dotfiles, hosts: Array.isArray(raw.hosts) ? raw.hosts.filter((h) => typeof h === 'string') : [] };
}

export async function learningDisabled(repositoryId: string): Promise<boolean> {
  return (await repositorySetupSettings(repositoryId)).disabled;
}

export async function setSetupLearning(repositoryId: string, disabled: boolean): Promise<void> {
  await mergeRepositorySettings(repositoryId, { setupLearning: { disabled, changedAt: new Date().toISOString() } });
  debugBus.recordEvent({
    service: 'setup_recipe',
    action: disabled ? 'learning_disabled' : 'learning_enabled',
    summary: disabled ? 'Setup learning was turned off for a repository.' : 'Setup learning was turned on for a repository.',
    meta: { repositoryId },
  });
}

// ============================================================================
// Reading the list, and the frequency rule
// ============================================================================

const WINDOW_MS = SETUP_STEP_WINDOW_DAYS * 24 * 60 * 60_000;

/**
 * Every step of the repository with its share of the repository's recent
 * sessions. One statement: the session counts are subqueries that read only
 * `workbenches.id`, through the (workspace, created_at) index.
 *
 * Both counts are over the same sessions, the repository's sandbox sessions
 * that started in the window, so the share is never more than 1. A local
 * session is never analysed, so it must not count as a session that did not
 * need the step. The window start goes in as text: a `Date` in a raw `sql`
 * fragment reaches postgres-js unencoded.
 */
export function stepUsageQuery(repositoryId: string, since: Date) {
  const recent = sql`
    w.workspace_id = (SELECT r.workspace_id FROM ${repositories} r WHERE r.id = ${repositoryId})
    AND w.repository_id = ${repositoryId}
    AND w.kind = 'session'
    AND w.runtime = 'sandbox'
    AND w.created_at >= ${since.toISOString()}::timestamptz`;
  return db()
    .select({
      ...STEP_COLUMNS,
      neededBy: sql<number>`CASE WHEN ${steps.origin} = 'user' THEN 0 ELSE (
        SELECT count(*)::int FROM ${stepSessions} ss JOIN ${workbenches} w ON w.id = ss.workbench_id
        WHERE ss.step_id = ${steps}.id AND ${recent}) END`,
      sessions: sql<number>`(SELECT count(*)::int FROM ${workbenches} w WHERE ${recent})`,
    })
    .from(steps)
    .where(eq(steps.repositoryId, repositoryId))
    .orderBy(asc(steps.position), asc(steps.createdAt), asc(steps.id));
}

const statusOrder = (s: SetupListStep) => (s.status === 'dismissed' ? 1 : 0);
const listOrder = (a: SetupListStep, b: SetupListStep) => statusOrder(a) - statusOrder(b) || a.position - b.position;

/**
 * Apply {@link setupStepVerdict} to every learned step that Talyn decides
 * about, and return the whole list. A suggested step that enough sessions
 * need becomes active (`accepted_by = 'talyn'`). An active step that Talyn
 * accepted and that few sessions need goes back to suggested, with the reason,
 * and leaves the box setup and the image. A person's step, a step a person
 * accepted, and dismissed or disabled steps do not change.
 *
 * An active step leaves only after {@link SETUP_STEP_WINDOW_DAYS} days of
 * usage data ({@link recordStepUses}). Before that, the sessions that used it
 * without running it were not counted, and the step would look unneeded.
 */
export async function reconcileSetupSteps(
  repositoryId: string,
  opts: { now?: Date; settings?: SetupSettings; workspaceId?: string } = {},
): Promise<SetupListStep[]> {
  const now = opts.now ?? new Date();
  const settings = opts.settings ?? (await repositorySetupSettings(repositoryId));
  const canDrop = settings.usageSince !== null && now.getTime() - settings.usageSince.getTime() >= WINDOW_MS;
  const rows = await stepUsageQuery(repositoryId, new Date(now.getTime() - WINDOW_MS));
  const out: SetupListStep[] = [];
  for (const { neededBy: rawNeeded, sessions: rawSessions, ...row } of rows) {
    const usage: StepUsage = { neededBy: Number(rawNeeded), sessions: Number(rawSessions), heavy: isHeavySetupStep(row.command), reason: null };
    const decides = learned(row) && (row.status === 'suggested' || (row.status === 'active' && row.acceptedBy === 'talyn'));
    if (!decides) {
      out.push(rowToListStep(row, usage));
      continue;
    }
    const live = row.status === 'active';
    const verdict = setupStepVerdict({
      live,
      heavy: usage.heavy,
      neededBy: usage.neededBy,
      sessions: usage.sessions,
      typicalDurationMs: row.typicalDurationMs,
      canDrop,
    });
    usage.reason = verdict.reason;
    let current: StepRow = row;
    if (verdict.live && !live) {
      const [updated] = await db()
        .update(steps)
        .set({ status: 'active', acceptedBy: 'talyn', confirmedAt: now, statusReason: null, statusChangedAt: now, updatedAt: now })
        .where(and(eq(steps.id, row.id), eq(steps.status, 'suggested')))
        .returning(STEP_COLUMNS);
      if (updated) {
        current = updated;
        debugBus.recordEvent({
          service: 'setup_recipe',
          action: 'step_confirmed',
          summary: `Setup step ${row.id} now runs on new boxes. ${verdict.reason}`,
          workspaceId: opts.workspaceId,
          meta: { repositoryId, stepId: row.id, kind: row.kind },
        });
      }
    } else if (!verdict.live && live) {
      const reason = `Talyn removed this step on ${now.toISOString().slice(0, 10)}: ${verdict.reason}`;
      const [updated] = await db()
        .update(steps)
        .set({ status: 'suggested', acceptedBy: null, confirmedAt: null, imageAppliedAt: null, statusReason: reason, statusChangedAt: now, updatedAt: now })
        .where(and(eq(steps.id, row.id), eq(steps.status, 'active'), eq(steps.acceptedBy, 'talyn')))
        .returning(STEP_COLUMNS);
      if (updated) {
        current = updated;
        debugBus.recordEvent({
          service: 'setup_recipe',
          action: 'step_dropped',
          summary: `Setup step ${row.id} no longer runs on new boxes or in the image. ${verdict.reason}`,
          workspaceId: opts.workspaceId,
          meta: { repositoryId, stepId: row.id, kind: row.kind },
        });
      }
    }
    out.push(rowToListStep(current, usage));
  }
  return out.sort(listOrder);
}

/** `GET /repositories/:id/setup`. Null: no such repository. */
export async function getRepositorySetup(repositoryId: string, now = new Date()): Promise<RepositorySetup | null> {
  const settings = await repositorySetupSettings(repositoryId);
  if (!settings.exists) return null;
  return {
    repositoryId,
    learningDisabled: settings.disabled,
    windowDays: SETUP_STEP_WINDOW_DAYS,
    maxLearnedSteps: SETUP_RECIPE_MAX_STEPS,
    limits: SETUP_LIST_LIMITS,
    repoSetup: settings.repoSetup,
    steps: await reconcileSetupSteps(repositoryId, { now, settings, workspaceId: settings.workspaceId ?? undefined }),
    hosts: settings.hosts,
    image: settings.image,
    lastSetupTiming: settings.timing,
    timingHistory: settings.history,
  };
}

export function workspaceStepsQuery(workspaceId: string) {
  return db()
    .select(STEP_COLUMNS)
    .from(steps)
    .where(and(eq(steps.workspaceId, workspaceId), isNull(steps.repositoryId)))
    .orderBy(asc(steps.position), asc(steps.createdAt), asc(steps.id));
}

/** `GET /workspaces/:id/sandbox-setup`. Null: no such workspace. */
export async function getWorkspaceSandboxSetup(workspaceId: string): Promise<WorkspaceSandboxSetup | null> {
  const settings = await workspaceSetupSettings(workspaceId);
  if (!settings.exists) return null;
  return {
    workspaceId,
    dotfiles: settings.dotfiles,
    hosts: settings.hosts,
    steps: (await workspaceStepsQuery(workspaceId)).map((row) => rowToListStep(row)),
    limits: SETUP_LIST_LIMITS,
  };
}

// ============================================================================
// Writing the list
// ============================================================================

/** A refusal of a PUT. The routes answer 400 with the code. */
export class SetupListError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400) {
    super(message);
  }
}

const RUN_ONS = new Set<SetupStepRunOn>(['image', 'box', 'both']);
const bytes = (value: string) => new TextEncoder().encode(value).length;

/** The same host rule as the bake (`validateRepositoryBake`), so the image build accepts them. */
export function validateSetupHosts(value: unknown): string[] {
  if (!Array.isArray(value)) throw new SetupListError('hosts must be a list of host names.', 'invalid_hosts');
  try {
    const checked = validateRepositoryBake({ steps: [{ name: 'hosts', run: 'true' }], hosts: value });
    return checked.hosts ?? [];
  } catch (err) {
    throw new SetupListError((err as Error).message, 'invalid_hosts');
  }
}

interface CheckedInput {
  id?: string;
  name: string;
  command?: string;
  runOn: SetupStepRunOn;
  timeoutSec: number | null;
}

function checkStepInput(raw: unknown, index: number): CheckedInput {
  const field = `Step ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SetupListError(`${field} is not an object.`, 'invalid_step');
  const step = raw as Partial<SetupListStepInput>;
  if (step.id !== undefined && (typeof step.id !== 'string' || !step.id)) throw new SetupListError(`${field} has an invalid id.`, 'invalid_step');
  if (typeof step.name !== 'string' || !step.name.trim() || bytes(step.name) > 128 || /[\r\n]/.test(step.name)) {
    throw new SetupListError(`${field} name must be 1 to 128 bytes with no line breaks.`, 'invalid_step');
  }
  if (step.command !== undefined && typeof step.command !== 'string') throw new SetupListError(`${field} command must be text.`, 'invalid_step');
  if (!step.runOn || !RUN_ONS.has(step.runOn)) throw new SetupListError(`${field} runs on must be image, box or both.`, 'invalid_step');
  if (step.timeoutSec !== undefined && step.timeoutSec !== null
    && (!Number.isInteger(step.timeoutSec) || step.timeoutSec < 1 || step.timeoutSec > USER_STEP_MAX_SEC)) {
    throw new SetupListError(`${field} timeout must be 1 to ${USER_STEP_MAX_SEC} seconds.`, 'invalid_step');
  }
  return { id: step.id, name: step.name.trim(), command: step.command, runOn: step.runOn, timeoutSec: step.timeoutSec ?? null };
}

/**
 * Write a list in the order given. `scope` is the repository's steps or the
 * workspace's steps. Checks everything before it writes anything, so a
 * refusal changes nothing.
 */
async function writeList(
  scope: { workspaceId: string; repositoryId: string | null },
  inputs: unknown,
  now: Date,
): Promise<void> {
  if (!Array.isArray(inputs)) throw new SetupListError('steps must be a list.', 'invalid_steps');
  const checked = inputs.map(checkStepInput);
  const where = scope.repositoryId
    ? and(eq(steps.workspaceId, scope.workspaceId), eq(steps.repositoryId, scope.repositoryId))
    : and(eq(steps.workspaceId, scope.workspaceId), isNull(steps.repositoryId));
  const existing = await db().select(STEP_COLUMNS).from(steps).where(where).orderBy(asc(steps.position), asc(steps.id));
  const byId = new Map(existing.map((row) => [row.id, row]));
  const seen = new Set<string>();
  type Plan = { kind: 'update'; row: StepRow; set: Partial<typeof steps.$inferInsert> } | { kind: 'insert'; values: typeof steps.$inferInsert };
  const plans: Plan[] = [];
  let userCount = 0;
  checked.forEach((input, index) => {
    const field = `Step ${index + 1}`;
    if (input.id !== undefined) {
      const row = byId.get(input.id);
      if (!row) throw new SetupListError(`${field} is not a step of this list.`, 'unknown_step');
      if (seen.has(row.id)) throw new SetupListError(`${field} is in the list twice.`, 'duplicate_step');
      seen.add(row.id);
      const set: Partial<typeof steps.$inferInsert> = { position: index, name: input.name, timeoutSec: input.timeoutSec, updatedAt: now };
      let runOn = input.runOn;
      if (row.origin === 'user') {
        userCount += 1;
        const command = input.command ?? row.command;
        if (command !== row.command) {
          const check = userSetupStepCheck(command);
          if (check.refusal) throw new SetupListError(`${field}: ${check.refusal}`, 'setup_step_refused');
          set.command = command;
        }
        // A step that reads a secret never goes into an image.
        if (runOn !== 'box' && userSetupStepCheck(command).forceBox && (command !== row.command || runOn !== row.runOn)) runOn = 'box';
      } else if (input.command !== undefined && input.command !== row.command) {
        throw new SetupListError(`${field} is a learned step. Its command cannot change; add your own step instead.`, 'learned_command');
      }
      set.runOn = runOn;
      if (runOn !== row.runOn) {
        if (runOn !== 'box' && !row.imageAppliedAt && (row.origin === 'user' || row.acceptedBy === 'person')) set.imageAppliedAt = now;
        // A new place is a new try in the image.
        if (runOn !== 'box') { set.imageFailedAt = null; set.imageFailureReason = null; }
      }
      plans.push({ kind: 'update', row, set });
      return;
    }
    userCount += 1;
    if (typeof input.command !== 'string') throw new SetupListError(`${field} needs a command.`, 'invalid_step');
    const check = userSetupStepCheck(input.command);
    if (check.refusal) throw new SetupListError(`${field}: ${check.refusal}`, 'setup_step_refused');
    const runOn = check.forceBox ? 'box' : input.runOn;
    plans.push({
      kind: 'insert',
      values: {
        id: newStepId(),
        workspaceId: scope.workspaceId,
        repositoryId: scope.repositoryId,
        position: index,
        stepKey: '',
        name: input.name,
        command: input.command,
        kind: 'other',
        runOn,
        origin: 'user',
        status: 'active',
        acceptedBy: 'person',
        timeoutSec: input.timeoutSec,
        seenCount: 0,
        confirmedAt: now,
        imageAppliedAt: runOn === 'box' ? null : now,
        statusChangedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
  });
  if (userCount > SETUP_LIST_MAX_USER_STEPS) {
    throw new SetupListError(`A list can have at most ${SETUP_LIST_MAX_USER_STEPS} of your own steps.`, 'too_many_steps');
  }
  const unlisted = existing.filter((row) => !seen.has(row.id));
  for (const plan of plans) {
    if (plan.kind === 'insert') await db().insert(steps).values(plan.values);
    else await db().update(steps).set(plan.set).where(eq(steps.id, plan.row.id));
  }
  // A person's step that is not in the list is deleted. A learned step keeps its row, after the list.
  const removed = unlisted.filter((row) => row.origin === 'user').map((row) => row.id);
  if (removed.length) await db().delete(steps).where(and(where, inArray(steps.id, removed)));
  let position = checked.length;
  for (const row of unlisted.filter(learned)) {
    if (row.position !== position) await db().update(steps).set({ position }).where(eq(steps.id, row.id));
    position += 1;
  }
}

/** `PUT /repositories/:id/setup`. Null: no such repository. */
export async function putRepositorySetup(repositoryId: string, input: PutRepositorySetupInput, now = new Date()): Promise<RepositorySetup | null> {
  const settings = await repositorySetupSettings(repositoryId);
  if (!settings.exists || !settings.workspaceId) return null;
  if (!input || typeof input !== 'object') throw new SetupListError('The body must be an object.', 'invalid_body');
  if (input.runOnBox !== undefined && !RUN_ON_BOX.has(input.runOnBox)) {
    throw new SetupListError('runOnBox must be always, moved or never.', 'invalid_run_on_box');
  }
  if (input.learningDisabled !== undefined && typeof input.learningDisabled !== 'boolean') {
    throw new SetupListError('learningDisabled must be true or false.', 'invalid_body');
  }
  const hosts = input.hosts !== undefined ? validateSetupHosts(input.hosts) : undefined;
  if (input.steps !== undefined) await writeList({ workspaceId: settings.workspaceId, repositoryId }, input.steps, now);
  const patch: Record<string, unknown> = { setupListEdited: true };
  if (hosts !== undefined) patch.setupHosts = hosts;
  if (input.runOnBox !== undefined) patch.repoSetup = { ...settings.repoSetup, runOnBox: input.runOnBox };
  await mergeRepositorySettings(repositoryId, patch);
  if (input.learningDisabled !== undefined && input.learningDisabled !== settings.disabled) {
    await setSetupLearning(repositoryId, input.learningDisabled);
  }
  debugBus.recordEvent({
    service: 'setup_recipe',
    action: 'list_saved',
    summary: 'A person saved the Setup list of a repository.',
    workspaceId: settings.workspaceId,
    meta: { repositoryId },
  });
  return getRepositorySetup(repositoryId, now);
}

function validateDotfiles(value: unknown): SandboxDotfiles | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SetupListError('dotfiles must be an object or null.', 'invalid_dotfiles');
  const raw = value as Partial<SandboxDotfiles>;
  if (typeof raw.slug !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.slug.trim())) {
    throw new SetupListError('The dotfiles repository must be owner/name.', 'invalid_dotfiles');
  }
  const rawRef = raw.ref === undefined || raw.ref === null ? '' : raw.ref;
  const ref = typeof rawRef === 'string' ? rawRef.trim() : rawRef;
  if (typeof ref !== 'string' || bytes(ref) > 255 || /[\s\0~^:?*[\\]/.test(ref) || ref.startsWith('-')) {
    throw new SetupListError('The dotfiles branch is not a valid branch, tag or commit.', 'invalid_dotfiles');
  }
  const install = raw.install === undefined || raw.install === null || !String(raw.install).trim() ? null : raw.install;
  if (install !== null) {
    if (typeof install !== 'string') throw new SetupListError('The dotfiles install command must be text.', 'invalid_dotfiles');
    const check = userSetupStepCheck(install);
    if (check.refusal) throw new SetupListError(`The dotfiles install command: ${check.refusal}`, 'setup_step_refused');
    if (check.forceBox) throw new SetupListError('The dotfiles install command reads a secret. The image build has no secrets.', 'setup_step_refused');
  }
  return { slug: raw.slug.trim(), ref, install: install === null ? null : install.trim() };
}

/** `PUT /workspaces/:id/sandbox-setup`. Null: no such workspace. */
export async function putWorkspaceSandboxSetup(
  workspaceId: string,
  input: PutWorkspaceSandboxSetupInput,
  now = new Date(),
): Promise<WorkspaceSandboxSetup | null> {
  const current = await workspaceSetupSettings(workspaceId);
  if (!current.exists) return null;
  if (!input || typeof input !== 'object') throw new SetupListError('The body must be an object.', 'invalid_body');
  const dotfiles = input.dotfiles !== undefined ? validateDotfiles(input.dotfiles) : current.dotfiles;
  const hosts = input.hosts !== undefined ? validateSetupHosts(input.hosts) : current.hosts;
  if (input.steps !== undefined) await writeList({ workspaceId, repositoryId: null }, input.steps, now);
  const patch = JSON.stringify({ sandboxSetup: { dotfiles, hosts, changedAt: now.toISOString() } });
  await db().update(workspaces).set({
    settings: sql`coalesce(${workspaces.settings}, '{}'::jsonb) || ${patch}::jsonb`,
  }).where(eq(workspaces.id, workspaceId));
  debugBus.recordEvent({
    service: 'setup_recipe',
    action: 'sandbox_setup_saved',
    summary: 'A person saved the sandbox setup of a workspace.',
    workspaceId,
    meta: { workspaceId },
  });
  return getWorkspaceSandboxSetup(workspaceId);
}

/** A step of the repository, by id. */
async function repositoryStep(repositoryId: string, stepId: string): Promise<StepRow | null> {
  const [row] = await db().select(STEP_COLUMNS).from(steps)
    .where(and(eq(steps.repositoryId, repositoryId), eq(steps.id, stepId))).limit(1);
  return row ?? null;
}

/**
 * Accept a suggested or dismissed learned step: it runs on new boxes and goes
 * into the image at once. A person's acceptance is never undone by Talyn.
 */
export async function acceptSetupStep(repositoryId: string, stepId: string, now = new Date()): Promise<SetupListStep | null> {
  const row = await repositoryStep(repositoryId, stepId);
  if (!row) return null;
  if (row.status === 'active' || row.status === 'disabled') {
    if (row.status === 'active' && row.acceptedBy !== 'person') {
      const [updated] = await db().update(steps).set({ acceptedBy: 'person', updatedAt: now })
        .where(eq(steps.id, row.id)).returning(STEP_COLUMNS);
      return rowToListStep(updated ?? row);
    }
    return rowToListStep(row);
  }
  const [updated] = await db()
    .update(steps)
    .set({
      status: 'active',
      acceptedBy: 'person',
      confirmedAt: sql`coalesce(${steps.confirmedAt}, now())`,
      imageAppliedAt: row.runOn === 'box' ? null : now,
      statusReason: null,
      statusChangedAt: now,
      updatedAt: now,
    })
    .where(and(eq(steps.id, row.id), inArray(steps.status, ['suggested', 'dismissed'])))
    .returning(STEP_COLUMNS);
  debugBus.recordEvent({
    service: 'setup_recipe',
    action: 'step_accepted',
    summary: `A person accepted setup step ${row.id}.`,
    meta: { repositoryId, stepId: row.id },
  });
  return rowToListStep(updated ?? row);
}

/** Dismiss a learned step. It stays in the list as dismissed, so it is not suggested again. */
export async function dismissSetupStep(repositoryId: string, stepId: string, now = new Date()): Promise<SetupListStep | null> {
  const row = await repositoryStep(repositoryId, stepId);
  if (!row) return null;
  if (row.origin === 'user') {
    throw new SetupListError('This is your own step. Remove it from the list instead.', 'not_learned', 409);
  }
  const [updated] = await db()
    .update(steps)
    .set({
      status: 'dismissed',
      acceptedBy: null,
      imageAppliedAt: null,
      statusReason: sql`CASE WHEN ${steps.status} = 'dismissed' THEN ${steps.statusReason} ELSE 'Dismissed by a person.' END`,
      statusChangedAt: sql`CASE WHEN ${steps.status} = 'dismissed' THEN ${steps.statusChangedAt} ELSE ${now.toISOString()}::timestamptz END`,
      updatedAt: now,
    })
    .where(eq(steps.id, row.id))
    .returning(STEP_COLUMNS);
  debugBus.recordEvent({
    service: 'setup_recipe',
    action: 'step_reverted',
    summary: `Setup step ${stepId} was dismissed.`,
    meta: { repositoryId, stepId },
  });
  return rowToListStep(updated ?? row);
}

/** Retry a disabled step, or a step that failed in the image: it runs again, with a clean count. */
export async function retrySetupStep(
  scope: { repositoryId: string } | { workspaceId: string },
  stepId: string,
  now = new Date(),
): Promise<SetupListStep | null> {
  const where = 'repositoryId' in scope
    ? and(eq(steps.repositoryId, scope.repositoryId), eq(steps.id, stepId))
    : and(eq(steps.workspaceId, scope.workspaceId), isNull(steps.repositoryId), eq(steps.id, stepId));
  const [row] = await db().select(STEP_COLUMNS).from(steps).where(where).limit(1);
  if (!row) return null;
  if (row.status !== 'disabled' && !row.imageFailedAt) return rowToListStep(row);
  const [updated] = await db()
    .update(steps)
    .set({
      status: row.status === 'disabled' ? 'active' : row.status,
      boxFailureCount: 0,
      imageFailedAt: null,
      imageFailureReason: null,
      ...(row.status === 'disabled' ? { statusReason: null, statusChangedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(steps.id, row.id))
    .returning(STEP_COLUMNS);
  debugBus.recordEvent({
    service: 'setup_recipe',
    action: 'step_retried',
    summary: `A person retried setup step ${row.id}.`,
    meta: { stepId: row.id, repositoryId: row.repositoryId },
  });
  return rowToListStep(updated ?? row);
}

// ============================================================================
// Learning
// ============================================================================

export interface RecordStepsResult {
  /** New steps. */
  added: SetupListStep[];
  /** Steps already in the list, counted again. */
  seen: SetupListStep[];
  /** Candidates left out because the list has enough learned steps. */
  full: number;
}

/**
 * Count one more sighting of a stored step. A session counts once: the
 * (step, session) row is the proof. Null: no such step.
 */
async function countSighting(repositoryId: string, key: string, workbenchId: string | null): Promise<string | null> {
  const [row] = await db()
    .update(steps)
    .set({ seenCount: sql`${steps.seenCount} + 1`, lastSeenAt: new Date() })
    .where(and(eq(steps.repositoryId, repositoryId), eq(steps.stepKey, key)))
    .returning({ id: steps.id });
  if (!row) return null;
  if (workbenchId) await countSession(row.id, workbenchId);
  return row.id;
}

/** One (step, session) row. A session that had already counted changes nothing. */
async function countSession(stepId: string, workbenchId: string): Promise<boolean> {
  const [fresh] = await db()
    .insert(stepSessions)
    .values({ stepId, workbenchId })
    .onConflictDoNothing()
    .returning({ stepId: stepSessions.stepId });
  if (!fresh) return false;
  await db().update(steps).set({ sessionCount: sql`${steps.sessionCount} + 1` }).where(eq(steps.id, stepId));
  return true;
}

/** Installs first, then services, then what needs the services: `orderSetupSteps` in shared. */
const KIND_ORDER: SetupStepKind[] = [
  'installer', 'rustup', 'apt', 'brew', 'cargo', 'go', 'gem', 'pip', 'uv', 'node', 'download',
  'env', 'docker', 'service', 'compose', 'database', 'other',
];
const kindIndex = (kind: string) => {
  const i = KIND_ORDER.indexOf(kind as SetupStepKind);
  return i < 0 ? KIND_ORDER.length : i;
};

/**
 * The place of a new learned step: after the learned steps of its kind and
 * the kinds before it, so installs stay before what starts a service, as the
 * box ran them before the list. The steps after it move down one place.
 */
async function insertPosition(repositoryId: string, kind: SetupStepKind): Promise<number> {
  const rows = await db().select({ position: steps.position, kind: steps.kind, origin: steps.origin })
    .from(steps).where(eq(steps.repositoryId, repositoryId));
  if (rows.length === 0) return 0;
  const mine = rows.filter((r) => r.origin !== 'user');
  const before = mine.filter((r) => kindIndex(r.kind) <= kindIndex(kind));
  const position = before.length > 0
    ? Math.max(...before.map((r) => r.position)) + 1
    : mine.length > 0 ? Math.min(...mine.map((r) => r.position)) : Math.max(...rows.map((r) => r.position)) + 1;
  await db().update(steps).set({ position: sql`${steps.position} + 1` })
    .where(and(eq(steps.repositoryId, repositoryId), gte(steps.position, position)));
  return position;
}

/**
 * Add candidates to the list, in order. A step that is already there is
 * counted again; a dismissed step stays dismissed. A new step is `suggested`
 * until enough recent sessions need it ({@link reconcileSetupSteps}) or a
 * person accepts it, and is refused once the list has
 * {@link SETUP_RECIPE_MAX_STEPS} learned steps that are active or were seen in
 * the window. Two sessions that add at once can pass the cap by a step or
 * two; the cap bounds growth, it is not a quota.
 */
export async function recordSetupSteps(input: {
  repositoryId: string;
  workspaceId?: string;
  workbenchId: string | null;
  source: SetupStepSource;
  candidates: SetupStepCandidate[];
}): Promise<RecordStepsResult> {
  const out: RecordStepsResult = { added: [], seen: [], full: 0 };
  const addedIds: string[] = [];
  const seenIds: string[] = [];
  const windowStart = new Date(Date.now() - WINDOW_MS);
  let workspaceId = input.workspaceId;
  for (const candidate of input.candidates) {
    const key = stepKey(candidate.kind, candidate.command);
    const existing = await countSighting(input.repositoryId, key, input.workbenchId);
    if (existing) {
      seenIds.push(existing);
      continue;
    }
    const [{ live }] = await db()
      .select({ live: count() })
      .from(steps)
      .where(and(
        eq(steps.repositoryId, input.repositoryId),
        ne(steps.origin, 'user'),
        or(eq(steps.status, 'active'), and(eq(steps.status, 'suggested'), gte(steps.lastSeenAt, windowStart))),
      ));
    if (Number(live) >= SETUP_RECIPE_MAX_STEPS) {
      out.full += 1;
      continue;
    }
    if (!workspaceId) {
      const [repo] = await db().select({ workspaceId: repositories.workspaceId }).from(repositories)
        .where(eq(repositories.id, input.repositoryId)).limit(1);
      if (!repo) return out;
      workspaceId = repo.workspaceId;
    }
    const now = new Date();
    const [inserted] = await db()
      .insert(steps)
      .values({
        id: newStepId(),
        workspaceId,
        repositoryId: input.repositoryId,
        position: await insertPosition(input.repositoryId, candidate.kind),
        stepKey: key,
        name: setupStepName(candidate.command),
        command: candidate.command,
        kind: candidate.kind,
        runOn: defaultRunOn(candidate.kind, candidate.phase),
        origin: input.source,
        status: 'suggested',
        why: candidate.why,
        sourceWorkbenchId: input.workbenchId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning(STEP_COLUMNS);
    if (!inserted) {
      // Another session added the same step at the same moment. Count this one on its row.
      const raced = await countSighting(input.repositoryId, key, input.workbenchId);
      if (raced) seenIds.push(raced);
      continue;
    }
    if (input.workbenchId) await countSession(inserted.id, input.workbenchId);
    addedIds.push(inserted.id);
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'step_added',
      summary: `Setup step ${inserted.id} (${inserted.kind}) ${input.source === 'agent' ? 'recorded by an agent' : 'learned'} from session ${input.workbenchId ?? 'unknown'}: ${redactSecrets(inserted.command).slice(0, 200)}. It is suggested until enough recent sessions need it.`,
      workspaceId,
      meta: { repositoryId: input.repositoryId, stepId: inserted.id, workbenchId: input.workbenchId, kind: inserted.kind },
    });
  }
  if (addedIds.length > 0 || seenIds.length > 0) {
    const byId = new Map((await reconcileSetupSteps(input.repositoryId, { workspaceId })).map((s) => [s.id, s]));
    for (const id of addedIds) if (byId.has(id)) out.added.push(byId.get(id)!);
    for (const id of seenIds) if (byId.has(id)) out.seen.push(byId.get(id)!);
  }
  if (out.full > 0) {
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'recipe_full',
      summary: `The Setup list has ${SETUP_RECIPE_MAX_STEPS} learned steps, so ${out.full} new step(s) were not added.`,
      ok: false,
      workspaceId,
      meta: { repositoryId: input.repositoryId, workbenchId: input.workbenchId },
    });
  }
  return out;
}

/** The step was used in the box this turn: `recordStepUses`. */
const runnableRepo = (repositoryId: string) => and(eq(steps.repositoryId, repositoryId), eq(steps.status, 'active'));

/**
 * Count the sessions that used an active learned step without running it: the
 * box had already run the step, so the agent used what it installs. See
 * `setupStepUses`. Each use is one (step, session) row, like a sighting.
 *
 * The first call for a repository also marks when Talyn began to count uses
 * (`settings.setupUsageSince`). Only {@link SETUP_STEP_WINDOW_DAYS} days after
 * that can an active step leave ({@link reconcileSetupSteps}).
 */
export async function recordStepUses(input: {
  repositoryId: string;
  workbenchId: string;
  calls: TurnToolCall[];
  now?: Date;
}): Promise<string[]> {
  const since = (input.now ?? new Date()).toISOString();
  await db().update(repositories).set({
    settings: sql`coalesce(${repositories.settings}, '{}'::jsonb) || jsonb_build_object('setupUsageSince', ${since}::text)`,
  }).where(and(eq(repositories.id, input.repositoryId), sql`(${repositories.settings} ->> 'setupUsageSince') IS NULL`));
  const words = turnCommandWords(input.calls);
  if (words.size === 0) return [];
  const live = await db()
    .select({ id: steps.id, command: steps.command, kind: steps.kind, runOn: steps.runOn })
    .from(steps)
    .where(and(runnableRepo(input.repositoryId), ne(steps.origin, 'user')));
  const used: string[] = [];
  for (const row of live) {
    const step = { kind: row.kind as SetupStepKind, command: row.command, phase: phaseOfRunOn(row.runOn as SetupStepRunOn) };
    if (!setupStepUsed(step, words)) continue;
    if (await countSession(row.id, input.workbenchId)) used.push(row.id);
  }
  return used;
}

// ============================================================================
// The box
// ============================================================================

const BOX_COLUMNS = {
  id: steps.id,
  repositoryId: steps.repositoryId,
  command: steps.command,
  kind: steps.kind,
  runOn: steps.runOn,
  origin: steps.origin,
  timeoutSec: steps.timeoutSec,
  sourceWorkbenchId: steps.sourceWorkbenchId,
} as const;
type BoxRow = Pick<typeof steps.$inferSelect, keyof typeof BOX_COLUMNS>;

const toBoxCandidate = (row: BoxRow): BoxCandidate => ({
  id: row.id,
  command: row.command,
  kind: row.kind as SetupStepKind,
  phase: phaseOfRunOn(row.runOn as SetupStepRunOn),
  sourceWorkbenchId: row.origin === 'user' ? 'you' : row.sourceWorkbenchId,
  runOn: row.runOn as SetupStepRunOn,
  origin: row.origin as SetupStepOrigin,
  ...(row.timeoutSec ? { timeoutSec: row.timeoutSec } : {}),
});

/** The active steps of a box, the workspace's first, each list in its order. */
export function boxStepsQuery(workspaceId: string, repositoryId: string, includeLearned: boolean) {
  return db()
    .select(BOX_COLUMNS)
    .from(steps)
    .where(and(
      eq(steps.workspaceId, workspaceId),
      or(eq(steps.repositoryId, repositoryId), isNull(steps.repositoryId)),
      eq(steps.status, 'active'),
      ...(includeLearned ? [] : [eq(steps.origin, 'user')]),
    ))
    .orderBy(sql`${steps.repositoryId} IS NOT NULL`, asc(steps.position), asc(steps.createdAt), asc(steps.id));
}

/**
 * The steps a new box may run, before the image is known: every active step,
 * the workspace's first. The verdict is applied first, so a step whose share
 * fell does not run. Learning off: only the person's steps. The old Docker
 * start ({@link LEGACY_DOCKER_START_COMMAND}) is skipped, and two learned
 * steps with one identity run once.
 */
export async function setupStepsForBox(repositoryId: string, now = new Date()): Promise<BoxCandidate[]> {
  const settings = await repositorySetupSettings(repositoryId);
  if (!settings.workspaceId) return [];
  if (!settings.disabled) await reconcileSetupSteps(repositoryId, { now, settings });
  const rows = await boxStepsQuery(settings.workspaceId, repositoryId, !settings.disabled);
  const identities = new Set<string>();
  return rows.map(toBoxCandidate).filter((step) => {
    if (step.origin === 'user') return true;
    if (step.command === LEGACY_DOCKER_START_COMMAND) return false;
    const identity = `${step.kind}\0${setupStepIdentity(step.kind, step.command)}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}

/**
 * The repository config with the Setup list composed in ({@link boxSetupScript}).
 * `ctx` is what the box knows about its image (`BOX_LAYER_FILE`); null is the
 * old rule. A session whose own settings remove the setup gets none. A failure
 * to read the list leaves the config as it was: setup must never stop a box
 * from starting.
 */
export async function withBoxSetup(
  row: { repositoryId: string | null; kind?: string | null; settings?: WorkbenchSettings | null; workspaceId?: string },
  config: WorkbenchConfig,
  ctx: BoxLayerContext | null = null,
): Promise<WorkbenchConfig> {
  if (!row.repositoryId || row.kind === 'thread' || row.settings?.scripts?.setup === null) return config;
  try {
    const settings = await repositorySetupSettings(row.repositoryId);
    const [boxSteps, workspace] = await Promise.all([
      setupStepsForBox(row.repositoryId),
      settings.workspaceId ? workspaceSetupSettings(settings.workspaceId) : Promise.resolve(null),
    ]);
    return boxSetupScript(config, {
      steps: boxSteps,
      runRepoSetup: repoSetupRunsOnBox(settings.repoSetup.runOnBox, ctx),
      dotfiles: workspace?.dotfiles ?? null,
      ctx,
    });
  } catch (error) {
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'read_failed',
      summary: 'Could not read the Setup list. The box runs the repository setup only.',
      ok: false,
      error,
      workspaceId: row.workspaceId,
      meta: { repositoryId: row.repositoryId },
    });
    return config;
  }
}

/**
 * Keep what the newest box read of the repository's own setup, for row 0 of
 * the list. One statement that writes only when the command or its source
 * changed, so a box start costs no write when nothing moved.
 */
export async function noteRepoSetupRead(repositoryId: string, config: Pick<WorkbenchConfig, 'setup' | 'source'>, now = new Date()): Promise<void> {
  const command = config.setup?.command?.trim() || null;
  const source: RepoSetupSource = config.source;
  await db().update(repositories).set({
    settings: sql`coalesce(${repositories.settings}, '{}'::jsonb) || jsonb_build_object('repoSetup',
      coalesce(${repositories.settings} -> 'repoSetup', '{}'::jsonb) || jsonb_build_object(
        'command', ${command}::text, 'source', ${source}::text, 'readAt', ${now.toISOString()}::text))`,
  }).where(and(
    eq(repositories.id, repositoryId),
    sql`((${repositories.settings} -> 'repoSetup' ->> 'command') IS DISTINCT FROM ${command}::text
      OR (${repositories.settings} -> 'repoSetup' ->> 'source') IS DISTINCT FROM ${source}::text)`,
  ));
}

// ============================================================================
// The image
// ============================================================================

/**
 * Put Talyn-accepted image steps into the image when the list has settled: no
 * newly accepted step for {@link SETUP_RECIPE_SETTLE_MS}. A change of the image
 * spec makes the fleet build the user layer again, so a burst of sessions that
 * each learn something gives one build, not one per session.
 */
export async function promoteSettledSteps(repositoryId: string, now = new Date()): Promise<string[]> {
  const pending = and(runnableRepo(repositoryId), ne(steps.runOn, 'box'), isNull(steps.imageAppliedAt));
  const [{ newest }] = await db().select({ newest: max(steps.confirmedAt) }).from(steps).where(pending);
  if (!newest) return [];
  const newestAt = newest instanceof Date ? newest : new Date(newest as unknown as string);
  if (now.getTime() - newestAt.getTime() < SETUP_RECIPE_SETTLE_MS) return [];
  const rows = await db()
    .update(steps)
    .set({ imageAppliedAt: now })
    .where(and(pending, lte(steps.confirmedAt, newestAt)))
    .returning({ id: steps.id, sourceWorkbenchId: steps.sourceWorkbenchId, kind: steps.kind });
  for (const row of rows) {
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'step_applied',
      summary: `Setup step ${row.id} from session ${row.sourceWorkbenchId ?? 'unknown'} now goes into the image.`,
      meta: { repositoryId, stepId: row.id, workbenchId: row.sourceWorkbenchId, kind: row.kind },
    });
  }
  return rows.map((r) => r.id);
}

const IMAGE_COLUMNS = {
  id: steps.id,
  repositoryId: steps.repositoryId,
  name: steps.name,
  command: steps.command,
  kind: steps.kind,
  runOn: steps.runOn,
  origin: steps.origin,
  timeoutSec: steps.timeoutSec,
  sourceWorkbenchId: steps.sourceWorkbenchId,
} as const;

/** The steps that may go into the user layer: active, in the image, not failed there. */
export function imageStepsQuery(workspaceId: string, repositoryId: string, includeLearned: boolean) {
  return db()
    .select(IMAGE_COLUMNS)
    .from(steps)
    .where(and(
      eq(steps.workspaceId, workspaceId),
      or(eq(steps.repositoryId, repositoryId), isNull(steps.repositoryId)),
      eq(steps.status, 'active'),
      ne(steps.runOn, 'box'),
      isNotNull(steps.imageAppliedAt),
      isNull(steps.imageFailedAt),
      ...(includeLearned ? [] : [eq(steps.origin, 'user')]),
    ))
    .orderBy(sql`${steps.repositoryId} IS NOT NULL`, asc(steps.position), asc(steps.createdAt), asc(steps.id));
}

export interface ImageSetupForCreate {
  layers: CreateSandboxLayers;
  /** The legacy `bake` field, for a host that does not take `layers`. */
  bake: RepositoryBake | null;
  /** The person's steps in the legacy bake. On an old host a box never runs them. */
  legacyUserStepIds: string[];
  /** Ids in the user layer spec. */
  specStepIds: string[];
}

/**
 * What a box of this repository is created with: the `layers` field (plan
 * §10.5) and the legacy `bake` field beside it, until every host takes
 * `layers` (an old host ignores unknown fields).
 */
export async function imageSetupForCreate(input: {
  workspaceId: string;
  repositoryId: string;
  slug: string;
  baseBranch: string;
  now?: Date;
}): Promise<ImageSetupForCreate> {
  const now = input.now ?? new Date();
  const settings = await repositorySetupSettings(input.repositoryId);
  const workspace = await workspaceSetupSettings(input.workspaceId);
  if (!settings.disabled) {
    await reconcileSetupSteps(input.repositoryId, { now, settings, workspaceId: input.workspaceId });
    await promoteSettledSteps(input.repositoryId, now);
  }
  const rows = await imageStepsQuery(input.workspaceId, input.repositoryId, !settings.disabled);
  const candidate = (row: (typeof rows)[number]): LayerCandidate => ({
    id: row.id,
    name: row.name,
    command: row.command,
    kind: row.kind as SetupStepKind,
    origin: row.origin as SetupStepOrigin,
    timeoutSec: row.timeoutSec,
  });
  const wide = rows.filter((r) => r.repositoryId === null).map(candidate);
  const repo = rows.filter((r) => r.repositoryId !== null).map(candidate);
  const built = buildUserLayerSpec({ dotfiles: workspace.dotfiles, wide, repo, hosts: [...workspace.hosts, ...settings.hosts] });
  const legacyLearned: AppliedSetupStep[] = rows
    .filter((r) => r.repositoryId !== null && r.origin !== 'user')
    .map((r) => ({ id: r.id, command: r.command, kind: r.kind as SetupStepKind, phase: 'install', sourceWorkbenchId: r.sourceWorkbenchId }));
  const legacy = legacyBakeFor({
    user: repo.filter((s) => s.origin === 'user'),
    learned: legacyLearned,
    hosts: settings.hosts,
    explicit: settings.explicitBake,
  });
  return {
    layers: { repo: { slug: input.slug, baseBranch: input.baseBranch }, user: built.spec },
    bake: legacy.bake,
    legacyUserStepIds: legacy.userStepIds,
    specStepIds: built.includedIds,
  };
}

/** The user layer spec for a box of this repository (plan §10.5). Null: nothing to build. */
export async function userLayerSpecFor(workspaceId: string, repositoryId: string): Promise<UserLayerSpec | null> {
  const [repo] = await db().select({ name: repositories.name, defaultBranch: repositories.defaultBranch })
    .from(repositories).where(and(eq(repositories.id, repositoryId), eq(repositories.workspaceId, workspaceId))).limit(1);
  if (!repo) return null;
  return (await imageSetupForCreate({ workspaceId, repositoryId, slug: repo.name, baseBranch: repo.defaultBranch })).layers.user;
}

/** Keep what the newest create said about the images, for the list's footer. */
export async function noteImageStatus(repositoryId: string, status: SetupImageStatus): Promise<void> {
  await mergeRepositorySettings(repositoryId, { setupImage: status });
}

/** Whether any step is in the image, so an image result is worth reading. */
export async function hasImageSteps(repositoryId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: steps.id })
    .from(steps)
    .where(and(runnableRepo(repositoryId), ne(steps.runOn, 'box'), isNotNull(steps.imageAppliedAt), isNull(steps.imageFailedAt)))
    .limit(1);
  return Boolean(row);
}

/**
 * Read an image build's step results. A step that failed there leaves the
 * image, with the reason; the box runs it instead. A result names its step by
 * `id` (a user layer) or by the legacy `talyn-learned <id>` name (a bake).
 */
export async function noteImageResults(
  repositoryId: string,
  results: Array<LayerStepResult | BakeStepResult>,
  workspaceId?: string,
): Promise<string[]> {
  const disabled: string[] = [];
  const [repo] = await db().select({ workspaceId: repositories.workspaceId }).from(repositories)
    .where(eq(repositories.id, repositoryId)).limit(1);
  if (!repo) return disabled;
  for (const result of results) {
    const id = ('id' in result && typeof result.id === 'string' && result.id) || learnedBakeStepId(result.name);
    if (!id || result.ok) continue;
    const tail = redactSecrets(result.logTail ?? '').trim().slice(-400);
    const reason = `The step failed in the image build with exit ${result.exitCode}.${tail ? ` Last output: ${tail}` : ''}`;
    const [row] = await db()
      .update(steps)
      .set({ imageFailedAt: new Date(), imageFailureReason: reason })
      .where(and(
        eq(steps.workspaceId, repo.workspaceId),
        or(eq(steps.repositoryId, repositoryId), isNull(steps.repositoryId)),
        eq(steps.id, id),
        isNull(steps.imageFailedAt),
      ))
      .returning({ id: steps.id });
    if (!row) continue;
    disabled.push(row.id);
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'step_bake_failed',
      summary: `Setup step ${id} failed in the image build (exit ${result.exitCode}) and was taken out of it. The box runs it.`,
      ok: false,
      workspaceId: workspaceId ?? repo.workspaceId,
      meta: { repositoryId, stepId: id },
    });
  }
  return disabled;
}

// ============================================================================
// Box results and timing
// ============================================================================

/** The failure as one line: `exit 100: E: Unable to locate package x`, or the time limit. */
function boxFailureText(result: LearnedStepResult, kind: SetupStepKind | undefined, timeoutSec: number | null): string {
  const head = result.timedOut
    ? `timed out after ${timeoutSec ?? SETUP_STEP_TIMEOUT_SEC[kind ?? 'other'] ?? SETUP_STEP_TIMEOUT_SEC.other} seconds`
    : `exit ${result.exitCode}`;
  const line = redactSecrets(result.lastLine).trim().slice(0, 300);
  return line ? `${head}: ${line}` : head;
}

/**
 * Read the step results of one box setup. A success sets the step's failure
 * count to 0. A failure adds one, and the {@link SETUP_STEP_MAX_BOX_FAILURES}th
 * failure in a row disables the step, with the reason. Only steps of this
 * repository and its workspace change, so a result line that names another
 * step does nothing.
 */
export async function noteBoxSetupResults(
  repositoryId: string,
  results: LearnedStepResult[],
  context: { workspaceId?: string; workbenchId?: string } = {},
): Promise<{ failed: string[]; disabled: string[] }> {
  const out = { failed: [] as string[], disabled: [] as string[] };
  const [repo] = await db().select({ workspaceId: repositories.workspaceId }).from(repositories)
    .where(eq(repositories.id, repositoryId)).limit(1);
  if (!repo) return out;
  const scope = and(eq(steps.workspaceId, repo.workspaceId), or(eq(steps.repositoryId, repositoryId), isNull(steps.repositoryId)));
  for (const result of results) {
    const mine = and(scope, eq(steps.id, result.id), eq(steps.status, 'active'));
    if (result.durationMs !== undefined) await noteDuration(scope!, result.id, result.durationMs);
    if (result.exitCode === 0) {
      await db().update(steps).set({ boxFailureCount: 0 }).where(and(mine, gt(steps.boxFailureCount, 0)));
      continue;
    }
    const [kindRow] = await db().select({ kind: steps.kind, timeoutSec: steps.timeoutSec }).from(steps).where(mine).limit(1);
    if (!kindRow) continue;
    const failure = boxFailureText(result, kindRow.kind as SetupStepKind, kindRow.timeoutSec);
    const reason = `Failed on ${SETUP_STEP_MAX_BOX_FAILURES} boxes in a row. Last: ${failure}`;
    const limitReached = sql`${steps.boxFailureCount} + 1 >= ${SETUP_STEP_MAX_BOX_FAILURES}`;
    const [row] = await db()
      .update(steps)
      .set({
        boxFailureCount: sql`${steps.boxFailureCount} + 1`,
        boxLastFailure: failure,
        status: sql`CASE WHEN ${limitReached} THEN 'disabled' ELSE ${steps.status} END`,
        statusReason: sql`CASE WHEN ${limitReached} THEN ${reason}::text ELSE ${steps.statusReason} END`,
        statusChangedAt: sql`CASE WHEN ${limitReached} THEN now() ELSE ${steps.statusChangedAt} END`,
      })
      .where(mine)
      .returning({ id: steps.id, boxFailureCount: steps.boxFailureCount, status: steps.status });
    if (!row) continue;
    out.failed.push(row.id);
    const disabledNow = row.status === 'disabled';
    if (disabledNow) out.disabled.push(row.id);
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: disabledNow ? 'step_box_disabled' : 'step_box_failed',
      summary: disabledNow
        ? `Setup step ${row.id} failed on ${row.boxFailureCount} boxes in a row and no longer runs: ${failure}`
        : `Setup step ${row.id} failed in the box setup (${row.boxFailureCount} in a row): ${failure}`,
      ok: false,
      workspaceId: context.workspaceId,
      meta: { repositoryId, stepId: row.id, workbenchId: context.workbenchId },
    });
  }
  return out;
}

/**
 * One measurement of a step's time. The typical time is read and written in
 * one statement, so two boxes that report at once do not lose a measurement.
 * The SQL is `nextTypicalDurationMs` in shared: a test pins the two together.
 */
async function noteDuration(scope: SQL, stepId: string, durationMs: number): Promise<void> {
  const ms = Math.max(0, Math.min(Math.round(durationMs), 2_000_000_000));
  await db()
    .update(steps)
    .set({
      lastDurationMs: ms,
      typicalDurationMs: sql`CASE WHEN ${steps.typicalDurationMs} IS NULL THEN ${ms}::int
        ELSE round(${steps.typicalDurationMs} * (1 - ${SETUP_STEP_TYPICAL_WEIGHT}::float8) + ${ms}::int * ${SETUP_STEP_TYPICAL_WEIGHT}::float8)::int END`,
      measuredBoxes: sql`${steps.measuredBoxes} + 1`,
    })
    .where(and(scope, eq(steps.id, stepId)));
}

/**
 * Keep the times of a box setup on the repository: the newest record, and the
 * newest {@link SETUP_TIMING_HISTORY} in a list, one statement.
 */
async function noteSetupTiming(repositoryId: string, timing: SetupTiming): Promise<void> {
  const value = JSON.stringify(timing);
  await db().update(repositories).set({
    settings: sql`coalesce(${repositories.settings}, '{}'::jsonb) || jsonb_build_object(
      'setupTiming', ${value}::jsonb,
      'setupTimingHistory', (
        SELECT coalesce(jsonb_agg(e ORDER BY i), '[]'::jsonb) FROM (
          SELECT e, i FROM jsonb_array_elements(
            jsonb_build_array(${value}::jsonb) || CASE
              WHEN jsonb_typeof(${repositories.settings} -> 'setupTimingHistory') = 'array'
              THEN ${repositories.settings} -> 'setupTimingHistory' ELSE '[]'::jsonb END
          ) WITH ORDINALITY AS h(e, i) WHERE i <= ${SETUP_TIMING_HISTORY}
        ) newest))`,
  }).where(eq(repositories.id, repositoryId));
}

/** The times the provision measured outside the setup script. */
export interface BoxTiming {
  boxReadyMs?: number | null;
  checkoutMs?: number | null;
  layer?: string | null;
}

/**
 * After a box's setup ended (or the box had no setup script): read its stored
 * output, note each step's result and time, and the times of the whole start:
 * `box_ready_ms`, `checkout_ms`, `setup_repository_ms`, `setup_box_steps_ms`.
 * It never throws, because a provision must not fail on the Setup list.
 */
export async function recordBoxSetupResults(
  row: { id: string; repositoryId: string | null; sandboxId: string | null; workspaceId?: string },
  timing: BoxTiming = {},
  opts: { ranSetup?: boolean } = {},
): Promise<void> {
  if (!row.repositoryId || !row.sandboxId) return;
  try {
    const output = opts.ranSetup === false ? null : await scriptOutput(row.id, 'setup', row.sandboxId);
    const results = output ? parseLearnedStepResults(output) : [];
    if (results.length > 0) {
      await noteBoxSetupResults(row.repositoryId, results, { workspaceId: row.workspaceId, workbenchId: row.id });
    }
    const script = output ? parseSetupTiming(output) : null;
    if (!script && timing.boxReadyMs == null && timing.checkoutMs == null) return;
    const record: SetupTiming = {
      totalMs: script?.totalMs ?? 0,
      repositoryMs: script?.repositoryMs ?? null,
      learnedMs: script?.learnedMs ?? 0,
      measuredAt: new Date().toISOString(),
      workbenchId: row.id,
      boxReadyMs: timing.boxReadyMs ?? null,
      checkoutMs: timing.checkoutMs ?? null,
      setupRepositoryMs: script?.repositoryMs ?? null,
      setupBoxStepsMs: script ? script.learnedMs : null,
      layer: timing.layer ?? null,
    };
    await noteSetupTiming(row.repositoryId, record);
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'box_timing',
      summary: `Box start: ready ${record.boxReadyMs ?? '?'} ms, checkout ${record.checkoutMs ?? '?'} ms, repository setup ${record.setupRepositoryMs ?? '-'} ms, setup steps ${record.setupBoxStepsMs ?? '-'} ms (image ${record.layer ?? 'unknown'}).`,
      workspaceId: row.workspaceId,
      meta: {
        repositoryId: row.repositoryId,
        workbenchId: row.id,
        box_ready_ms: record.boxReadyMs,
        checkout_ms: record.checkoutMs,
        setup_repository_ms: record.setupRepositoryMs,
        setup_box_steps_ms: record.setupBoxStepsMs,
        layer: record.layer,
      },
    });
  } catch (error) {
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'box_results_failed',
      summary: 'Could not read the step results of a box setup.',
      ok: false,
      error,
      workspaceId: row.workspaceId,
      meta: { repositoryId: row.repositoryId, workbenchId: row.id },
    });
  }
}

// ============================================================================
// The old shapes, for one release (`/bake`, `/setup-recipe`, the old MCP tools)
// ============================================================================

const RECIPE_STATE: Record<SetupStepStatus, SetupRecipeStep['state']> = {
  active: 'live',
  suggested: 'waiting',
  dismissed: 'reverted',
  disabled: 'failing',
};

/** A learned row in the old `SetupRecipeStep` shape. */
export function toRecipeStep(step: SetupListStep): SetupRecipeStep {
  return {
    id: step.id,
    command: step.command,
    kind: step.kind,
    phase: phaseOfRunOn(step.runOn),
    why: step.why,
    source: step.origin === 'agent' ? 'agent' : 'learned',
    state: RECIPE_STATE[step.status],
    sourceWorkbenchId: step.sourceWorkbenchId,
    firstSeenAt: step.firstSeenAt,
    lastSeenAt: step.lastSeenAt,
    seenCount: step.seenCount,
    sessionCount: step.sessionCount,
    confirmedAt: step.status === 'active' || step.status === 'disabled' ? step.confirmedAt : null,
    appliedAt: step.status === 'active' ? step.imageAppliedAt : null,
    disabledAt: step.status === 'dismissed' ? step.statusChangedAt : null,
    disabledReason: step.status === 'dismissed' ? step.statusReason : null,
    bakeDisabledAt: step.imageFailedAt,
    bakeDisabledReason: step.imageFailureReason,
    boxFailureCount: step.boxFailureCount,
    boxLastFailure: step.boxLastFailure,
    boxDisabledAt: step.status === 'disabled' ? step.statusChangedAt : null,
    boxDisabledReason: step.status === 'disabled' ? step.statusReason : null,
    lastDurationMs: step.lastDurationMs,
    typicalDurationMs: step.typicalDurationMs,
    measuredBoxes: step.measuredBoxes,
    ...(step.recentSessions !== undefined
      ? {
          recentNeededSessions: step.recentNeededSessions,
          recentSessions: step.recentSessions,
          share: step.share ?? null,
          heavy: step.heavy ?? false,
          ...(step.verdictReason ? { stateReason: step.verdictReason } : {}),
        }
      : {}),
  };
}

/** `GET /repositories/:id/setup-recipe`: the learned steps in the old shape. */
export async function getSetupRecipe(repositoryId: string, now = new Date()): Promise<SetupRecipe> {
  const setup = await getRepositorySetup(repositoryId, now);
  return {
    repositoryId,
    learningDisabled: setup?.learningDisabled ?? false,
    maxSteps: SETUP_RECIPE_MAX_STEPS,
    windowDays: SETUP_STEP_WINDOW_DAYS,
    lastSetupTiming: setup?.lastSetupTiming ?? null,
    steps: (setup?.steps ?? []).filter((s) => s.origin !== 'user').map(toRecipeStep),
  };
}

/** The old "revert": dismiss. Null: no such learned step. */
export async function revertSetupStep(repositoryId: string, stepId: string): Promise<SetupRecipeStep | null> {
  const row = await repositoryStep(repositoryId, stepId);
  if (!row || row.origin === 'user') return null;
  const step = await dismissSetupStep(repositoryId, stepId);
  return step ? toRecipeStep(step) : null;
}

/** `GET /repositories/:id/bake`: the person's image steps as the old bake. Null: none. */
export async function getRepositoryBake(repositoryId: string): Promise<RepositoryBake | null> {
  const setup = await getRepositorySetup(repositoryId);
  if (!setup) return null;
  const own = setup.steps.filter((s) => s.origin === 'user' && s.runOn !== 'box');
  if (own.length === 0 && setup.hosts.length === 0) return null;
  return {
    steps: own.map((s) => ({ name: s.name, run: s.command, ...(s.timeoutSec ? { timeoutSec: s.timeoutSec } : {}) })),
    ...(own.length && setup.hosts.length ? { hosts: setup.hosts } : {}),
  };
}

/**
 * `PUT /repositories/:id/bake`: replace the person's image steps of the
 * repository, keep everything else. The old validation, so an old client
 * gets the old errors.
 */
export async function putRepositoryBake(repositoryId: string, value: unknown): Promise<RepositoryBake> {
  const bake = validateRepositoryBake(value);
  const setup = await getRepositorySetup(repositoryId);
  if (!setup) throw new Error('Repository not found.');
  const kept = setup.steps.filter((s) => s.status !== 'dismissed' && !(s.origin === 'user' && s.runOn !== 'box'));
  const input: SetupListStepInput[] = [
    ...bake.steps.map((s) => ({ name: s.name, command: s.run, runOn: 'image' as const, timeoutSec: s.timeoutSec ?? null })),
    ...kept.map((s) => ({ id: s.id, name: s.name, runOn: s.runOn, timeoutSec: s.timeoutSec })),
  ];
  // The old bake took a person's command as it was: only the shape was checked.
  const settings = await repositorySetupSettings(repositoryId);
  const now = new Date();
  const where = and(eq(steps.repositoryId, repositoryId), eq(steps.origin, 'user'), ne(steps.runOn, 'box'));
  await db().delete(steps).where(where);
  let position = 0;
  for (const step of input) {
    if (step.id) {
      await db().update(steps).set({ position }).where(eq(steps.id, step.id));
    } else {
      await db().insert(steps).values({
        id: newStepId(),
        workspaceId: settings.workspaceId!,
        repositoryId,
        position,
        stepKey: '',
        name: step.name,
        command: step.command!,
        kind: 'other',
        runOn: 'image',
        origin: 'user',
        status: 'active',
        acceptedBy: 'person',
        timeoutSec: step.timeoutSec ?? null,
        seenCount: 0,
        confirmedAt: now,
        imageAppliedAt: now,
        statusChangedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
    position += 1;
  }
  await mergeRepositorySettings(repositoryId, { setupListEdited: true, setupHosts: bake.hosts ?? [] });
  return bake;
}
