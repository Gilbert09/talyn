import {
  CODE_REVIEW_REPORTING_BAR,
  DEFAULT_CODE_REVIEW_PRESET,
  isCodeReviewPreset,
  isCodeReviewSeverity,
  resolveCodeReviewSettings,
  type CodeReviewPreset,
  type CodeReviewSeverity,
} from '@talyn/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { workspaces as workspacesTable } from '../../db/schema.js';

/**
 * A workspace's review posture, read from its settings blob.
 *
 * A LEAF module on purpose. These four reads used to live in `cycle.ts`, next to
 * starting and cancelling a cycle — so anything that merely wanted to know a
 * workspace's reporting bar had to import the module that starts reviews, which
 * pulls in the evaluator, the executor and the fix run. That closed a genuine
 * import cycle the first time something outside this directory needed a setting
 * (the mergeable prompt, reading the findings a fix run should be told about).
 * `cycle.ts` re-exports them, so nothing else had to move.
 */

async function readSettings(workspaceId: string) {
  // Projects the settings column alone — `workspaces.logo` is an inline data URL
  // and must never ship on a dispatch path.
  const rows = await getDbClient()
    .select({ settings: workspacesTable.settings })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  const settings = rows[0]?.settings as { codeReview?: unknown } | null;
  return (settings?.codeReview ?? null) as Parameters<typeof resolveCodeReviewSettings>[0];
}

/** The workspace's chosen depth, or the default. */
export async function workspacePreset(workspaceId: string): Promise<CodeReviewPreset> {
  const settings = await readSettings(workspaceId);
  const resolved = resolveCodeReviewSettings(settings);
  return isCodeReviewPreset(resolved.preset) ? resolved.preset : DEFAULT_CODE_REVIEW_PRESET;
}

/** The workspace's full review posture, for the fix run and the auto sweep. */
export async function workspaceReviewSettings(workspaceId: string) {
  return resolveCodeReviewSettings(await readSettings(workspaceId));
}

/**
 * Each workspace's display bar, in one query.
 *
 * Extracts the one scalar with a jsonb accessor and never ships the settings
 * blob — the egress rule that `getMergeQueueMode` follows for the same reason:
 * this is read while building a whole page of pull-request payloads, and the
 * blob it lives in carries every other workspace setting there is.
 */
export async function reportingBarsFor(
  workspaceIds: string[]
): Promise<Map<string, CodeReviewSeverity>> {
  const out = new Map<string, CodeReviewSeverity>();
  if (!workspaceIds.length) return out;
  const rows = await getDbClient()
    .select({
      id: workspacesTable.id,
      bar: sql<string | null>`${workspacesTable.settings} -> 'codeReview' ->> 'reportingBar'`,
    })
    .from(workspacesTable)
    .where(inArray(workspacesTable.id, workspaceIds));
  for (const row of rows) {
    out.set(row.id, isCodeReviewSeverity(row.bar) ? row.bar : CODE_REVIEW_REPORTING_BAR);
  }
  return out;
}

export async function workspaceOwner(workspaceId: string): Promise<string> {
  const rows = await getDbClient()
    .select({ ownerId: workspacesTable.ownerId })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  const ownerId = rows[0]?.ownerId;
  if (!ownerId) throw new Error(`workspace ${workspaceId} has no owner`);
  return ownerId;
}
