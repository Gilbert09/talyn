import { and, asc, desc, eq, isNull, notInArray, sql } from 'drizzle-orm';
import type { CodeReviewPublic } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import {
  mergeQueueEntries as entriesTable,
  pullRequests as prTable,
  workbenches as workbenchesTable,
} from '../../db/schema.js';
import { computeEntryPositions, TERMINAL_STATUSES } from '../mergeQueue/store.js';
import type { ApiTokenPrincipal } from '../apiTokens.js';
import { authorizeWorkspace } from './authorize.js';
import { afterCursor, cursorTimeColumn, type ListCursor } from './cursor.js';
import { notFound } from './errors.js';

/**
 * Pull requests and the merge queue, as `/v1` reads and sends them.
 *
 * `pull_requests.last_summary` is a ~2 KB jsonb blob and `body` is the PR
 * description. Neither is ever selected whole here: each GitHub fact the API
 * sends is read out of the summary in SQL (`last_summary ->> 'title'`), so only
 * the values leave the database. The `.toSQL()` tests in
 * `publicPullRequests.test.ts` hold this.
 */

const db = () => getPoolDbClient();
const summary = prTable.lastSummary;

const text = (key: string) => sql<string | null>`${summary} ->> ${sql.raw(`'${key}'`)}`;
const int = (path: string) => sql<number | null>`(${summary} #>> ${sql.raw(`'{${path}}'`)})::int`;
const bool = (key: string) => sql<boolean | null>`(${summary} ->> ${sql.raw(`'${key}'`)})::boolean`;

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export const PUBLIC_PR_COLUMNS = {
  id: prTable.id,
  workspaceId: prTable.workspaceId,
  repositoryId: prTable.repositoryId,
  owner: prTable.owner,
  repo: prTable.repo,
  number: prTable.number,
  state: prTable.state,
  authored: prTable.authored,
  reviewRequested: prTable.reviewRequested,
  watching: prTable.watching,
  reviewHiddenAt: prTable.reviewHiddenAt,
  autoKeepMergeable: prTable.autoKeepMergeable,
  mergedAt: prTable.mergedAt,
  lastPolledAt: prTable.lastPolledAt,
  createdAt: prTable.createdAt,
  updatedAt: prTable.updatedAt,
  title: text('title'),
  url: text('url'),
  author: text('author'),
  authorIsBot: bool('prAuthorIsBot'),
  draft: bool('draft'),
  headBranch: text('headBranch'),
  baseBranch: text('baseBranch'),
  headSha: text('headSha'),
  openedAt: text('createdAt'),
  additions: int('additions'),
  deletions: int('deletions'),
  changedFiles: int('changedFiles'),
  ciStatus: text('ciStatus'),
  blockingReason: text('blockingReason'),
  mergeable: text('mergeable'),
  mergeStateStatus: text('mergeStateStatus'),
  reviewDecision: text('reviewDecision'),
  effectiveReviewDecision: text('effectiveReviewDecision'),
  unresolvedReviewThreads: int('unresolvedReviewThreads'),
  checksTotal: int('checks,total'),
  checksPassed: int('checks,passed'),
  checksFailed: int('checks,failed'),
  checksInProgress: int('checks,inProgress'),
  checksSkipped: int('checks,skipped'),
  // A short array (a gate per failing human check), never the summary.
  humanGates: sql<unknown>`${summary} -> 'humanGates'`,
  cursorTime: cursorTimeColumn(prTable.createdAt),
} as const;

export interface PublicPullRequestRow {
  id: string;
  workspaceId: string;
  repositoryId: string;
  owner: string;
  repo: string;
  number: number;
  state: string;
  authored: boolean;
  reviewRequested: boolean;
  watching: boolean;
  reviewHiddenAt: Date | null;
  autoKeepMergeable: boolean;
  mergedAt: Date | null;
  lastPolledAt: Date;
  createdAt: Date;
  updatedAt: Date;
  title: string | null;
  url: string | null;
  author: string | null;
  authorIsBot: boolean | null;
  draft: boolean | null;
  headBranch: string | null;
  baseBranch: string | null;
  headSha: string | null;
  openedAt: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  ciStatus: string | null;
  blockingReason: string | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  effectiveReviewDecision: string | null;
  unresolvedReviewThreads: number | null;
  checksTotal: number | null;
  checksPassed: number | null;
  checksFailed: number | null;
  checksInProgress: number | null;
  checksSkipped: number | null;
  humanGates: unknown;
}

