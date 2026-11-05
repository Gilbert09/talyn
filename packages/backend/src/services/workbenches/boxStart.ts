import { eq, inArray, sql } from 'drizzle-orm';
import {
  DOTFILES_STEP_ID,
  formatDurationMs,
  SANDBOX_SLOW_START_FACTOR,
  SANDBOX_SLOW_START_MIN_EXTRA_MS,
  SANDBOX_START_MEDIAN_MIN,
  type LearnedStepResult,
  type SandboxRecentStart,
  type SandboxStartImage,
  type SandboxStartInfo,
  type SandboxStartLayer,
  type SandboxStartStep,
  type SandboxStartTimeline,
  type SandboxWake,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { repositories, setupSteps, workbenches } from '../../db/schema.js';
import type { FleetSandbox } from '../selfHosted/client.js';
import { recordBootMetric, recordSandboxBootMetric, type WorkbenchRow } from './store.js';

/**
 * "How this box started" in the Sandbox panel: the image, the start timeline,
 * the last wake, and the repository's recent starts.
 *
 * The last box's start goes on the session row (`settings.boxStart`), and the
 * last wake on `settings.lastWake`. Both are server-written, both are small,
 * and both stay out of the public `Workbench` payload ({@link BOX_START_SETTINGS_KEYS}).
 * The repository's recent starts are the `setupTimingHistory` that
 * `recordBoxSetupResults` already keeps, read as a few numbers in SQL.
 */

export const BOX_START_SETTINGS_KEYS = ['boxStart', 'boxStarts', 'lastWake', 'wakes'] as const;

export type BoxStartCause = 'new' | 'move' | 'lost' | 'restore';

/** One Setup list step on the box. */
export interface StoredBoxStep {
  id: string;
  name: string;
  ms: number | null;
  exit: number;
  timedOut?: boolean;
}

/** One box start, as `settings.boxStart` holds it. */
export interface StoredBoxStart {
  sandboxId: string;
  cause: BoxStartCause | null;
  /** The same instant as the box's `setupTimingHistory` entry, so the median can leave it out. */
  measuredAt: string;
  requestedAt: string | null;
  /** The wait for a free sandbox, inside `readyMs`. */
  waitMs: number | null;
  /** From the create request to a booted box. */
  readyMs: number | null;
  checkoutMs: number | null;
  /** The image held the checkout. False: a full clone. */
  prebaked: boolean | null;
  /** The repository's own setup, from the setup's timing line. */
  repoSetupMs: number | null;
  /** All Setup list steps on the box. */
  stepsMs: number | null;
  /** The whole setup script, by the clock of the provision. */
  setupMs: number | null;
  setupExit: number | null;
  /** From the create request to the end of the setup. */
  totalMs: number | null;
  steps: StoredBoxStep[];
  layer: string | null;
  repoCommit: string | null;
  userLayerPending: boolean | null;
  repoLayerPending: boolean | null;
  /** The box came from the repository's warm pool (`warmPool.ts`). Absent: a fresh box. */
  warm?: true;
}

export interface StoredWake {
  sandboxId: string;
  at: string;
  ms: number | null;
  from: 'host' | 'storage';
  ok: boolean;
}

const db = () => getPoolDbClient();

/** Keep a box's start on its session. A jsonb merge: it never overwrites another settings key. */
export async function writeBoxStart(workbenchId: string, record: StoredBoxStart): Promise<void> {
  const value = JSON.stringify(record);
  const history = sql`(
    SELECT coalesce(jsonb_agg(entry ORDER BY ord), '[]'::jsonb)
    FROM (
      SELECT entry, ord FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(${workbenches.settings} -> 'boxStarts') = 'array'
          THEN ${workbenches.settings} -> 'boxStarts' ELSE '[]'::jsonb END
        || jsonb_build_array(${value}::jsonb)
      ) WITH ORDINALITY AS starts(entry, ord)
      ORDER BY ord DESC LIMIT 10
    ) AS recent
  )`;
  await db()
    .update(workbenches)
    .set({ settings: record.totalMs === null
      ? sql`coalesce(${workbenches.settings}, '{}'::jsonb) || jsonb_build_object('boxStart', ${value}::jsonb)`
      : sql`coalesce(${workbenches.settings}, '{}'::jsonb) || jsonb_build_object('boxStart', ${value}::jsonb, 'boxStarts', ${history})` })
    .where(eq(workbenches.id, workbenchId));
  if (record.totalMs !== null) {
    await recordBootMetric(workbenchId, 'box_created', {
      sandboxId: record.sandboxId, cause: record.cause, layer: record.layer, totalMs: record.totalMs,
      ...(record.warm ? { warm: true } : {}),
    }).catch((err) => console.warn(`[workbench] recording the start of ${record.sandboxId} failed:`, err));
  }
}

/** Keep the last wake of a box on the session that names it. Never throws: a wake must not fail on this. */
export async function recordSandboxWake(wake: StoredWake): Promise<void> {
  try {
    const value = JSON.stringify(wake);
    const history = sql`(
      SELECT coalesce(jsonb_agg(entry ORDER BY ord), '[]'::jsonb)
      FROM (
        SELECT entry, ord FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(${workbenches.settings} -> 'wakes') = 'array'
            THEN ${workbenches.settings} -> 'wakes' ELSE '[]'::jsonb END
          || jsonb_build_array(${value}::jsonb)
        ) WITH ORDINALITY AS wakes(entry, ord)
        ORDER BY ord DESC LIMIT 10
      ) AS recent
    )`;
    await db()
      .update(workbenches)
      .set({ settings: sql`coalesce(${workbenches.settings}, '{}'::jsonb) || jsonb_build_object('lastWake', ${value}::jsonb, 'wakes', ${history})` })
      .where(eq(workbenches.sandboxId, wake.sandboxId));
  } catch (err) {
    console.warn(`[workbench] recording the wake of sandbox ${wake.sandboxId} failed:`, err);
  }
  const endedAt = wake.ms === null ? new Date().toISOString() : new Date(Date.parse(wake.at) + wake.ms).toISOString();
  await recordSandboxBootMetric(wake.sandboxId, 'wake_end', { at: endedAt, from: wake.from, ms: wake.ms, ok: wake.ok }).catch((err) =>
    console.warn(`[workbench] recording the wake end of ${wake.sandboxId} failed:`, err));
}

/** The names of the box's steps. The dotfiles entry is not a row. */
export async function stepNames(ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ids.includes(DOTFILES_STEP_ID)) names.set(DOTFILES_STEP_ID, 'Dotfiles');
  const rowIds = ids.filter((id) => id !== DOTFILES_STEP_ID);
  if (rowIds.length === 0) return names;
  const rows = await db().select({ id: setupSteps.id, name: setupSteps.name }).from(setupSteps).where(inArray(setupSteps.id, rowIds));
  for (const r of rows) names.set(r.id, r.name);
  return names;
}

