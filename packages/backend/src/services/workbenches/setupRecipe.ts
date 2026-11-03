import { createHash, randomUUID } from 'node:crypto';
import { and, asc, count, eq, gt, gte, isNotNull, isNull, lte, max, or, sql } from 'drizzle-orm';
import {
  bakeWithLearnedSteps,
  isHeavySetupStep,
  learnedBakeStepId,
  LEGACY_DOCKER_START_COMMAND,
  mergeLearnedSetup,
  parseLearnedStepResults,
  parseSetupTiming,
  redactSecrets,
  setupStepIdentity,
  SETUP_RECIPE_MAX_STEPS,
  SETUP_RECIPE_SETTLE_MS,
  SETUP_STEP_MAX_BOX_FAILURES,
  SETUP_STEP_TIMEOUT_SEC,
  SETUP_STEP_TYPICAL_WEIGHT,
  SETUP_STEP_WINDOW_DAYS,
  setupStepUsed,
  setupStepVerdict,
  turnCommandWords,
  type AppliedSetupStep,
  type BakeStepResult,
  type LearnedStepResult,
  type RepositoryBake,
  type SetupRecipe,
  type SetupRecipeStep,
  type SetupStepCandidate,
  type SetupStepKind,
  type SetupStepPhase,
  type SetupStepSource,
  type SetupTiming,
  type TurnToolCall,
  type WorkbenchConfig,
  type WorkbenchSettings,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import {
  repositories,
  repositorySetupStepSessions as stepSessions,
  repositorySetupSteps as steps,
  workbenches,
} from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { scriptOutput } from './scriptStore.js';

/**
 * The setup recipe of a repository: storage, the box setup, and the bake.
 * The rules that find steps and the shapes they are applied in are in
 * `packages/shared/src/setupRecipe.ts`.
 *
 * A step runs on new boxes (`confirmed_at` set) only while enough of the
 * repository's recent sessions need it: see `setupStepVerdict`. A session
 * needs a step when it ran the step, or, for a live step, when it used what
 * the step installs (`recordStepUses`). `repository_setup_step_sessions` holds
 * both, one row per (step, session). {@link reconcileSetupSteps} applies the
 * verdict when a box is set up, when a step is recorded and when the recipe
 * is read.
 *
 * No lock anywhere. The unique (repository, step key) index makes a step that
 * two sessions learn at once one row, and every change is one statement.
 */

const db = () => getPoolDbClient();

export const STEP_COLUMNS = {
  id: steps.id,
  command: steps.command,
  kind: steps.kind,
  phase: steps.phase,
  why: steps.why,
  source: steps.source,
  sourceWorkbenchId: steps.sourceWorkbenchId,
  seenCount: steps.seenCount,
  firstSeenAt: steps.firstSeenAt,
  lastSeenAt: steps.lastSeenAt,
  appliedAt: steps.appliedAt,
  disabledAt: steps.disabledAt,
  disabledReason: steps.disabledReason,
  bakeDisabledAt: steps.bakeDisabledAt,
  bakeDisabledReason: steps.bakeDisabledReason,
  sessionCount: steps.sessionCount,
  confirmedAt: steps.confirmedAt,
  boxFailureCount: steps.boxFailureCount,
  boxLastFailure: steps.boxLastFailure,
  boxDisabledAt: steps.boxDisabledAt,
  boxDisabledReason: steps.boxDisabledReason,
  lastDurationMs: steps.lastDurationMs,
  typicalDurationMs: steps.typicalDurationMs,
  measuredBoxes: steps.measuredBoxes,
} as const;

type StepRow = Pick<typeof steps.$inferSelect, keyof typeof STEP_COLUMNS>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function rowToStep(row: StepRow, usage?: StepUsage): SetupRecipeStep {
  return {
    id: row.id,
    command: row.command,
    kind: row.kind as SetupStepKind,
    phase: row.phase as SetupStepPhase,
    why: row.why,
    source: row.source as SetupStepSource,
    state: row.disabledAt ? 'reverted' : row.boxDisabledAt ? 'failing' : row.confirmedAt ? 'live' : 'waiting',
    sourceWorkbenchId: row.sourceWorkbenchId,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    seenCount: row.seenCount,
    sessionCount: row.sessionCount,
    confirmedAt: iso(row.confirmedAt),
    appliedAt: iso(row.appliedAt),
    disabledAt: iso(row.disabledAt),
    disabledReason: row.disabledReason,
    bakeDisabledAt: iso(row.bakeDisabledAt),
    bakeDisabledReason: row.bakeDisabledReason,
    boxFailureCount: row.boxFailureCount,
    boxLastFailure: row.boxLastFailure,
    boxDisabledAt: iso(row.boxDisabledAt),
    boxDisabledReason: row.boxDisabledReason,
    lastDurationMs: row.lastDurationMs,
    typicalDurationMs: row.typicalDurationMs,
    measuredBoxes: row.measuredBoxes,
    ...(usage
      ? {
          recentNeededSessions: usage.neededBy,
          recentSessions: usage.sessions,
          share: usage.sessions > 0 ? usage.neededBy / usage.sessions : null,
          heavy: usage.heavy,
          ...(usage.reason ? { stateReason: usage.reason } : {}),
        }
      : {}),
  };
}

interface StepUsage {
  neededBy: number;
  sessions: number;
  heavy: boolean;
  reason: string | null;
}

/** The dedupe key. Keyed on {@link setupStepIdentity}, which is the command for every kind but cargo. */
export function stepKey(kind: SetupStepKind, command: string): string {
  return createHash('sha256').update(`${kind}\0${setupStepIdentity(kind, command)}`).digest('hex');
}

interface SetupSettings {
  exists: boolean;
  disabled: boolean;
  bake: RepositoryBake | null;
  /** When Talyn first counted uses of live steps for this repository (`recordStepUses`). */
  usageSince: Date | null;
  timing: SetupTiming | null;
}

/** Only the flag, the bake and the usage mark: `repositories.settings` also holds the preview detection. */
async function repositorySetupSettings(repositoryId: string): Promise<SetupSettings> {
  const [row] = await db()
    .select({
      disabled: sql<boolean>`coalesce((${repositories.settings} -> 'setupLearning' ->> 'disabled')::boolean, false)`,
      bake: sql<RepositoryBake | null>`${repositories.settings} -> 'bake'`,
      usageSince: sql<string | null>`${repositories.settings} ->> 'setupUsageSince'`,
      timing: sql<SetupTiming | null>`${repositories.settings} -> 'setupTiming'`,
    })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  if (!row) return { exists: false, disabled: false, bake: null, usageSince: null, timing: null };
  const bake = typeof row.bake === 'string' ? (JSON.parse(row.bake) as RepositoryBake | null) : row.bake;
  const usageSince = row.usageSince ? new Date(row.usageSince) : null;
  return {
    exists: true,
    disabled: row.disabled === true || (row.disabled as unknown) === 't',
    bake: bake ?? null,
    usageSince: usageSince && !Number.isNaN(usageSince.getTime()) ? usageSince : null,
    timing: (typeof row.timing === 'string' ? (JSON.parse(row.timing) as SetupTiming | null) : row.timing) ?? null,
  };
}

export async function learningDisabled(repositoryId: string): Promise<boolean> {
  return (await repositorySetupSettings(repositoryId)).disabled;
}

export async function getSetupRecipe(repositoryId: string, now = new Date()): Promise<SetupRecipe> {
  const settings = await repositorySetupSettings(repositoryId);
  return {
    repositoryId,
    learningDisabled: settings.disabled,
    maxSteps: SETUP_RECIPE_MAX_STEPS,
    windowDays: SETUP_STEP_WINDOW_DAYS,
    lastSetupTiming: settings.timing,
    steps: await reconcileSetupSteps(repositoryId, { now, settings }),
  };
}

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
      neededBy: sql<number>`(
        SELECT count(*)::int FROM ${stepSessions} ss JOIN ${workbenches} w ON w.id = ss.workbench_id
        WHERE ss.step_id = ${steps}.id AND ${recent})`,
      sessions: sql<number>`(SELECT count(*)::int FROM ${workbenches} w WHERE ${recent})`,
    })
    .from(steps)
    .where(eq(steps.repositoryId, repositoryId))
    .orderBy(asc(steps.ordinal));
}

