import { resubmitQueueEntry, setQueueMembership } from '../../services/mergeQueue/membership.js';
import { mergeQueueTimelineForPr } from '../../services/mergeQueue/timeline.js';
import { resolveWorkspaceId } from '../../services/public/authorize.js';
import { PublicApiError } from '../../services/public/errors.js';
import {
  authorizedPullRequest,
  authorizedPullRequestForWrite,
  toPublicMergeQueueEntry,
  toPublicMergeQueueEvent,
  workspaceQueue,
} from '../../services/public/pullRequests.js';
import { IdParams } from '../../schemas/public/resources.js';
import {
  AddToMergeQueueBody,
  MergeQueueEventList,
  MergeQueueList,
  MergeQueueQuery,
  PullRequest,
} from '../../schemas/public/pullRequests.js';
import { definePublicRoute, type PublicRoute } from './define.js';
import { pullRequestDetail } from './pullRequests.js';

const RESUBMIT_REFUSALS: Record<string, string> = {
  not_queued: 'This pull request is not in the merge queue.',
  not_parked: 'The merge queue is still working on this pull request. Nothing to re-submit.',
  no_external_queue: 'This pull request has not been through an external merge queue.',
};

/**
 * Talyn's merge queue. It merges a queued pull request when it is clean, one
 * at a time per repository and base branch, and starts a fix run when it is
 * not. Joining and leaving go through `setQueueMembership`, the service the
 * app and the workflow engine use, so the plan gate and the GitHub auto-merge
 * disarm behave the same.
 */
export const mergeQueueRoutes: PublicRoute[] = [
  definePublicRoute({
    method: 'get',
    path: '/merge-queue',
    operationId: 'listMergeQueue',
    summary: 'List the merge queue',
    description: 'Every pull request in the merge queue of a workspace, in the order they joined. One page.',
    tag: 'Merge queue',
    scope: 'pull_requests:read',
    query: MergeQueueQuery,
    responses: { 200: { description: 'The queue.', schema: MergeQueueList } },
    async handler({ query, token }) {
      const workspaceId = await resolveWorkspaceId(token, query.workspace_id);
      const queue = await workspaceQueue(workspaceId);
      return {
        status: 200,
        body: {
          object: 'list',
          data: queue.entries.map((e) => toPublicMergeQueueEntry(e, queue.positions.get(e.id) ?? 0)),
          has_more: false,
          next_cursor: null,
        },
      };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/pull-requests/{id}/merge-queue',
    operationId: 'addToMergeQueue',
    summary: 'Add a pull request to the merge queue',
    description:
      'Talyn merges it when it is clean, and starts a fix run when it has conflicts or failing checks. ' +
      'Adding a pull request that is already queued changes only its `method`.',
    tag: 'Merge queue',
    scope: 'pull_requests:write',
    idempotent: true,
    params: IdParams,
    body: AddToMergeQueueBody,
    responses: { 200: { description: 'The pull request, with `merge_queue` set.', schema: PullRequest } },
    async handler({ params, body, token }) {
      const row = await authorizedPullRequestForWrite(token, params.id);
      if (row.state !== 'open') throw new PublicApiError(409, 'pull_request_not_open', 'Only an open pull request can join the merge queue.');
      await setQueueMembership({
        row,
        enabled: true,
        method: body.method ?? row.mergeMethod,
        trigger: 'user:api_enqueue',
      });
      return { status: 200, body: await pullRequestDetail(token, row.id) };
    },
  }),

  definePublicRoute({
    method: 'delete',
    path: '/pull-requests/{id}/merge-queue',
    operationId: 'removeFromMergeQueue',
    summary: 'Remove a pull request from the merge queue',
    description: 'Also turns off the GitHub auto-merge that Talyn armed, if any. A pull request that is not queued answers the same.',
    tag: 'Merge queue',
    scope: 'pull_requests:write',
    params: IdParams,
    responses: { 200: { description: 'The pull request, with `merge_queue: null`.', schema: PullRequest } },
    async handler({ params, token }) {
      const row = await authorizedPullRequestForWrite(token, params.id);
      await setQueueMembership({ row, enabled: false, method: row.mergeMethod, trigger: 'user:api_dequeue' });
      return { status: 200, body: await pullRequestDetail(token, row.id) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/pull-requests/{id}/merge-queue/resubmit',
    operationId: 'resubmitToMergeQueue',
    summary: 'Re-submit a parked pull request',
    description:
      'For a pull request an external merge queue (trunk.io) gave back, after a person dealt with the cause. ' +
      'Resets the budgets and submits it again. 409 `not_queued`, `not_parked` or `no_external_queue` otherwise.',
    tag: 'Merge queue',
    scope: 'pull_requests:write',
    idempotent: true,
    params: IdParams,
    responses: { 200: { description: 'The pull request.', schema: PullRequest } },
    async handler({ params, token }) {
      const row = await authorizedPullRequestForWrite(token, params.id);
      const result = await resubmitQueueEntry(row, 'user:api_resubmit');
      if (!result.ok) throw new PublicApiError(409, result.code, RESUBMIT_REFUSALS[result.code] ?? 'Nothing to re-submit.');
      return { status: 200, body: await pullRequestDetail(token, row.id) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/pull-requests/{id}/merge-queue/events',
    operationId: 'listMergeQueueEvents',
    summary: 'List the merge-queue history of a pull request',
    description: 'What the queue did with the pull request and why: the current entry, or the last one when it is not queued.',
    tag: 'Merge queue',
    scope: 'pull_requests:read',
    params: IdParams,
    responses: { 200: { description: 'The events, newest first.', schema: MergeQueueEventList } },
    async handler({ params, token }) {
      const pr = await authorizedPullRequest(token, params.id);
      const events = await mergeQueueTimelineForPr(pr.id);
      return { status: 200, body: { object: 'list', data: events.map(toPublicMergeQueueEvent) } };
    },
  }),
];
