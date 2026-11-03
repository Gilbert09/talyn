import { createHash, randomUUID } from 'node:crypto';
import { and, asc, count, eq, isNotNull, isNull, lte, max, sql } from 'drizzle-orm';
import {
  bakeWithLearnedSteps,
  learnedBakeStepId,
  mergeLearnedSetup,
  redactSecrets,
  setupStepIdentity,
  SETUP_RECIPE_MAX_STEPS,
  SETUP_RECIPE_SETTLE_MS,
  type AppliedSetupStep,
  type BakeStepResult,
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
import { repositories, repositorySetupSteps as steps } from '../../db/schema.js';
import { debugBus } from '../debugBus.js';

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
    sourceWorkbenchId: row.sourceWorkbenchId,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    seenCount: row.seenCount,
    appliedAt: iso(row.appliedAt),
    disabledAt: iso(row.disabledAt),
    disabledReason: row.disabledReason,
    bakeDisabledAt: iso(row.bakeDisabledAt),
    bakeDisabledReason: row.bakeDisabledReason,
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

/**
 * Add candidates to the recipe, in order. A step that is already there is
 * counted again; a reverted step stays reverted. A new step is refused once
 * the recipe has {@link SETUP_RECIPE_MAX_STEPS} live steps. Two sessions that
 * add at once can pass the cap by a step or two; the cap bounds growth, it is
 * not a quota.
 */
export async function recordSetupSteps(input: {
  repositoryId: string;
  workspaceId?: string;
  workbenchId: string | null;
  source: SetupStepSource;
  candidates: SetupStepCandidate[];
}): Promise<RecordStepsResult> {
  const out: RecordStepsResult = { added: [], seen: [], full: 0 };
  for (const candidate of input.candidates) {
    const key = stepKey(candidate.kind, candidate.command);
    const [existing] = await db()
      .update(steps)
      .set({ seenCount: sql`${steps.seenCount} + 1`, lastSeenAt: new Date() })
      .where(and(eq(steps.repositoryId, input.repositoryId), eq(steps.stepKey, key)))
      .returning(STEP_COLUMNS);
    if (existing) {
      out.seen.push(rowToStep(existing));
      continue;
    }
    const [{ live }] = await db()
      .select({ live: count() })
      .from(steps)
      .where(and(eq(steps.repositoryId, input.repositoryId), isNull(steps.disabledAt)));
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
    if (!inserted) continue;
    const step = rowToStep(inserted);
    out.added.push(step);
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'step_added',
      summary: `Setup step ${step.id} (${step.kind}) ${input.source === 'agent' ? 'recorded by an agent' : 'learned'} from session ${input.workbenchId ?? 'unknown'}: ${redactSecrets(step.command).slice(0, 200)}`,
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

/** The steps a new box runs after the repository's setup: every live step, with no wait. */
export async function setupStepsForBox(repositoryId: string): Promise<AppliedSetupStep[]> {
  if (await learningDisabled(repositoryId)) return [];
  const rows = await db()
    .select(APPLY_COLUMNS)
    .from(steps)
    .where(and(eq(steps.repositoryId, repositoryId), isNull(steps.disabledAt)))
    .orderBy(asc(steps.ordinal));
  return rows.map(toApplied);
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
  const pending = and(eq(steps.repositoryId, repositoryId), isNull(steps.appliedAt), isNull(steps.disabledAt));
  const [{ newest }] = await db().select({ newest: max(steps.firstSeenAt) }).from(steps).where(pending);
  if (!newest) return [];
  const newestAt = newest instanceof Date ? newest : new Date(newest as unknown as string);
  if (now.getTime() - newestAt.getTime() < SETUP_RECIPE_SETTLE_MS) return [];
  const rows = await db()
    .update(steps)
    .set({ appliedAt: now })
    .where(and(pending, lte(steps.firstSeenAt, newestAt)))
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
      eq(steps.repositoryId, repositoryId),
      isNotNull(steps.appliedAt),
      isNull(steps.disabledAt),
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
    .where(and(eq(steps.repositoryId, repositoryId), isNotNull(steps.appliedAt), isNull(steps.bakeDisabledAt), isNull(steps.disabledAt)))
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