/**
 * Apply {@link setupStepVerdict} to every step, and return the steps with
 * their share. A step that goes live gets `confirmed_at`. A step that goes
 * back to waiting loses `confirmed_at` and `applied_at`, so it leaves the box
 * setup and the bake. Reverted and failing steps do not change.
 *
 * A live step leaves only after {@link SETUP_STEP_WINDOW_DAYS} days of usage
 * data ({@link recordStepUses}). Before that, the sessions that used a live
 * step without running it were not counted, and the step would look unneeded.
 * This is what keeps the steps from before this rule running until they have
 * real data.
 *
 * Each update matches only the state it changes, so two replicas that
 * reconcile at once write once.
 */
export async function reconcileSetupSteps(
  repositoryId: string,
  opts: { now?: Date; settings?: SetupSettings; workspaceId?: string } = {},
): Promise<SetupRecipeStep[]> {
  const now = opts.now ?? new Date();
  const settings = opts.settings ?? (await repositorySetupSettings(repositoryId));
  const canDrop = settings.usageSince !== null && now.getTime() - settings.usageSince.getTime() >= WINDOW_MS;
  const rows = await stepUsageQuery(repositoryId, new Date(now.getTime() - WINDOW_MS));
  const out: SetupRecipeStep[] = [];
  for (const { neededBy: rawNeeded, sessions: rawSessions, ...row } of rows) {
    const usage: StepUsage = { neededBy: Number(rawNeeded), sessions: Number(rawSessions), heavy: isHeavySetupStep(row.command), reason: null };
    if (row.disabledAt || row.boxDisabledAt) {
      out.push(rowToStep(row, usage));
      continue;
    }
    const verdict = setupStepVerdict({
      live: row.confirmedAt !== null,
      heavy: usage.heavy,
      neededBy: usage.neededBy,
      sessions: usage.sessions,
      typicalDurationMs: row.typicalDurationMs,
      canDrop,
    });
    usage.reason = verdict.reason;
    let current: StepRow = row;
    if (verdict.live && !row.confirmedAt) {
      const [updated] = await db()
        .update(steps)
        .set({ confirmedAt: now })
        .where(and(eq(steps.id, row.id), isNull(steps.confirmedAt), isNull(steps.disabledAt), isNull(steps.boxDisabledAt)))
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
    } else if (!verdict.live && row.confirmedAt) {
      const [updated] = await db()
        .update(steps)
        .set({ confirmedAt: null, appliedAt: null })
        .where(and(eq(steps.id, row.id), isNotNull(steps.confirmedAt)))
        .returning(STEP_COLUMNS);
      if (updated) {
        current = updated;
        debugBus.recordEvent({
          service: 'setup_recipe',
          action: 'step_dropped',
          summary: `Setup step ${row.id} no longer runs on new boxes or in the bake. ${verdict.reason}`,
          workspaceId: opts.workspaceId,
          meta: { repositoryId, stepId: row.id, kind: row.kind },
        });
      }
    }
    out.push(rowToStep(current, usage));
  }
  return out;
}