export interface PrListFilter {
  state: 'open' | 'closed' | 'merged' | 'all';
  relationship?: 'authored' | 'review_requested' | 'watching';
  repositoryId?: string;
  mergeQueued?: boolean;
}

export function listPullRequestsQuery(workspaceId: string, filter: PrListFilter, cursor: ListCursor | null, limit: number) {
  const relationship =
    filter.relationship === 'authored'
      ? eq(prTable.authored, true)
      : filter.relationship === 'review_requested'
        ? eq(prTable.reviewRequested, true)
        : filter.relationship === 'watching'
          ? eq(prTable.watching, true)
          : undefined;
  return db()
    .select(PUBLIC_PR_COLUMNS)
    .from(prTable)
    .where(
      and(
        eq(prTable.workspaceId, workspaceId),
        filter.state === 'all' ? undefined : eq(prTable.state, filter.state),
        relationship,
        filter.repositoryId ? eq(prTable.repositoryId, filter.repositoryId) : undefined,
        filter.mergeQueued === undefined ? undefined : eq(prTable.mergeQueued, filter.mergeQueued),
        afterCursor(prTable.createdAt, prTable.id, cursor),
      ),
    )
    .orderBy(desc(prTable.createdAt), desc(prTable.id))
    .limit(limit + 1);
}

export function getPullRequestQuery(id: string) {
  return db().select(PUBLIC_PR_COLUMNS).from(prTable).where(eq(prTable.id, id)).limit(1);
}

/** The cached description, the one read of `pull_requests.body`. */
export function getPullRequestDescriptionQuery(id: string) {
  return db().select({ id: prTable.id, body: prTable.body }).from(prTable).where(eq(prTable.id, id)).limit(1);
}

/**
 * What the write paths hand to the services (`setQueueMembership`,
 * `setAutoKeepMergeable`, `refreshPullRequest`). One row, so the summary is
 * read whole here: the services emit it to the app's clients.
 */
export const PR_WRITE_COLUMNS = {
  id: prTable.id,
  workspaceId: prTable.workspaceId,
  repositoryId: prTable.repositoryId,
  taskId: prTable.taskId,
  owner: prTable.owner,
  repo: prTable.repo,
  number: prTable.number,
  state: prTable.state,
  lastSummary: prTable.lastSummary,
  mergeQueued: prTable.mergeQueued,
  mergeQueuedAt: prTable.mergeQueuedAt,
  mergeMethod: prTable.mergeMethod,
} as const;

export type PrWriteRow = Pick<typeof prTable.$inferSelect, keyof typeof PR_WRITE_COLUMNS>;

export function getPullRequestWriteRowQuery(id: string) {
  return db().select(PR_WRITE_COLUMNS).from(prTable).where(eq(prTable.id, id)).limit(1);
}

/** The workspace of a pull request, checked against the token. 404 when out of reach. */
async function authorizePrWorkspace(token: ApiTokenPrincipal, workspaceId: string): Promise<void> {
  try {
    await authorizeWorkspace(token, workspaceId);
  } catch {
    throw notFound('pull_request');
  }
}

export async function authorizedPullRequest(token: ApiTokenPrincipal, id: string): Promise<PublicPullRequestRow> {
  const [row] = await getPullRequestQuery(id);
  if (!row) throw notFound('pull_request');
  await authorizePrWorkspace(token, row.workspaceId);
  return row;
}

export async function authorizedPullRequestForWrite(token: ApiTokenPrincipal, id: string): Promise<PrWriteRow> {
  const [row] = await getPullRequestWriteRowQuery(id);
  if (!row) throw notFound('pull_request');
  await authorizePrWorkspace(token, row.workspaceId);
  return row;
}

/** Live (not archived) sessions on a pull request, most recently updated first. */
export function liveSessionIdsQuery(workspaceId: string, pullRequestId: string) {
  return db()
    .select({ id: workbenchesTable.id })
    .from(workbenchesTable)
    .where(
      and(
        eq(workbenchesTable.workspaceId, workspaceId),
        eq(workbenchesTable.pullRequestId, pullRequestId),
        isNull(workbenchesTable.archivedAt),
      ),
    )
    .orderBy(desc(workbenchesTable.updatedAt));
}

