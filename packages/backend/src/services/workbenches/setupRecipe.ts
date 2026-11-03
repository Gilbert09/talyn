import { createHash, randomUUID } from 'node:crypto';
import { and, asc, count, eq, gt, isNotNull, isNull, lte, max, ne, sql } from 'drizzle-orm';
import {
  bakeWithLearnedSteps,
  learnedBakeStepId,
  LEGACY_DOCKER_START_COMMAND,
  mergeLearnedSetup,
  parseLearnedStepResults,
  redactSecrets,
  setupStepIdentity,
  SETUP_RECIPE_MAX_STEPS,
  SETUP_RECIPE_SETTLE_MS,
  SETUP_STEP_MAX_BOX_FAILURES,
  SETUP_STEP_MIN_SESSIONS,
  SETUP_STEP_TIMEOUT_SEC,
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
  type WorkbenchConfig,
  type WorkbenchSettings,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { repositories, repositorySetupStepSessions as stepSessions, repositorySetupSteps as steps } from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { scriptOutput } from './scriptStore.js';

/**
 * The setup recipe of a repository: storage, the box setup, and the bake.
 * The rules that find steps and the shapes they are applied in are in
 * `packages/shared/src/setupRecipe.ts`.
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
} as const;

type StepRow = Pick<typeof steps.$inferSelect, keyof typeof STEP_COLUMNS>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function rowToStep(row: StepRow): SetupRecipeStep {
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
  };
}

/** The dedupe key. Keyed on {@link setupStepIdentity}, which is the command for every kind but cargo. */
export function stepKey(kind: SetupStepKind, command: string): string {
  return createHash('sha256').update(`${kind}\0${setupStepIdentity(kind, command)}`).digest('hex');
}

/** Only the flag and the bake: `repositories.settings` also holds the preview detection. */
async function repositorySetupSettings(repositoryId: string): Promise<{ exists: boolean; disabled: boolean; bake: RepositoryBake | null }> {
  const [row] = await db()
    .select({
      disabled: sql<boolean>`coalesce((${repositories.settings} -> 'setupLearning' ->> 'disabled')::boolean, false)`,
      bake: sql<RepositoryBake | null>`${repositories.settings} -> 'bake'`,
    })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  if (!row) return { exists: false, disabled: false, bake: null };
  const bake = typeof row.bake === 'string' ? (JSON.parse(row.bake) as RepositoryBake | null) : row.bake;
  return { exists: true, disabled: row.disabled === true || (row.disabled as unknown) === 't', bake: bake ?? null };
}

export async function learningDisabled(repositoryId: string): Promise<boolean> {
  return (await repositorySetupSettings(repositoryId)).disabled;
}

export async function getSetupRecipe(repositoryId: string): Promise<SetupRecipe> {
  const [settings, rows] = await Promise.all([
    repositorySetupSettings(repositoryId),
    db().select(STEP_COLUMNS).from(steps).where(eq(steps.repositoryId, repositoryId)).orderBy(asc(steps.ordinal)),
  ]);
  return {
    repositoryId,
    learningDisabled: settings.disabled,
    maxSteps: SETUP_RECIPE_MAX_STEPS,
    steps: rows.map(rowToStep),
  };
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

interface Sighting {
  row: StepRow;
  /** This sighting confirmed the step. */
  confirmed: boolean;
}

/**
 * Count one more sighting of a stored step. A session counts once: the
 * (step, session) row is the proof. The step is confirmed, so it runs, when
 * its {@link SETUP_STEP_MIN_SESSIONS}th session sees it.
 */
async function countSighting(repositoryId: string, key: string, workbenchId: string | null): Promise<Sighting | null> {
  const [row] = await db()
    .update(steps)
    .set({ seenCount: sql`${steps.seenCount} + 1`, lastSeenAt: new Date() })
    .where(and(eq(steps.repositoryId, repositoryId), eq(steps.stepKey, key)))
    .returning(STEP_COLUMNS);
  if (!row) return null;
  return (workbenchId ? await countSession(row.id, workbenchId) : null) ?? { row, confirmed: false };
}

/** Null when the session had already counted. */
async function countSession(stepId: string, workbenchId: string): Promise<Sighting | null> {
  const [fresh] = await db()
    .insert(stepSessions)
    .values({ stepId, workbenchId })
    .onConflictDoNothing()
    .returning({ stepId: stepSessions.stepId });
  if (!fresh) return null;
  const [row] = await db()
    .update(steps)
    .set({
      sessionCount: sql`${steps.sessionCount} + 1`,
      confirmedAt: sql`CASE WHEN ${steps.confirmedAt} IS NULL AND ${steps.sessionCount} + 1 >= ${SETUP_STEP_MIN_SESSIONS} THEN now() ELSE ${steps.confirmedAt} END`,
    })
    .where(eq(steps.id, stepId))
    // now() is the time of this statement's transaction, so only this update can make them equal.
    .returning({ ...STEP_COLUMNS, confirmed: sql<boolean>`coalesce(${steps.confirmedAt} = now(), false)` });
  if (!row) return null;
  const { confirmed, ...rest } = row;
  return { row: rest, confirmed: confirmed === true || (confirmed as unknown) === 't' };
}

/**
 * Add candidates to the recipe, in order. A step that is already there is
 * counted again; a reverted step stays reverted. A new step waits until
 * {@link SETUP_STEP_MIN_SESSIONS} different sessions recorded it, and is
 * refused once the recipe has {@link SETUP_RECIPE_MAX_STEPS} live or waiting
 * steps. Two sessions that add at once can pass the cap by a step or two; the
 * cap bounds growth, it is not a quota.
 */
export async function recordSetupSteps(input: {
  repositoryId: string;
  workspaceId?: string;
  workbenchId: string | null;
  source: SetupStepSource;
  candidates: SetupStepCandidate[];
}): Promise<RecordStepsResult> {
  const out: RecordStepsResult = { added: [], seen: [], full: 0 };
  const seen = ({ row, confirmed }: Sighting) => {
    const step = rowToStep(row);
    out.seen.push(step);
    if (confirmed) {
      debugBus.recordEvent({
        service: 'setup_recipe',
        action: 'step_confirmed',
        summary: `Setup step ${step.id} was needed in ${step.sessionCount} sessions. It now runs on new boxes.`,
        workspaceId: input.workspaceId,
        meta: { repositoryId: input.repositoryId, stepId: step.id, workbenchId: input.workbenchId, kind: step.kind },
      });
    }
  };
  for (const candidate of input.candidates) {
    const key = stepKey(candidate.kind, candidate.command);
    const existing = await countSighting(input.repositoryId, key, input.workbenchId);
    if (existing) {
      seen(existing);
      continue;
    }
    const [{ live }] = await db()
      .select({ live: count() })
      .from(steps)
      .where(and(eq(steps.repositoryId, input.repositoryId), isNull(steps.disabledAt), isNull(steps.boxDisabledAt)));
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
      if (raced) seen(raced);
      continue;
    }
    const row = (input.workbenchId ? (await countSession(inserted.id, input.workbenchId))?.row : null) ?? inserted;
    const step = rowToStep(row);
    out.added.push(step);
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'step_added',
      summary: `Setup step ${step.id} (${step.kind}) ${input.source === 'agent' ? 'recorded by an agent' : 'learned'} from session ${input.workbenchId ?? 'unknown'}: ${redactSecrets(step.command).slice(0, 200)}. It waits for ${SETUP_STEP_MIN_SESSIONS} sessions before it runs.`,
      workspaceId: input.workspaceId,
      meta: { repositoryId: input.repositoryId, stepId: step.id, workbenchId: input.workbenchId, kind: step.kind },
    });
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

/** A step runs on boxes: confirmed, not reverted, not failing. */
const runnable = (repositoryId: string) => and(
  eq(steps.repositoryId, repositoryId),
  isNull(steps.disabledAt),
  isNull(steps.boxDisabledAt),
  isNotNull(steps.confirmedAt),
);

/**
 * The steps a new box runs after the repository's setup: every confirmed live
 * step, with no wait for the bake. Two more rules:
 * - The old Docker start ({@link LEGACY_DOCKER_START_COMMAND}) is skipped.
 *   Docker starts on demand now, and that start failed as uid 1000.
 * - Two steps with one identity run once, the older one. Rows stored before
 *   the cargo forms were made one can be two rows for one install.
 */
export async function setupStepsForBox(repositoryId: string): Promise<AppliedSetupStep[]> {
  if (await learningDisabled(repositoryId)) return [];
  const rows = await db()
    .select(APPLY_COLUMNS)
    .from(steps)
    .where(and(runnable(repositoryId), ne(steps.command, LEGACY_DOCKER_START_COMMAND)))
    .orderBy(asc(steps.ordinal));
  const identities = new Set<string>();
  return rows.map(toApplied).filter((step) => {
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
 * After a box's setup script ended: read its stored output and note each
 * learned step's result. It never throws, because a provision must not fail
 * on the recipe.
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