/** The step results as the box start keeps them. */
export function storedSteps(results: LearnedStepResult[], names: Map<string, string>): StoredBoxStep[] {
  return results.map((r) => ({
    id: r.id,
    name: names.get(r.id) ?? `Step ${r.id}`,
    ms: r.durationMs ?? null,
    exit: r.exitCode,
    ...(r.timedOut ? { timedOut: true } : {}),
  }));
}

// ============================================================================
// Reading
// ============================================================================

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const flag = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

function settingsOf(row: Pick<WorkbenchRow, 'settings'>): Record<string, unknown> {
  return (row.settings ?? {}) as Record<string, unknown>;
}

/** The stored start of the box the row names now. Null: none, or it is another box's. */
export function boxStartOf(row: Pick<WorkbenchRow, 'settings' | 'sandboxId'>): StoredBoxStart | null {
  const raw = settingsOf(row).boxStart as Partial<StoredBoxStart> | undefined;
  if (!raw || typeof raw !== 'object' || !row.sandboxId || raw.sandboxId !== row.sandboxId) return null;
  const cause = raw.cause === 'new' || raw.cause === 'move' || raw.cause === 'lost' || raw.cause === 'restore' ? raw.cause : null;
  return {
    sandboxId: raw.sandboxId,
    cause,
    measuredAt: text(raw.measuredAt) ?? '',
    requestedAt: text(raw.requestedAt),
    waitMs: num(raw.waitMs),
    readyMs: num(raw.readyMs),
    checkoutMs: num(raw.checkoutMs),
    prebaked: flag(raw.prebaked),
    repoSetupMs: num(raw.repoSetupMs),
    stepsMs: num(raw.stepsMs),
    setupMs: num(raw.setupMs),
    setupExit: num(raw.setupExit),
    totalMs: num(raw.totalMs),
    steps: Array.isArray(raw.steps)
      ? raw.steps.filter((s): s is StoredBoxStep => !!s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.exit === 'number')
      : [],
    layer: text(raw.layer),
    repoCommit: text(raw.repoCommit),
    userLayerPending: flag(raw.userLayerPending),
    repoLayerPending: flag(raw.repoLayerPending),
    ...(raw.warm === true ? { warm: true as const } : {}),
  };
}