// ---------------------------------------------------------------------------
// Merge queue
// ---------------------------------------------------------------------------

/**
 * The entry columns the API sends. Not `ENTRY_COLUMNS`: that carries the
 * engine's bookkeeping (`seen_signatures`, budgets, fix-run ids), and none of
 * it leaves `/v1`.
 */
export const PUBLIC_QUEUE_ENTRY_COLUMNS = {
  id: entriesTable.id,
  pullRequestId: entriesTable.pullRequestId,
  repositoryId: entriesTable.repositoryId,
  baseBranch: entriesTable.baseBranch,
  mergeMethod: entriesTable.mergeMethod,
  status: entriesTable.status,
  blockedCode: entriesTable.blockedCode,
  blockedReason: entriesTable.blockedReason,
  headSha: entriesTable.headSha,
  automergeArmedBy: entriesTable.automergeArmedBy,
  externalState: entriesTable.externalState,
  enqueuedAt: entriesTable.enqueuedAt,
  owner: prTable.owner,
  repo: prTable.repo,
  number: prTable.number,
  title: text('title'),
} as const;

export interface PublicQueueEntryRow {
  id: string;
  pullRequestId: string;
  repositoryId: string;
  baseBranch: string;
  mergeMethod: string;
  status: string;
  blockedCode: string | null;
  blockedReason: string | null;
  headSha: string;
  automergeArmedBy: string | null;
  externalState: string | null;
  enqueuedAt: Date;
  owner: string;
  repo: string;
  number: number;
  title: string | null;
}

/** Every active entry of a workspace, oldest first: the order positions are counted in. */
export function activeQueueEntriesQuery(workspaceId: string) {
  return db()
    .select(PUBLIC_QUEUE_ENTRY_COLUMNS)
    .from(entriesTable)
    .innerJoin(prTable, eq(prTable.id, entriesTable.pullRequestId))
    .where(and(eq(entriesTable.workspaceId, workspaceId), notInArray(entriesTable.status, TERMINAL_STATUSES)))
    .orderBy(asc(entriesTable.enqueuedAt), asc(entriesTable.id));
}

export interface QueueSnapshot {
  entries: PublicQueueEntryRow[];
  positions: Map<string, number>;
  byPullRequest: Map<string, PublicQueueEntryRow>;
}

export async function workspaceQueue(workspaceId: string): Promise<QueueSnapshot> {
  const entries = await activeQueueEntriesQuery(workspaceId);
  return {
    entries,
    positions: computeEntryPositions(entries),
    byPullRequest: new Map(entries.map((e) => [e.pullRequestId, e])),
  };
}

const METHODS = new Set(['squash', 'merge', 'rebase']);

export function toPublicMergeQueueState(entry: PublicQueueEntryRow, position: number) {
  return {
    status: entry.status,
    position,
    method: (METHODS.has(entry.mergeMethod) ? entry.mergeMethod : 'squash') as 'squash' | 'merge' | 'rebase',
    base_branch: entry.baseBranch,
    head_sha: entry.headSha || null,
    blocked_code: entry.blockedCode ?? null,
    blocked_reason: entry.blockedReason ?? null,
    auto_merge_armed: entry.automergeArmedBy !== null,
    // `pending_failure` goes out as `testing`, as the app shows it (see mergeQueue/legacy.ts).
    external_state: entry.externalState === 'pending_failure' ? 'testing' : (entry.externalState ?? null),
    enqueued_at: entry.enqueuedAt.toISOString(),
  };
}

export function toPublicMergeQueueEntry(entry: PublicQueueEntryRow, position: number) {
  return {
    object: 'merge_queue_entry' as const,
    pull_request_id: entry.pullRequestId,
    repository_id: entry.repositoryId,
    repository_full_name: `${entry.owner}/${entry.repo}`,
    number: entry.number,
    title: entry.title ?? null,
    ...toPublicMergeQueueState(entry, position),
  };
}

export function toPublicMergeQueueEvent(e: {
  at: Date;
  fromStatus: string | null;
  toStatus: string;
  trigger: string;
  code: string | null;
  message: string;
}) {
  return {
    object: 'merge_queue_event' as const,
    at: e.at.toISOString(),
    from_status: e.fromStatus ?? null,
    to_status: e.toStatus,
    trigger: e.trigger,
    code: e.code ?? null,
    message: e.message,
  };
}

