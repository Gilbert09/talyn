import { eligiblePr } from './prEligibility.js';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { prSummaryToNextActionPr, type Workbench, type WorkbenchPullRequestSummary } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { pullRequests as prTable, workbenches } from '../../db/schema.js';
import { openChatsByWorkbench, rowToChat, rowToWorkbench, getWorkbench, type WorkbenchRow } from './store.js';

/**
 * The pull request opened from a workbench's branch, and the summary the
 * header's next-action button reads.
 *
 * Every read here is a narrow projection with SQL accessors into
 * `last_summary`: that blob is ~2KB per PR and these run on every GET and after
 * every turn, so shipping it to read three fields is the egress regression
 * CLAUDE.md warns about.
 */

const PR_SUMMARY_COLUMNS = {
  id: prTable.id,
  owner: prTable.owner,
  repo: prTable.repo,
  number: prTable.number,
  state: prTable.state,
  mergeable: sql<string | null>`${prTable.lastSummary} ->> 'mergeable'`,
  ciStatus: sql<string | null>`${prTable.lastSummary} ->> 'ciStatus'`,
} as const;

type PrSummaryRow = {
  id: string;
  owner: string;
  repo: string;
  number: number;
  state: string;
  mergeable: string | null;
  ciStatus: string | null;
};

/**
 * The PR row as the header's next-action button reads it, through the shared
 * mapping. A PR with no check verdict yet reads as pending: the summary has no
 * absent value, and waiting is the safe answer.
 */
export function toPrSummary(row: PrSummaryRow): WorkbenchPullRequestSummary {
  const { state, mergeable = 'unknown', ciStatus = 'pending' } = prSummaryToNextActionPr(row);
  return {
    number: row.number,
    url: `https://github.com/${row.owner}/${row.repo}/pull/${row.number}`,
    state,
    mergeable,
    ciStatus,
  };
}

/** The query that finds a branch's PR, exposed for the egress test. */
export function findBranchPrQuery(workspaceId: string, repositoryId: string, branch: string, excludedNumber?: number, createdAt = new Date(), pushedHeadShas: string[] = []) {
  return getPoolDbClient()
    .select({ id: prTable.id })
    .from(prTable)
    .where(
      and(
        eq(prTable.workspaceId, workspaceId),
        eq(prTable.repositoryId, repositoryId),
        eligiblePr(sql`${createdAt.toISOString()}::timestamptz`, sql`ARRAY[${sql.join(pushedHeadShas.map((sha) => sql`${sha}`), sql`, `)}]::text[]`),
        excludedNumber === undefined ? undefined : ne(prTable.number, excludedNumber),
        sql`${prTable.lastSummary} ->> 'headBranch' = ${branch}`,
      ),
    )
    // An open PR beats a closed one for the same branch name; then the newest.
    .orderBy(sql`(${prTable.state} = 'open') DESC`, desc(prTable.number))
    .limit(1);
}

/**
 * Link the workbench to the PR whose head is its branch, when one exists in
 * this workspace. Returns the row (updated or not). Never unlinks: a PR that
 * stopped matching (the branch was renamed) is still the PR this work opened.
 */
export async function linkPullRequest(row: WorkbenchRow): Promise<WorkbenchRow> {
  if (row.pullRequestId) return row;
  const found = (await findBranchPrQuery(row.workspaceId, row.repositoryId, row.branch, row.settings?.prUnlinked, row.createdAt, row.pushedHeadShas))[0];
  if (!found) return row;
  const [linked] = await getPoolDbClient().update(workbenches).set({ pullRequestId: found.id, updatedAt: new Date() })
    .where(and(eq(workbenches.id, row.id), eq(workbenches.branch, row.branch), sql`${workbenches.pullRequestId} IS NULL`,
      sql`EXISTS (SELECT 1 FROM ${prTable} WHERE ${prTable.id} = ${found.id} AND ${eligiblePr()})`,
    )).returning({ id: workbenches.id });
  return linked ? (await getWorkbench(row.id)) ?? row : row;
}

export async function prSummaries(ids: string[]): Promise<Map<string, WorkbenchPullRequestSummary>> {
  const out = new Map<string, WorkbenchPullRequestSummary>();
  if (ids.length === 0) return out;
  const rows = await getPoolDbClient()
    .select(PR_SUMMARY_COLUMNS)
    .from(prTable)
    .where(inArray(prTable.id, ids));
  for (const r of rows) out.set(r.id, toPrSummary(r));
  return out;
}

/** What went wrong, when the workbench or its sandbox is in an error state. */
function errorOf(row: WorkbenchRow): string | null {
  return row.status === 'error' || row.sandboxState === 'error' ? row.statusMessage ?? 'Something went wrong.' : null;
}

/**
 * A workbench as the API returns it: the row, its open chats, its PR summary
 * when linked, and `error` when it failed.
 */
export async function publicWorkbench(row: WorkbenchRow): Promise<Workbench> {
  return (await publicWorkbenches([row]))[0];
}

/** Two queries for any number of rows: the open chats and the PR summaries. */
export async function publicWorkbenches(rows: WorkbenchRow[]): Promise<Workbench[]> {
  const [prs, chats] = await Promise.all([
    prSummaries(rows.map((r) => r.pullRequestId).filter((id): id is string => Boolean(id))),
    openChatsByWorkbench(rows.map((r) => r.id)),
  ]);
  return rows.map((r) => ({
    ...rowToWorkbench(r),
    pr: r.pullRequestId ? prs.get(r.pullRequestId) ?? null : null,
    error: errorOf(r),
    chats: (chats.get(r.id) ?? []).map(rowToChat),
  }));
}