/** The last wake of the box the row names now. */
export function lastWakeOf(row: Pick<WorkbenchRow, 'settings' | 'sandboxId'>): StoredWake | null {
  const raw = settingsOf(row).lastWake as Partial<StoredWake> | undefined;
  if (!raw || typeof raw !== 'object' || !row.sandboxId || raw.sandboxId !== row.sandboxId || !text(raw.at)) return null;
  return { sandboxId: raw.sandboxId, at: raw.at!, ms: num(raw.ms), from: raw.from === 'host' ? 'host' : 'storage', ok: raw.ok !== false };
}

/** One recent start of the repository, as {@link startHistoryQuery} reduces it. */
export interface StartHistoryEntry {
  at: string;
  ms: number;
  layer: string | null;
  wb: string | null;
}

/**
 * The repository's recent box starts, newest first, as four small fields each.
 * An entry from before Talyn measured the box (no `boxReadyMs`) is left out:
 * it timed only the setup script, so it would pull the median down. The total
 * is `startTotalMs`, or the sum of the parts on an entry from before it.
 */
export function startHistoryQuery(repositoryId: string) {
  const history = sql`${repositories.settings} -> 'setupTimingHistory'`;
  const ms = (key: string) => sql`round((e ->> ${key})::numeric)`;
  return db()
    .select({
      recent: sql<StartHistoryEntry[] | string | null>`(
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'at', e ->> 'measuredAt',
          'ms', coalesce(${ms('startTotalMs')}, ${ms('boxReadyMs')} + coalesce(${ms('checkoutMs')}, 0) + coalesce(${ms('totalMs')}, 0)),
          'layer', e ->> 'layer',
          'wb', e ->> 'workbenchId'
        ) ORDER BY i), '[]'::jsonb)
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${history}) = 'array' THEN ${history} ELSE '[]'::jsonb END)
          WITH ORDINALITY AS h(e, i)
        WHERE jsonb_typeof(e) = 'object' AND e ->> 'boxReadyMs' IS NOT NULL AND e ->> 'measuredAt' IS NOT NULL
      )`,
    })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
}

/** The history from {@link startHistoryQuery}'s answer. A driver may hand jsonb back as text. */
export function parseStartHistory(value: StartHistoryEntry[] | string | null | undefined): StartHistoryEntry[] {
  let list: unknown = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.flatMap((e: Partial<StartHistoryEntry>) =>
    e && typeof e.at === 'string' && typeof e.ms === 'number' && Number.isFinite(e.ms)
      ? [{ at: e.at, ms: e.ms, layer: text(e.layer), wb: text(e.wb) }]
      : [],
  );
}

// ============================================================================
// The section
// ============================================================================

const LAYER_WORDS: Record<SandboxStartLayer, { label: string; detail: string }> = {
  user: {
    label: 'Your image for this repository',
    detail: 'The image has the repository, its setup and the Setup list steps. The box checked out the branch on top.',
  },
  repo: {
    label: 'The shared image for this repository',
    detail: 'The image has the repository and its own setup. The box ran the Setup list steps itself.',
  },
  legacy: {
    label: 'An older image for this repository',
    detail: 'The image is from before Setup list images. The box ran the steps that the image does not have.',
  },
  base: {
    label: 'The base image, with a full clone',
    detail: 'No image for this repository was ready. The box cloned the repository and ran all of the setup itself.',
  },
};