export async function setSetupLearning(repositoryId: string, disabled: boolean): Promise<void> {
  const patch = JSON.stringify({ setupLearning: { disabled, changedAt: new Date().toISOString() } });
  await db().update(repositories).set({
    settings: sql`coalesce(${repositories.settings}, '{}'::jsonb) || ${patch}::jsonb`,
  }).where(eq(repositories.id, repositoryId));
  debugBus.recordEvent({
    service: 'setup_recipe',
    action: disabled ? 'learning_disabled' : 'learning_enabled',
    summary: disabled ? 'Setup learning was turned off for a repository.' : 'Setup learning was turned on for a repository.',
    meta: { repositoryId },
  });
}

export interface RecordStepsResult {
  /** New steps. */
  added: SetupRecipeStep[];
  /** Steps already in the recipe, counted again. */
  seen: SetupRecipeStep[];
  /** Candidates left out because the recipe is full. */
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

/**
 * Add candidates to the recipe, in order. A step that is already there is
 * counted again; a reverted step stays reverted. A new step waits until
 * enough recent sessions need it ({@link reconcileSetupSteps}), and is refused
 * once the recipe has {@link SETUP_RECIPE_MAX_STEPS} steps that are live or
 * were seen in the window. A waiting step that no session needed for the
 * whole window does not take a place: one-offs must not fill the recipe. Two
 * sessions that add at once can pass the cap by a step or two; the cap bounds
 * growth, it is not a quota.
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
        isNull(steps.disabledAt),
        isNull(steps.boxDisabledAt),
        or(isNotNull(steps.confirmedAt), gte(steps.lastSeenAt, windowStart)),
      ));
    if (Number(live) >= SETUP_RECIPE_MAX_STEPS) {
      out.full += 1;
      continue;
    }
    const [inserted] = await db()
      .insert(steps)
      .values({
        id: `st_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        repositoryId: input.repositoryId,
        stepKey: key,
        command: candidate.command,
        kind: candidate.kind,
        phase: candidate.phase,
        why: candidate.why,
        source: input.source,
        sourceWorkbenchId: input.workbenchId,
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
      summary: `Setup step ${inserted.id} (${inserted.kind}) ${input.source === 'agent' ? 'recorded by an agent' : 'learned'} from session ${input.workbenchId ?? 'unknown'}: ${redactSecrets(inserted.command).slice(0, 200)}. It waits until enough recent sessions need it.`,
      workspaceId: input.workspaceId,
      meta: { repositoryId: input.repositoryId, stepId: inserted.id, workbenchId: input.workbenchId, kind: inserted.kind },
    });
  }
  if (addedIds.length > 0 || seenIds.length > 0) {
    const byId = new Map((await reconcileSetupSteps(input.repositoryId, { workspaceId: input.workspaceId })).map((s) => [s.id, s]));
    for (const id of addedIds) if (byId.has(id)) out.added.push(byId.get(id)!);
    for (const id of seenIds) if (byId.has(id)) out.seen.push(byId.get(id)!);
  }
  if (out.full > 0) {
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'recipe_full',
      summary: `The setup recipe has ${SETUP_RECIPE_MAX_STEPS} steps, so ${out.full} new step(s) were not added.`,
      ok: false,
      workspaceId: input.workspaceId,
      meta: { repositoryId: input.repositoryId, workbenchId: input.workbenchId },
    });
  }
  return out;
}

/** Revert one step. It stays in the recipe as reverted, so it is not learned again. */
export async function revertSetupStep(repositoryId: string, stepId: string): Promise<SetupRecipeStep | null> {
  const [row] = await db()
    .update(steps)
    .set({ disabledAt: sql`coalesce(${steps.disabledAt}, now())`, disabledReason: sql`coalesce(${steps.disabledReason}, 'Reverted by a person.')` })
    .where(and(eq(steps.repositoryId, repositoryId), eq(steps.id, stepId)))
    .returning(STEP_COLUMNS);
  if (!row) return null;
  debugBus.recordEvent({
    service: 'setup_recipe',
    action: 'step_reverted',
    summary: `Setup step ${stepId} was reverted.`,
    meta: { repositoryId, stepId },
  });
  return rowToStep(row);
}

const APPLY_COLUMNS = {
  id: steps.id,
  command: steps.command,
  kind: steps.kind,
  phase: steps.phase,
  sourceWorkbenchId: steps.sourceWorkbenchId,
} as const;

const toApplied = (row: Pick<typeof steps.$inferSelect, keyof typeof APPLY_COLUMNS>): AppliedSetupStep => ({
  id: row.id,
  command: row.command,
  kind: row.kind as SetupStepKind,
  phase: row.phase as SetupStepPhase,
  sourceWorkbenchId: row.sourceWorkbenchId,
});

/** A step runs on boxes: live (`confirmed_at` set), not reverted, not failing. */
const runnable = (repositoryId: string) => and(
  eq(steps.repositoryId, repositoryId),
  isNull(steps.disabledAt),
  isNull(steps.boxDisabledAt),
  isNotNull(steps.confirmedAt),
);

/**
 * The steps a new box runs after the repository's setup: every live step,
 * with no wait for the bake. The verdict is applied first
 * ({@link reconcileSetupSteps}), so a step whose share fell does not run. Two
 * more rules:
 * - The old Docker start ({@link LEGACY_DOCKER_START_COMMAND}) is skipped.
 *   Docker starts on demand now, and that start failed as uid 1000.
 * - Two steps with one identity run once, the older one. Rows stored before
 *   the cargo forms were made one can be two rows for one install.
 */
export async function setupStepsForBox(repositoryId: string, now = new Date()): Promise<AppliedSetupStep[]> {
  const settings = await repositorySetupSettings(repositoryId);
  if (settings.disabled) return [];
  const all = await reconcileSetupSteps(repositoryId, { now, settings });
  const identities = new Set<string>();
  return all
    .filter((s) => s.state === 'live' && s.command !== LEGACY_DOCKER_START_COMMAND)
    .map((s): AppliedSetupStep => ({ id: s.id, command: s.command, kind: s.kind, phase: s.phase, sourceWorkbenchId: s.sourceWorkbenchId }))
    .filter((step) => {
      const identity = `${step.kind}\0${setupStepIdentity(step.kind, step.command)}`;
      if (identities.has(identity)) return false;
      identities.add(identity);
      return true;
    });
}

/**
 * The repository config with the learned steps after its setup. A session
 * whose own settings remove the setup gets none. A failure to read the recipe
 * leaves the config as it was: learning must never stop a box from starting.
 */
export async function withLearnedSetup(
  row: { repositoryId: string | null; kind?: string | null; settings?: WorkbenchSettings | null; workspaceId?: string },
  config: WorkbenchConfig,
): Promise<WorkbenchConfig> {
  if (!row.repositoryId || row.kind === 'thread' || row.settings?.scripts?.setup === null) return config;
  try {
    return mergeLearnedSetup(config, await setupStepsForBox(row.repositoryId));
  } catch (error) {
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'read_failed',
      summary: 'Could not read the setup recipe. The box runs the repository setup only.',
      ok: false,
      error,
      workspaceId: row.workspaceId,
      meta: { repositoryId: row.repositoryId },
    });
    return config;
  }
}

