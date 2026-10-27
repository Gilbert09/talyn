import { eligiblePr, linkedBeforeMerge } from './prEligibility.js';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import { pullRequests, workbenches } from '../../db/schema.js';
import { archiveWorkbench } from './lifecycle.js';

type MergeArchiveInput =
  | { repoFullName: string; number: number; workspaceIds?: string[]; mergedAt?: Date | null }
  | { workbenchId: string };

/** One entry point for the merge rule and its deferred completion. */
export async function autoArchiveForMergedPr(input: MergeArchiveInput): Promise<void> {
  const db = getPoolDbClient();
  let ids: string[];
  if ('workbenchId' in input) {
    const rows = await db.select({ id: workbenches.id }).from(workbenches).where(and(
      eq(workbenches.id, input.workbenchId), isNull(workbenches.archivedAt),
      sql`${workbenches.settings} ->> 'archiveOnIdle' IS NOT NULL`,
      sql`EXISTS (SELECT 1 FROM ${pullRequests} WHERE ${pullRequests.id} = ${workbenches.pullRequestId}
        AND ${eligiblePr()} AND ${linkedBeforeMerge()})`,
    ));
    ids = rows.map((row) => row.id);
  } else {
    if (input.workspaceIds?.length === 0) return;
    const [owner, repo] = input.repoFullName.toLowerCase().split('/');
    if (!owner || !repo) return;
    const key = `${owner}/${repo}#${input.number}`;
    const mergeTime = input.mergedAt ? sql`${input.mergedAt.toISOString()}::timestamptz` : sql`${pullRequests.mergedAt}`;
    const matches = await db.select({ id: workbenches.id, pullRequestId: pullRequests.id }).from(pullRequests)
      .innerJoin(workbenches, eq(workbenches.pullRequestId, pullRequests.id))
      .where(and(
        sql`lower(${pullRequests.owner}) = ${owner}`,
        sql`lower(${pullRequests.repo}) = ${repo}`,
        eq(pullRequests.number, input.number), isNull(workbenches.archivedAt),
        eligiblePr(), linkedBeforeMerge(mergeTime),
        input.workspaceIds ? inArray(workbenches.workspaceId, input.workspaceIds) : undefined,
        sql`NOT (COALESCE(${workbenches.settings} -> 'autoArchivedForPr', '[]'::jsonb) ? ${key})`,
      ));
    ids = [];
    for (const match of matches) {
      // Commit the gate before checking chats. Turn claims share-lock this row.
      const marked = await db.update(workbenches).set({
        settings: sql`${workbenches.settings} || jsonb_build_object('archiveOnIdle', ${key}::text)`,
      }).where(and(
        eq(workbenches.id, match.id), eq(workbenches.pullRequestId, match.pullRequestId), isNull(workbenches.archivedAt),
        sql`NOT (COALESCE(${workbenches.settings} -> 'autoArchivedForPr', '[]'::jsonb) ? ${key})`,
        sql`EXISTS (SELECT 1 FROM ${pullRequests} WHERE ${pullRequests.id} = ${workbenches.pullRequestId}
          AND ${eligiblePr()} AND ${linkedBeforeMerge(mergeTime)})`,
      )).returning({ id: workbenches.id });
      ids.push(...marked.map((row) => row.id));
    }
  }
  for (const id of ids) await archiveWorkbench(id, { autoForMergedPr: true });
}

/** Recover a crash between the last turn and the archive through the existing sweep. */
export async function sweepMergeArchives(): Promise<void> {
  const rows = await getPoolDbClient().select({ id: workbenches.id }).from(workbenches).where(and(
    isNull(workbenches.archivedAt), sql`${workbenches.settings} ->> 'archiveOnIdle' IS NOT NULL`,
    sql`NOT EXISTS (SELECT 1 FROM workbench_chats c WHERE c.workbench_id = ${workbenches.id} AND c.status = 'running')`,
  )).limit(100);
  for (const row of rows) await autoArchiveForMergedPr({ workbenchId: row.id });
}
