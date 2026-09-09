import { eq } from 'drizzle-orm';
import {
  defaultFleetModelForAgent,
  fleetAgentForModel,
  type FleetAgent,
  type WorkspaceSettings,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { workspaces as workspacesTable } from '../../db/schema.js';

/**
 * Learning, at run time, that a vendor has withdrawn a model from under us.
 *
 * OpenAI removes models from the CHATGPT SIGN-IN path on its own schedule while
 * leaving them on the API-key path — the id keeps existing, the subscription
 * just stops being entitled to it. There is no endpoint that reports this:
 * `GET /v1/models` answers for a KEY, and the fleet runs on the user's own
 * subscription. The only place the truth appears is the failure itself.
 *
 * So the failure is the feed. Every Codex run under a withdrawn model dies with
 * OpenAI's own sentence; we read the id out of it, stop dispatching at it, and
 * move the workspace's stored choice onto something that runs. Before this, the
 * catalogue could only be corrected by a human noticing and a deploy going out
 * — and in the meantime every single Codex run failed.
 *
 * This is the same shape as `repoMergeGate` and its siblings: a fact the vendor
 * will not tell us, learned by observation and held in memory. Unlike those, it
 * also writes — see `migrateWorkspaceOff` — because a stored model that cannot
 * run is not a preference worth preserving.
 */

/**
 * OpenAI's verbatim sentence. Pinned deliberately: a looser match ("not
 * supported") would also catch a model that is merely wrong for the request,
 * and withdrawing an id the vendor never withdrew is worse than missing one.
 */
const WITHDRAWN_RE =
  /The '([^']+)' model is not supported when using Codex with a ChatGPT account/i;

/** Ids observed to be withdrawn this process. Empty at boot; re-earned. */
const withdrawn = new Set<string>();

/**
 * The model id a failure blames, or null when the failure is about anything
 * else. One-sided on purpose — anything unrecognised is left alone.
 */
export function withdrawnModelFrom(detail: string | null | undefined): string | null {
  if (typeof detail !== 'string') return null;
  return WITHDRAWN_RE.exec(detail)?.[1]?.trim() || null;
}

/** Whether this id has already been observed to be withdrawn. */
export function isWithdrawnModel(modelId: string | undefined): boolean {
  return typeof modelId === 'string' && withdrawn.has(modelId);
}

/**
 * What to run instead. The vendor's default rather than a like-for-like tier:
 * we have just learned the catalogue is wrong, so the only id we still have
 * grounds to trust for that agent is the one we ship as the floor.
 */
export function replacementFor(modelId: string): string {
  const agent: FleetAgent = fleetAgentForModel(modelId);
  return defaultFleetModelForAgent(agent);
}

/**
 * Record a withdrawal and move the workspace off it.
 *
 * The in-memory set stops the NEXT dispatch cheaply; the settings write is what
 * makes the fix outlive this process. Both are needed: without the write the
 * fix dies at the next deploy, and without the set a task or environment that
 * pins the id directly would keep burning runs.
 *
 * Best-effort by construction — this runs on the failure path of a task that
 * has already failed, and throwing here would replace a useful error with a
 * useless one.
 */
export async function noteWithdrawnModel(
  workspaceId: string,
  modelId: string,
): Promise<void> {
  const first = !withdrawn.has(modelId);
  withdrawn.add(modelId);
  if (first) {
    console.warn(
      `[selfhosted] the vendor has withdrawn "${modelId}" from the subscription path — ` +
        `falling back to "${replacementFor(modelId)}" and migrating workspaces off it`,
    );
  }
  try {
    await migrateWorkspaceOff(workspaceId, modelId);
  } catch (err) {
    console.warn(`[selfhosted] could not migrate workspace ${workspaceId} off ${modelId}:`, err);
  }
}

/**
 * Rewrite this workspace's stored choice, if it is the dead id.
 *
 * Touches BOTH `fleetModel` and the per-agent `fleetModels` entry: they are two
 * places the same choice can live, and leaving either one pointing at a model
 * that cannot run just reproduces the failure from the other direction.
 */
async function migrateWorkspaceOff(workspaceId: string, modelId: string): Promise<void> {
  const db = getDbClient();
  const [row] = await db
    .select({ settings: workspacesTable.settings })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  const settings = (row?.settings ?? null) as WorkspaceSettings | null;
  if (!settings) return;

  const agent: FleetAgent = fleetAgentForModel(modelId);
  const replacement = replacementFor(modelId);

  const next: WorkspaceSettings = { ...settings };
  let changed = false;

  if (settings.fleetModel === modelId) {
    next.fleetModel = replacement as WorkspaceSettings['fleetModel'];
    changed = true;
  }
  if (settings.fleetModels?.[agent] === modelId) {
    next.fleetModels = {
      ...settings.fleetModels,
      [agent]: replacement as NonNullable<WorkspaceSettings['fleetModels']>[FleetAgent],
    };
    changed = true;
  }
  if (!changed) return;

  await db
    .update(workspacesTable)
    .set({ settings: next, updatedAt: new Date() })
    .where(eq(workspacesTable.id, workspaceId));
  console.warn(
    `[selfhosted] workspace ${workspaceId.slice(0, 8)}: moved ${modelId} -> ${replacement}`,
  );
}

/** Test seam. */
export function _resetWithdrawnModels(): void {
  withdrawn.clear();
}
