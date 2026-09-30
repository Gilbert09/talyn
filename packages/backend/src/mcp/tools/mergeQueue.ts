import { callApi } from '../api.js';
import {
  bool,
  booleanSchema,
  defineTool,
  fieldsText,
  linesOrNone,
  prSchema,
  requireId,
  str,
} from './helpers.js';

export const MERGEQUEUE = [
  defineTool(
    'set_merge_queue_stack',
    'Add a PR stack to the merge queue or remove it. Include descendants when requested.',
    {
      ...prSchema,
      enabled: booleanSchema,
      include_descendants: booleanSchema,
      method: { type: 'string', enum: ['merge', 'squash', 'rebase'] },
    },
    ['pull_request_id', 'enabled'],
    { destructiveHint: true, openWorldHint: true },
    async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      const result = await callApi<{
        pullRequestIds: string[];
        skipped: { pullRequestId: string; reason: string }[];
      }>(ownerId, 'POST', `/pull-requests/${id}/merge-queue/stack`, {
        enabled: bool(args, 'enabled'),
        includeDescendants: bool(args, 'include_descendants', false),
        ...(str(args.method) ? { method: str(args.method) } : {}),
      });
      return [
        ...result.pullRequestIds.map(
          (pr) => `${pr} queue ${args.enabled ? 'enabled' : 'disabled'}.`
        ),
        ...result.skipped.map((pr) => `${pr.pullRequestId} skipped: ${pr.reason}`),
      ].join('\n');
    }
  ),
  defineTool(
    'get_merge_queue_timeline',
    'Get the merge queue events for a PR.',
    prSchema,
    ['pull_request_id'],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const result = await callApi<{
        events: {
          at: string;
          fromStatus: string | null;
          toStatus: string;
          trigger: string;
          code: string | null;
          message: string;
          detail: Record<string, unknown> | null;
        }[];
      }>(
        ownerId,
        'GET',
        `/pull-requests/${requireId(args, 'pull_request_id')}/merge-queue/timeline`
      );
      return linesOrNone(
        result.events,
        (event) =>
          `${event.at}  ${event.fromStatus ?? 'new'} → ${event.toStatus}  ${event.trigger}  ${event.code ?? ''} ${event.message}${event.detail ? `  ${fieldsText(event.detail)}` : ''}`
      );
    }
  ),
];