/**
 * Put the waiting steps into the bake when the recipe has settled: no new
 * step for {@link SETUP_RECIPE_SETTLE_MS}. Called when a box is created, which
 * is when the bake is sent; the fleet bakes again when the bake changes.
 */
export async function promoteSettledSteps(repositoryId: string, now = new Date()): Promise<AppliedSetupStep[]> {
  // Only a confirmed step can go into the bake. "Settled" counts from when it was confirmed.
  const pending = and(runnable(repositoryId), isNull(steps.appliedAt));
  const [{ newest }] = await db().select({ newest: max(steps.confirmedAt) }).from(steps).where(pending);
  if (!newest) return [];
  const newestAt = newest instanceof Date ? newest : new Date(newest as unknown as string);
  if (now.getTime() - newestAt.getTime() < SETUP_RECIPE_SETTLE_MS) return [];
  const rows = await db()
    .update(steps)
    .set({ appliedAt: now })
    .where(and(pending, lte(steps.confirmedAt, newestAt)))
    .returning(APPLY_COLUMNS);
  for (const row of rows) {
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'step_applied',
      summary: `Setup step ${row.id} from session ${row.sourceWorkbenchId ?? 'unknown'} now goes into the repository bake${row.phase === 'install' ? '' : ' (box setup only: it starts something)'}.`,
      meta: { repositoryId, stepId: row.id, workbenchId: row.sourceWorkbenchId, kind: row.kind },
    });
  }
  return rows.map(toApplied);
}