// ---------------------------------------------------------------------------
// The pull request shape
// ---------------------------------------------------------------------------

const lower = (v: string | null) => (v ? v.toLowerCase() : null);

const CI_STATUSES = new Set(['none', 'passing', 'running', 'failing_optional', 'failing_required', 'needs_human']);

function humanGates(raw: unknown): Array<{ id: string; label: string; name: string; url: string | null }> {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')
    .map((g) => ({
      id: String(g.id ?? ''),
      label: String(g.label ?? ''),
      name: String(g.name ?? ''),
      url: typeof g.url === 'string' ? g.url : null,
    }));
}

/** An ISO instant from the summary's text, or null when it is missing or not a date. */
function isoOrNull(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export interface PullRequestExtras {
  sessionIds?: string[];
  codeReview?: CodeReviewPublic | null;
}

export function toPublicPullRequest(
  row: PublicPullRequestRow,
  queue: { entry: PublicQueueEntryRow; position: number } | null,
  extras?: PullRequestExtras,
) {
  const checksKnown = row.checksTotal !== null;
  return {
    object: 'pull_request' as const,
    id: row.id,
    workspace_id: row.workspaceId,
    repository_id: row.repositoryId,
    repository_full_name: `${row.owner}/${row.repo}`,
    number: row.number,
    title: row.title ?? null,
    url: row.url ?? null,
    author: row.author ?? null,
    author_is_bot: row.authorIsBot ?? null,
    state: (row.state === 'merged' || row.state === 'closed' ? row.state : 'open') as 'open' | 'closed' | 'merged',
    draft: row.draft ?? null,
    head_branch: row.headBranch || null,
    base_branch: row.baseBranch || null,
    head_sha: row.headSha || null,
    additions: row.additions ?? null,
    deletions: row.deletions ?? null,
    changed_files: row.changedFiles ?? null,
    authored: row.authored,
    review_requested: row.reviewRequested,
    watching: row.watching,
    review_hidden_at: row.reviewHiddenAt ? row.reviewHiddenAt.toISOString() : null,
    ci_status: (row.ciStatus && CI_STATUSES.has(row.ciStatus) ? row.ciStatus : null) as
      | 'none'
      | 'passing'
      | 'running'
      | 'failing_optional'
      | 'failing_required'
      | 'needs_human'
      | null,
    checks: checksKnown
      ? {
          total: row.checksTotal ?? 0,
          passed: row.checksPassed ?? 0,
          failed: row.checksFailed ?? 0,
          in_progress: row.checksInProgress ?? 0,
          skipped: row.checksSkipped ?? 0,
        }
      : null,
    human_gates: humanGates(row.humanGates),
    blocking_reason: row.blockingReason ?? null,
    mergeable: lower(row.mergeable),
    merge_state_status: lower(row.mergeStateStatus),
    review_decision: lower(row.effectiveReviewDecision ?? row.reviewDecision),
    unresolved_review_threads: row.unresolvedReviewThreads ?? null,
    auto_keep_mergeable: row.autoKeepMergeable,
    merge_queue: queue ? toPublicMergeQueueState(queue.entry, queue.position) : null,
    merged_at: row.mergedAt ? row.mergedAt.toISOString() : null,
    opened_at: isoOrNull(row.openedAt),
    last_synced_at: row.lastPolledAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    ...(extras?.sessionIds ? { session_ids: extras.sessionIds } : {}),
    ...(extras && 'codeReview' in extras
      ? {
          code_review: extras.codeReview
            ? {
                id: extras.codeReview.id,
                phase: extras.codeReview.phase,
                preset: extras.codeReview.preset,
                open_count: extras.codeReview.openCount,
                stale_for_head: extras.codeReview.staleForHead,
                finished_at: extras.codeReview.finishedAt,
              }
            : null,
        }
      : {}),
  };
}

/** One PR's queue place, out of a workspace snapshot. */
export function queueFor(snapshot: QueueSnapshot, pullRequestId: string): { entry: PublicQueueEntryRow; position: number } | null {
  const entry = snapshot.byPullRequest.get(pullRequestId);
  return entry ? { entry, position: snapshot.positions.get(entry.id) ?? 0 } : null;
}

export type PublicPullRequest = ReturnType<typeof toPublicPullRequest>;
export type PublicMergeQueueEntry = ReturnType<typeof toPublicMergeQueueEntry>;
