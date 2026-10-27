import { sql, type SQL } from 'drizzle-orm';
import { pullRequests, workbenches } from '../../db/schema.js';

/** A branch name alone does not prove that a session owns a PR. */
export function eligiblePr(createdAt: SQL = sql`${workbenches.createdAt}`, pushed: SQL = sql`${workbenches.pushedHeadShas}`): SQL {
  const summary = pullRequests.lastSummary;
  return sql`COALESCE((
    ((NULLIF(${summary} ->> 'createdAt', '')::timestamptz >= ${createdAt} - interval '2 minutes')
      OR (${summary} ->> 'headSha') = ANY(${pushed}))
    AND (${pullRequests.mergedAt} IS NULL OR ${pullRequests.mergedAt} >= ${createdAt})
    AND (${pullRequests.state} <> 'merged' OR ${pullRequests.mergedAt} IS NOT NULL)
    AND (${pullRequests.state} <> 'closed' OR NULLIF(${summary} ->> 'closedAt', '')::timestamptz >= ${createdAt})
  ), false)`;
}

export function linkedBeforeMerge(mergedAt: SQL = sql`${pullRequests.mergedAt}`): SQL {
  return sql`${workbenches.pullRequestLinkedAt} < ${mergedAt} AND ${workbenches.createdAt} <= ${mergedAt}`;
}