/**
 * The bake a new box of this repository is created with: the repository's own
 * bake, then the applied install steps. Learning off: the repository's own.
 */
export async function effectiveRepositoryBake(repositoryId: string, now = new Date()): Promise<RepositoryBake | null> {
  const settings = await repositorySetupSettings(repositoryId);
  if (settings.disabled) return settings.bake;
  await reconcileSetupSteps(repositoryId, { now, settings });
  await promoteSettledSteps(repositoryId, now);
  const rows = await db()
    .select(APPLY_COLUMNS)
    .from(steps)
    .where(and(
      runnable(repositoryId),
      isNotNull(steps.appliedAt),
      isNull(steps.bakeDisabledAt),
      eq(steps.phase, 'install'),
    ))
    .orderBy(asc(steps.ordinal));
  return bakeWithLearnedSteps(settings.bake, rows.map(toApplied));
}

/** Whether any step is in the bake, so a bake result is worth reading. */
export async function hasBakedSteps(repositoryId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: steps.id })
    .from(steps)
    .where(and(runnable(repositoryId), isNotNull(steps.appliedAt), isNull(steps.bakeDisabledAt)))
    .limit(1);
  return Boolean(row);
}

/**
 * Read a bake's step results. A learned step that failed there leaves the bake,
 * with the reason; it still runs in the box setup, where it ran before.
 */