const UNKNOWN_LAYER = { label: 'Not known', detail: 'The fleet did not say which image the box booted.' };

function layerOf(value: string | null | undefined): SandboxStartLayer | null {
  return value === 'user' || value === 'repo' || value === 'legacy' || value === 'base' ? value : null;
}

/** A fleet from before layers says only `goldenLayer`: its `repo` golden is what is now the legacy image. */
function fleetLayer(sandbox: FleetSandbox | null): SandboxStartLayer | null {
  if (!sandbox) return null;
  const layer = layerOf(sandbox.layer);
  if (layer) return layer;
  if (sandbox.goldenLayer === 'repo') return 'legacy';
  if (sandbox.goldenLayer === 'base') return 'base';
  return null;
}

function pendingText(user: boolean | null, repo: boolean | null): string | null {
  if (user && repo) return 'The fleet is building new images for this repository. A new box uses them when they are ready.';
  if (user) return 'The fleet is building a new image with the Setup list. A new box uses it when it is ready.';
  if (repo) return 'The fleet is building a new image of this repository. A new box uses it when it is ready.';
  return null;
}

export function imageOf(sandbox: FleetSandbox | null, stored: StoredBoxStart | null): SandboxStartImage | null {
  const layer = fleetLayer(sandbox) ?? layerOf(stored?.layer);
  const repoCommit = text(sandbox?.repoCommit) ?? stored?.repoCommit ?? null;
  const userLayerPending = flag(sandbox?.userLayerPending) ?? stored?.userLayerPending ?? null;
  const repoLayerPending = flag(sandbox?.repoLayerPending) ?? stored?.repoLayerPending ?? null;
  const stale = flag(sandbox?.goldenStale);
  if (!layer && !repoCommit && userLayerPending === null && repoLayerPending === null) return null;
  const words = layer ? LAYER_WORDS[layer] : UNKNOWN_LAYER;
  return {
    layer,
    label: words.label,
    detail: words.detail,
    repoCommit,
    // The fleet's sandbox record has no build time for the image it booted.
    builtAt: null,
    userLayerPending,
    repoLayerPending,
    pending: pendingText(userLayerPending, repoLayerPending),
    stale,
  };
}

function stepDetail(step: StoredBoxStep): string | null {
  if (step.timedOut) return 'timed out';
  return step.exit === 0 ? null : `exit ${step.exit}`;
}

export function timelineOf(stored: StoredBoxStart, layer: SandboxStartLayer | null): SandboxStartTimeline {
  const steps: SandboxStartStep[] = [];
  const wait = stored.waitMs && stored.waitMs > 0 ? stored.waitMs : null;
  if (wait) steps.push({ kind: 'capacity_wait', label: 'Waited for a free sandbox', durationMs: wait, ok: null });
  if (stored.readyMs !== null) {
    steps.push({ kind: 'box', label: 'Box started', durationMs: Math.max(0, stored.readyMs - (wait ?? 0)), ok: null });
  }
  if (stored.checkoutMs !== null) {
    const prebaked = stored.prebaked ?? (layer === 'user' || layer === 'repo' || layer === 'legacy');
    steps.push(prebaked
      ? { kind: 'checkout', label: 'Checked out the branch', durationMs: stored.checkoutMs, ok: null }
      : { kind: 'clone', label: 'Cloned the repository', durationMs: stored.checkoutMs, ok: null });
  }
  // With no Setup list step on the box, the setup has no timing line: the whole script is the repository's own setup.
  const repoSetupMs = stored.repoSetupMs ?? (stored.steps.length === 0 ? stored.setupMs : null);
  if (repoSetupMs !== null) {
    const failed = stored.setupExit !== null && stored.setupExit !== 0;
    steps.push({
      kind: 'repository_setup',
      label: 'Repository setup',
      durationMs: repoSetupMs,
      ok: stored.setupExit === null ? null : !failed,
      ...(failed ? { detail: `exit ${stored.setupExit}` } : {}),
    });
  }
  if (stored.steps.length > 0) {
    steps.push({
      kind: 'box_steps',
      label: 'Setup list steps',
      durationMs: stored.stepsMs,
      ok: stored.steps.every((s) => s.exit === 0),
    });
    for (const step of stored.steps) {
      const detail = stepDetail(step);
      steps.push({ kind: 'setup_step', label: step.name, durationMs: step.ms, ok: step.exit === 0, ...(detail ? { detail } : {}) });
    }
  }
  if (stored.totalMs !== null) steps.push({ kind: 'ready', label: 'Ready', durationMs: stored.totalMs, ok: null });
  return {
    sandboxId: stored.sandboxId,
    cause: stored.cause,
    requestedAt: stored.requestedAt,
    totalMs: stored.totalMs,
    capacityWaitMs: wait,
    steps,
  };
}

