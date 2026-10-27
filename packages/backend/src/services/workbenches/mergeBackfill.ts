import { and, eq, isNull, sql } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import { pullRequests, workbenches } from '../../db/schema.js';
import { autoArchiveForMergedPr } from './autoArchive.js';
import { emitWorkbenchUpdated } from './emit.js';
import { withMaintenanceClaim } from './maintenanceClaim.js';
import { eligiblePr, linkedBeforeMerge } from './prEligibility.js';
import { publicWorkbench } from './prLink.js';
import { getWorkbench } from './store.js';

export const MERGE_BACKFILL_POLLER = 'workbench-merge-backfill';

export async function backfillMergeArchives(): Promise<boolean> {
  return withMaintenanceClaim(MERGE_BACKFILL_POLLER, async (renew) => {
    const db = getPoolDbClient();
    // Repeatable cleanup also repairs stale links written by an older backend.
    const wrong = await db.select({ id: workbenches.id, prId: workbenches.pullRequestId }).from(workbenches)
      .innerJoin(pullRequests, eq(pullRequests.id, workbenches.pullRequestId)).where(sql`NOT ${eligiblePr()}`);
    for (const row of wrong) {
      await renew();
      await db.update(workbenches).set({ pullRequestId: null, updatedAt: new Date() }).where(and(
        eq(workbenches.id, row.id), eq(workbenches.pullRequestId, row.prId!),
        sql`EXISTS (SELECT 1 FROM ${pullRequests} WHERE ${pullRequests.id} = ${workbenches.pullRequestId} AND NOT ${eligiblePr()})`,
      ));
      const updated = await getWorkbench(row.id);
      if (updated) await emitWorkbenchUpdated(await publicWorkbench(updated));
    }
    const merged = await db.select({ owner: pullRequests.owner, repo: pullRequests.repo, number: pullRequests.number,
      workspaceId: workbenches.workspaceId }).from(workbenches)
      .innerJoin(pullRequests, eq(pullRequests.id, workbenches.pullRequestId))
      .where(and(isNull(workbenches.archivedAt), eq(pullRequests.state, 'merged'), eligiblePr(), linkedBeforeMerge(),
        sql`NOT (COALESCE(${workbenches.settings} -> 'autoArchivedForPr', '[]'::jsonb)
          ? (lower(${pullRequests.owner}) || '/' || lower(${pullRequests.repo}) || '#' || ${pullRequests.number}::text))`));
    for (const row of merged) {
      await renew();
      await autoArchiveForMergedPr({ repoFullName: `${row.owner}/${row.repo}`, number: row.number, workspaceIds: [row.workspaceId] });
    }
  });
}
