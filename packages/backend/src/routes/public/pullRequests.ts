import { codeReviewForPr } from '../../services/codeReview/public.js';
import { setAutoKeepMergeable } from '../../services/prAutoKeep.js';
import { refreshPullRequest } from '../../services/prRefresh.js';
import type { ApiTokenPrincipal } from '../../services/apiTokens.js';
import { resolveWorkspaceId } from '../../services/public/authorize.js';
import { decodeCursor, pageOf } from '../../services/public/cursor.js';
import { PublicApiError } from '../../services/public/errors.js';
import { toPublicSession } from '../../services/public/projections.js';
import {
  authorizedPullRequest,
  authorizedPullRequestForWrite,
  getPullRequestDescriptionQuery,
  liveSessionIdsQuery,
  listPullRequestsQuery,
  queueFor,
  toPublicPullRequest,
  workspaceQueue,
  type PublicPullRequestRow,
} from '../../services/public/pullRequests.js';
import { getSessionQuery, openChatsQuery } from '../../services/public/queries.js';
import { createWorkbench } from '../../services/workbenches/create.js';
import { IdParams, Session } from '../../schemas/public/resources.js';
import {
  ListPullRequestsQuery,
  PullRequest,
  PullRequestDescription,
  PullRequestList,
  StartPrSessionBody,
  UpdatePullRequestBody,
} from '../../schemas/public/pullRequests.js';
import { definePublicRoute, type PublicRoute } from './define.js';

/**
 * The full pull request as `GET /pull-requests/{id}` answers it: the cached
 * facts, its queue place, its live sessions and its latest code review. Read
 * from the database only: no GitHub call. `POST .../refresh` is the way to
 * read GitHub again.
 */
export async function pullRequestDetail(token: ApiTokenPrincipal, id: string, row?: PublicPullRequestRow) {
  const pr = row ?? (await authorizedPullRequest(token, id));
  const [queue, sessions, review] = await Promise.all([
    workspaceQueue(pr.workspaceId),
    liveSessionIdsQuery(pr.workspaceId, pr.id),
    codeReviewForPr(pr.id),
  ]);
  return toPublicPullRequest(pr, queueFor(queue, pr.id), {
    sessionIds: sessions.map((s) => s.id),
    codeReview: review,
  });
}

/**
 * Pull requests: the ones Talyn tracks for a workspace (yours, the ones that
 * wait for your review, and the ones you watch). The writes call the same
 * services as the app's routes, so plan limits and broadcasts behave the same.
 */