export async function noteBakeResults(repositoryId: string, results: BakeStepResult[], workspaceId?: string): Promise<string[]> {
  const disabled: string[] = [];
  for (const result of results) {
    const id = learnedBakeStepId(result.name);
    if (!id || result.ok) continue;
    const tail = redactSecrets(result.logTail ?? '').trim().slice(-400);
    const reason = `The step failed in the repository bake with exit ${result.exitCode}.${tail ? ` Last output: ${tail}` : ''}`;
    const [row] = await db()
      .update(steps)
      .set({ bakeDisabledAt: new Date(), bakeDisabledReason: reason })
      .where(and(eq(steps.repositoryId, repositoryId), eq(steps.id, id), isNull(steps.bakeDisabledAt)))
      .returning({ id: steps.id });
    if (!row) continue;
    disabled.push(row.id);
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'step_bake_failed',
      summary: `Setup step ${id} failed in the bake (exit ${result.exitCode}) and was taken out of it.`,
      ok: false,
      workspaceId,
      meta: { repositoryId, stepId: id },
    });
  }
  return disabled;
}

/** The failure as one line: `exit 100: E: Unable to locate package x`, or the time limit. */
function boxFailureText(result: LearnedStepResult, kind: SetupStepKind | undefined): string {
  const head = result.timedOut
    ? `timed out after ${SETUP_STEP_TIMEOUT_SEC[kind ?? 'other'] ?? SETUP_STEP_TIMEOUT_SEC.other} seconds`
    : `exit ${result.exitCode}`;
  const line = redactSecrets(result.lastLine).trim().slice(0, 300);
  return line ? `${head}: ${line}` : head;
}

/**
 * Read the learned-step results of one box setup. A success sets the step's
 * failure count to 0. A failure adds one, and the
 * {@link SETUP_STEP_MAX_BOX_FAILURES}th failure in a row stops the step: it
 * leaves the box setup and the bake, with the reason. Only steps of this
 * repository are changed, so a result line that names another step does nothing.
 */
