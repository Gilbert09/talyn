import {
  CODE_REVIEW_DISMISS_REASONS,
  CODE_REVIEW_PRESETS,
  type CodeReviewFinding,
  type CodeReviewPublic,
} from '@talyn/shared';
import { callApi, type PublicPr } from '../api.js';
import {
  bool,
  booleanSchema,
  defineTool,
  linesOrNone,
  pageLimit,
  pageSchema,
  prSchema,
  requireId,
  resolveWorkspace,
  str,
  textSchema,
  workspaceSchema,
} from './helpers.js';

const base = (args: Record<string, unknown>) =>
  `/pull-requests/${requireId(args, 'pull_request_id')}/code-review`;
const reviewLine = (review: CodeReviewPublic) =>
  `${review.id}  [${review.phase}]  head: ${review.headSha}  preset: ${review.preset}${review.failureReason ? `  ${review.failureReason}` : ''}`;
const findingLine = (finding: CodeReviewFinding) =>
  `${finding.id} [${finding.severity}] [${finding.disposition}] ${finding.filePath}:${finding.lineStart ?? '?'} ${finding.title} (${finding.lenses.join(', ')}, ${finding.verdict})`;
const findingSchema = { ...prSchema, finding_id: textSchema };

export const CODEREVIEW = [
  defineTool(
    'get_code_review',
    'Get review status and findings. Filter by finding status; default open, or all for every finding.',
    {
      ...prSchema,
      status: {
        type: 'string',
        enum: ['open', 'selected', 'dismissed', 'fixed', 'stale', 'discarded', 'all'],
        default: 'open',
      },
    },
    ['pull_request_id'],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const data = await callApi<{
        review: CodeReviewPublic | null;
        findings: CodeReviewFinding[];
        defaultPreset: string;
      }>(ownerId, 'GET', base(args));
      const status = str(args.status) ?? 'open';
      return [
        data.review ? reviewLine(data.review) : `No review. Default preset: ${data.defaultPreset}.`,
        ...data.findings
          .filter((f) => status === 'all' || f.disposition === status)
          .map(findingLine),
      ].join('\n');
    },
    'codeReview'
  ),
  defineTool(
    'start_code_review',
    'Start a code review. Set reset to discard the prior cycle and start again.',
    { ...prSchema, preset: { type: 'string', enum: CODE_REVIEW_PRESETS }, reset: booleanSchema },
    ['pull_request_id'],
    { openWorldHint: true, destructiveHint: true },
    async (ownerId, args) => {
      const data = await callApi<CodeReviewPublic>(ownerId, 'POST', base(args), {
        ...(str(args.preset) ? { preset: str(args.preset) } : {}),
        ...(args.reset !== undefined ? { reset: bool(args, 'reset') } : {}),
      });
      return reviewLine(data);
    },
    'codeReview'
  ),
  defineTool(
    'cancel_code_review',
    'Cancel a running code review.',
    prSchema,
    ['pull_request_id'],
    { destructiveHint: true, openWorldHint: true },
    async (ownerId, args) =>
      reviewLine(await callApi<CodeReviewPublic>(ownerId, 'DELETE', base(args))),
    'codeReview'
  ),
  defineTool(
    'get_code_review_finding',
    'Get a finding with its full body, suggestion, anchor, and verdict reason.',
    findingSchema,
    ['pull_request_id', 'finding_id'],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const finding = await callApi<CodeReviewFinding>(
        ownerId,
        'GET',
        `${base(args)}/findings/${requireId(args, 'finding_id')}`
      );
      return [
        findingLine(finding),
        `body: ${finding.body ?? ''}`,
        `suggestion: ${finding.suggestion ?? 'none'}`,
        `anchor: ${finding.anchor ?? 'none'}`,
        `verdict reason: ${finding.verdictReason ?? 'none'}`,
      ].join('\n');
    },
    'codeReview'
  ),
  defineTool(
    'fix_code_review_findings',
    'Start a cloud task to fix the selected findings.',
    { ...prSchema, finding_ids: { type: 'array', items: textSchema, minItems: 1 } },
    ['pull_request_id', 'finding_ids'],
    { openWorldHint: true },
    async (ownerId, args) => {
      if (
        !Array.isArray(args.finding_ids) ||
        !args.finding_ids.length ||
        args.finding_ids.some((id) => !str(id))
      )
        throw new Error('finding_ids must contain finding ids.');
      const data = await callApi<{ taskId: string; review: CodeReviewPublic }>(
        ownerId,
        'POST',
        `${base(args)}/fix`,
        { findingIds: args.finding_ids }
      );
      return `${data.taskId} fix task started.\n${reviewLine(data.review)}`;
    },
    'codeReview'
  ),
  defineTool(
    'dismiss_code_review_finding',
    'Dismiss a finding with a reason. Set undo to restore it.',
    {
      ...findingSchema,
      reason: { type: 'string', enum: CODE_REVIEW_DISMISS_REASONS },
      undo: booleanSchema,
    },
    ['pull_request_id', 'finding_id'],
    { destructiveHint: true, openWorldHint: true },
    async (ownerId, args) => {
      const undo = bool(args, 'undo', false);
      const reason = str(args.reason);
      if (!undo && reason && !CODE_REVIEW_DISMISS_REASONS.some((value) => value === reason))
        throw new Error('Invalid dismissal reason.');
      const data = await callApi<CodeReviewPublic>(
        ownerId,
        undo ? 'DELETE' : 'POST',
        `${base(args)}/findings/${requireId(args, 'finding_id')}/dismiss`,
        undo ? undefined : { ...(reason ? { reason } : {}) }
      );
      return `${requireId(args, 'finding_id')} ${undo ? 'restored' : 'dismissed'}.\n${reviewLine(data)}`;
    },
    'codeReview'
  ),
  defineTool(
    'list_code_reviews',
    'List recent code reviews in a workspace.',
    { ...workspaceSchema, limit: pageSchema.limit },
    [],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const params = new URLSearchParams({
        workspaceId: await resolveWorkspace(ownerId, args),
        limit: String(pageLimit(args)),
      });
      const data = await callApi<{
        reviews: { review: CodeReviewPublic; pullRequest: PublicPr }[];
      }>(ownerId, 'GET', `/code-reviews?${params}`);
      return linesOrNone(
        data.reviews,
        ({ review, pullRequest }) =>
          `${reviewLine(review)}  PR ${pullRequest.id} ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`
      );
    },
    'codeReview'
  ),
];