export const pullRequestRoutes: PublicRoute[] = [
  definePublicRoute({
    method: 'get',
    path: '/pull-requests',
    operationId: 'listPullRequests',
    summary: 'List pull requests',
    description:
      'The pull requests Talyn tracks in a workspace, newest tracked first. Default: open ones. ' +
      'The data is what Talyn last read from GitHub; `last_synced_at` says when.',
    tag: 'Pull requests',
    scope: 'pull_requests:read',
    query: ListPullRequestsQuery,
    responses: { 200: { description: 'A page of pull requests.', schema: PullRequestList } },
    async handler({ query, token }) {
      const workspaceId = await resolveWorkspaceId(token, query.workspace_id);
      const [rows, queue] = await Promise.all([
        listPullRequestsQuery(
          workspaceId,
          {
            state: query.state,
            relationship: query.relationship,
            repositoryId: query.repository_id,
            mergeQueued: query.merge_queued,
          },
          decodeCursor(query.cursor),
          query.limit,
        ),
        workspaceQueue(workspaceId),
      ]);
      const page = pageOf(rows, query.limit);
      return {
        status: 200,
        body: {
          object: 'list',
          data: page.rows.map((r) => toPublicPullRequest(r, queueFor(queue, r.id))),
          has_more: page.hasMore,
          next_cursor: page.nextCursor,
        },
      };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/pull-requests/{id}',
    operationId: 'getPullRequest',
    summary: 'Get a pull request',
    description: 'With its live sessions and its latest code review. Reads no data from GitHub: use `POST /pull-requests/{id}/refresh` for that.',
    tag: 'Pull requests',
    scope: 'pull_requests:read',
    params: IdParams,
    responses: { 200: { description: 'The pull request.', schema: PullRequest } },
    async handler({ params, token }) {
      return { status: 200, body: await pullRequestDetail(token, params.id) };
    },
  }),

  definePublicRoute({
    method: 'patch',
    path: '/pull-requests/{id}',
    operationId: 'updatePullRequest',
    summary: 'Update a pull request',
    description:
      '`auto_keep_mergeable: true` makes Talyn start a fix when the pull request stops being mergeable (conflicts, failing checks), ' +
      'for as long as it stays open. Each fix counts against the plan like any other run.',
    tag: 'Pull requests',
    scope: 'pull_requests:write',
    params: IdParams,
    body: UpdatePullRequestBody,
    responses: { 200: { description: 'The pull request.', schema: PullRequest } },
    async handler({ params, body, token }) {
      const row = await authorizedPullRequestForWrite(token, params.id);
      if (body.auto_keep_mergeable !== undefined) await setAutoKeepMergeable(row, body.auto_keep_mergeable);
      return { status: 200, body: await pullRequestDetail(token, row.id) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/pull-requests/{id}/description',
    operationId: 'getPullRequestDescription',
    summary: 'Get the description of a pull request',
    description: 'The description as Talyn last read it from GitHub.',
    tag: 'Pull requests',
    scope: 'pull_requests:read',
    params: IdParams,
    responses: { 200: { description: 'The description.', schema: PullRequestDescription } },
    async handler({ params, token }) {
      await authorizedPullRequest(token, params.id);
      const [row] = await getPullRequestDescriptionQuery(params.id);
      return { status: 200, body: { object: 'pull_request_description', pull_request_id: params.id, body: row?.body ?? null } };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/pull-requests/{id}/refresh',
    operationId: 'refreshPullRequest',
    summary: 'Read a pull request from GitHub again',
    description:
      'Fetches the pull request from GitHub now and stores it. A pull request that is no longer open gets its closed or merged state. ' +
      "Uses your GitHub rate limit, so it has its own, lower limit (see rate limits). Answers 409 `cannot_refresh` when GitHub does not have it.",
    tag: 'Pull requests',
    scope: 'pull_requests:write',
    github: true,
    params: IdParams,
    responses: { 200: { description: 'The pull request, as GitHub has it now.', schema: PullRequest } },
    async handler({ params, token }) {
      const row = await authorizedPullRequestForWrite(token, params.id);
      const outcome = await refreshPullRequest(row);
      if (outcome.kind === 'not_found') {
        throw new PublicApiError(
          409,
          'cannot_refresh',
          'GitHub did not return this pull request, or Talyn does not know its branch yet. Retry after the next sync.',
        );
      }
      return { status: 200, body: await pullRequestDetail(token, outcome.kind === 'refreshed' ? outcome.rowId : row.id) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/pull-requests/{id}/sessions',
    operationId: 'startPullRequestSession',
    summary: 'Start a session on a pull request',
    description:
      "Starts a sandbox session on the pull request's head branch and links it to the pull request. " +
      'The same as `POST /sessions` with `pull_request_id`. Send a `prompt` to tell the agent what to do, for example to fix the failing checks.',
    tag: 'Pull requests',
    scope: 'sessions:write',
    sessions: true,
    creates: true,
    params: IdParams,
    body: StartPrSessionBody,
    responses: { 201: { description: 'The new session. `status` is `provisioning`.', schema: Session } },
    async handler({ params, body, token }) {
      const pr = await authorizedPullRequest(token, params.id);
      if (pr.state !== 'open') {
        throw new PublicApiError(409, 'pull_request_not_open', 'This pull request is not open.');
      }
      const created = await createWorkbench(
        {
          workspaceId: pr.workspaceId,
          runtime: 'sandbox',
          agent: body.agent,
          repositoryId: pr.repositoryId,
          fromPullRequestId: pr.id,
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.internet_access !== undefined ? { internetAccess: body.internet_access } : {}),
        },
        { id: token.ownerId, email: token.email },
      );
      const [session] = await getSessionQuery(created.id);
      if (!session) throw new PublicApiError(500, 'internal_error', 'The session was created but could not be read.');
      return { status: 201, body: toPublicSession(session, await openChatsQuery(created.id)) };
    },
  }),
];