function wakeOf(wake: StoredWake | null): SandboxWake | null {
  if (!wake) return null;
  const time = wake.ms === null ? '' : ` in ${formatDurationMs(wake.ms)}`;
  const after = wake.ms === null ? '' : ` after ${formatDurationMs(wake.ms)}`;
  const words = wake.ok
    ? wake.from === 'storage' ? `Restored from storage${time}.` : `Woke on its host${time}.`
    : wake.from === 'storage' ? `A restore from storage failed${after}.` : `A wake failed${after}.`;
  return { at: wake.at, durationMs: wake.ms, from: wake.from, ok: wake.ok, text: words };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** The recent starts shown, newest first. */
const RECENT_SHOWN = 5;

export interface BoxStartInput {
  row: WorkbenchRow;
  /** The fleet's record, when it answered. */
  sandbox: FleetSandbox | null;
  /** The repository's recent starts. Null: not read. */
  history: StartHistoryEntry[] | null;
}

/** The section, from facts already read. Null: the session has no sandbox to describe. */
export function describeBoxStart({ row, sandbox, history }: BoxStartInput): SandboxStartInfo | null {
  if (row.runtime !== 'sandbox' || row.kind === 'thread' || row.archivedAt || row.status === 'archived') return null;
  const stored = boxStartOf(row);
  const image = imageOf(sandbox, stored);
  const timeline = stored ? timelineOf(stored, image?.layer ?? null) : null;
  const entries = history ?? [];
  const recent: SandboxRecentStart[] = entries.slice(0, RECENT_SHOWN).map((e) => ({
    at: e.at,
    totalMs: e.ms,
    layer: layerOf(e.layer),
    thisSession: e.wb === row.id,
  }));
  const others = entries.filter((e) => !(stored && e.wb === row.id && e.at === stored.measuredAt)).map((e) => e.ms);
  const medianMs = others.length >= SANDBOX_START_MEDIAN_MIN ? median(others) : null;
  const total = timeline?.totalMs ?? null;
  let comparison: string | null = null;
  let slow = false;
  if (medianMs !== null) {
    comparison = total !== null
      ? `This start took ${formatDurationMs(total)}. The median start for this repository is ${formatDurationMs(medianMs)}.`
      : `The median start for this repository is ${formatDurationMs(medianMs)}.`;
    slow = total !== null && total >= medianMs * SANDBOX_SLOW_START_FACTOR && total - medianMs >= SANDBOX_SLOW_START_MIN_EXTRA_MS;
  }
  let note: string | null = null;
  if (!stored) {
    note = row.status === 'provisioning' || row.status === 'moving'
      ? 'Talyn shows the start times when the box is ready.'
      : 'Talyn has no start times for this box. A box that started before Talyn kept them has none.';
  } else if (row.status === 'provisioning' && stored.totalMs === null) {
    note = 'The setup is running. Talyn adds its times when it ends.';
  }
  return { image, timeline, lastWake: wakeOf(lastWakeOf(row)), recent, medianMs, comparison, slow, note };
}