export async function noteBoxSetupResults(
  repositoryId: string,
  results: LearnedStepResult[],
  context: { workspaceId?: string; workbenchId?: string } = {},
): Promise<{ failed: string[]; disabled: string[] }> {
  const out = { failed: [] as string[], disabled: [] as string[] };
  for (const result of results) {
    const mine = and(eq(steps.repositoryId, repositoryId), eq(steps.id, result.id), isNull(steps.boxDisabledAt));
    if (result.durationMs !== undefined) await noteDuration(repositoryId, result.id, result.durationMs);
    if (result.exitCode === 0) {
      await db().update(steps).set({ boxFailureCount: 0 }).where(and(mine, gt(steps.boxFailureCount, 0)));
      continue;
    }
    const [kindRow] = await db().select({ kind: steps.kind }).from(steps).where(mine).limit(1);
    if (!kindRow) continue;
    const failure = boxFailureText(result, kindRow.kind as SetupStepKind);
    const reason = `Failed on ${SETUP_STEP_MAX_BOX_FAILURES} boxes in a row. Last: ${failure}`;
    const limitReached = sql`${steps.boxFailureCount} + 1 >= ${SETUP_STEP_MAX_BOX_FAILURES}`;
    const [row] = await db()
      .update(steps)
      .set({
        boxFailureCount: sql`${steps.boxFailureCount} + 1`,
        boxLastFailure: failure,
        boxDisabledAt: sql`CASE WHEN ${limitReached} THEN now() END`,
        boxDisabledReason: sql`CASE WHEN ${limitReached} THEN ${reason}::text END`,
      })
      .where(mine)
      .returning({ id: steps.id, boxFailureCount: steps.boxFailureCount, boxDisabledAt: steps.boxDisabledAt });
    if (!row) continue;
    out.failed.push(row.id);
    if (row.boxDisabledAt) out.disabled.push(row.id);
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: row.boxDisabledAt ? 'step_box_disabled' : 'step_box_failed',
      summary: row.boxDisabledAt
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
async function noteDuration(repositoryId: string, stepId: string, durationMs: number): Promise<void> {
  const ms = Math.max(0, Math.min(Math.round(durationMs), 2_000_000_000));
  await db()
    .update(steps)
    .set({
      lastDurationMs: ms,
      typicalDurationMs: sql`CASE WHEN ${steps.typicalDurationMs} IS NULL THEN ${ms}::int
        ELSE round(${steps.typicalDurationMs} * (1 - ${SETUP_STEP_TYPICAL_WEIGHT}::float8) + ${ms}::int * ${SETUP_STEP_TYPICAL_WEIGHT}::float8)::int END`,
      measuredBoxes: sql`${steps.measuredBoxes} + 1`,
    })
    .where(and(eq(steps.repositoryId, repositoryId), eq(steps.id, stepId)));
}

/** Keep the times of a box setup on the repository: one small record, replaced by each box. */
async function noteSetupTiming(repositoryId: string, timing: SetupTiming): Promise<void> {
  await db().update(repositories).set({
    settings: sql`coalesce(${repositories.settings}, '{}'::jsonb) || jsonb_build_object('setupTiming', ${JSON.stringify(timing)}::jsonb)`,
  }).where(eq(repositories.id, repositoryId));
}

/**
 * After a box's setup script ended: read its stored output and note each
 * learned step's result and time, and the times of the whole setup. It never
 * throws, because a provision must not fail on the recipe.
 */
export async function recordBoxSetupResults(row: {
  id: string;
  repositoryId: string | null;
  sandboxId: string | null;
  workspaceId?: string;
}): Promise<void> {
  if (!row.repositoryId || !row.sandboxId) return;
  try {
    const output = await scriptOutput(row.id, 'setup', row.sandboxId);
    if (!output) return;
    const results = parseLearnedStepResults(output);
    if (results.length > 0) {
      await noteBoxSetupResults(row.repositoryId, results, { workspaceId: row.workspaceId, workbenchId: row.id });
    }
    const timing = parseSetupTiming(output);
    if (timing) {
      await noteSetupTiming(row.repositoryId, { ...timing, measuredAt: new Date().toISOString(), workbenchId: row.id });
    }
  } catch (error) {
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'box_results_failed',
      summary: 'Could not read the learned-step results of a box setup.',
      ok: false,
      error,
      workspaceId: row.workspaceId,
      meta: { repositoryId: row.repositoryId, workbenchId: row.id },
    });
  }
}

/**
 * Count the sessions that used a live step without running it: the box had
 * already run the step, so the agent used what it installs (`cargo` after
 * rustup, `sqlx` after `cargo install sqlx-cli`, `pytest` after `uv sync`).
 * See `setupStepUses`. Each use is one (step, session) row, like a sighting.
 *
 * The first call for a repository also marks when Talyn began to count uses
 * (`settings.setupUsageSince`). Only {@link SETUP_STEP_WINDOW_DAYS} days after
 * that can a live step leave ({@link reconcileSetupSteps}).
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
  const live = await db().select(APPLY_COLUMNS).from(steps).where(runnable(input.repositoryId));
  const used: string[] = [];
  for (const row of live) {
    if (!setupStepUsed(toApplied(row), words)) continue;
    if (await countSession(row.id, input.workbenchId)) used.push(row.id);
  }
  return used;
}
