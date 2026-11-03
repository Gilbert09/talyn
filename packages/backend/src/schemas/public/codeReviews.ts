import { CODE_REVIEW_DISMISS_REASONS, CODE_REVIEW_PRESETS } from '@talyn/shared';
import { Id, Timestamp } from './common.js';
import { z } from './zod.js';

/** Code reviews on `/v1`: a review of a pull request, its findings, and the actions a person takes on them. */

export const SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
export const FINDING_STATUSES = ['open', 'selected', 'dismissed', 'fixed', 'stale'] as const;
export const VERDICTS = ['unvalidated', 'confirmed', 'rejected', 'uncertain'] as const;

const presets = CODE_REVIEW_PRESETS as unknown as [string, ...string[]];
const dismissReasons = CODE_REVIEW_DISMISS_REASONS as unknown as [string, ...string[]];

const Lens = z.object({
  key: z.string().openapi({ example: 'security' }),
  name: z.string().openapi({ description: 'The name the app shows.', example: 'Security' }),
});

export const Finding = z
  .object({
    object: z.literal('code_review_finding'),
    id: Id,
    review_id: Id,
    severity: z.enum(SEVERITIES),
    category: z.string(),
    title: z.string(),
    file_path: z.string(),
    line_start: z.number().int().nullable(),
    line_end: z.number().int().nullable(),
    anchor_verified: z.boolean().openapi({
      description: 'The quoted code is at the place the finding names. False: the reviewer paraphrased or named the wrong place.',
    }),
    lenses: z.array(Lens).openapi({ description: 'The reviewers that reported it. Two or more is agreement.' }),
    confidence: z.number().int().nullable(),
    verdict: z.enum(VERDICTS).openapi({ description: 'What the judging pass decided.' }),
    verdict_reason: z.string().nullable().openapi({ description: "The judge's reason, in one sentence." }),
    status: z.enum(FINDING_STATUSES).openapi({
      description: '`selected`: a fix run works on it now. `stale`: a later review did not find it again. New values can appear.',
    }),
    dismissed_reason: z.enum(dismissReasons).nullable(),
    seen_count: z.number().int().openapi({ description: 'How many review cycles reported it.' }),
    carried_over: z.boolean().openapi({ description: 'An earlier cycle reported it first.' }),
    posted_at: Timestamp.nullable().openapi({ description: 'When it was posted to the pull request. A posted finding is never posted again.' }),
    fixed_at: Timestamp.nullable(),
    fixed_head_sha: z.string().nullable(),
    created_at: Timestamp,
    body: z.string().optional().openapi({ description: 'The full text. On `GET /code-reviews/{id}/findings/{finding_id}` only.' }),
    suggestion: z.string().nullable().optional().openapi({ description: 'A suggested change, as plain text. Single finding only.' }),
    anchor: z.string().nullable().optional().openapi({ description: 'The code the finding quotes. Single finding only.' }),
  })
  .openapi('CodeReviewFinding');

export const CodeReview = z
  .object({
    object: z.literal('code_review'),
    id: Id,
    workspace_id: Id,
    pull_request_id: Id,
    cycle: z.number().int().openapi({ description: 'How many times this pull request has been reviewed. Each new review is a new cycle of the same review.' }),
    preset: z.enum(presets),
    phase: z.string().openapi({
      description:
        '`queued`, `preparing`, `reviewing`, `sweeping`, `validating`: in progress. `ready`, `failed`, `cancelled`, `fixing`, `fixed`, `idle`: at rest. New values can appear.',
      example: 'ready',
    }),
    phase_plan: z.array(z.string()).openapi({ description: 'The phases this cycle goes through, in order.' }),
    runs_done: z.number().int(),
    runs_total: z.number().int(),
    lenses_run: z.array(Lens).openapi({ description: 'The reviewers that ran in this cycle.' }),
    head_sha: z.string().openapi({ description: 'The commit the current cycle reads.' }),
    reviewed_head_sha: z.string().nullable().openapi({ description: 'The commit the findings belong to.' }),
    stale_for_head: z.boolean().openapi({ description: 'The pull request has new commits since the findings were made.' }),
    counts: z
      .object({ blocker: z.number().int(), major: z.number().int(), minor: z.number().int(), nit: z.number().int() })
      .openapi({ description: 'Open findings by severity.' }),
    open_count: z.number().int().openapi({ description: 'Open findings at or above the workspace reporting bar. The number the app shows.' }),
    dismissed_count: z.number().int(),
    funnel: z
      .object({ raised: z.number().int(), kept: z.number().int(), rejected: z.number().int() })
      .openapi({ description: 'What the review did with its candidates: raised, kept by the judge, thrown out.' }),
    failure_reason: z.string().nullable(),
    deferred_since: Timestamp.nullable().openapi({ description: 'Set while a reviewer waits for a free runner.' }),
    started_at: Timestamp.nullable(),
    finished_at: Timestamp.nullable(),
    created_at: Timestamp,
    findings: z
      .array(Finding)
      .optional()
      .openapi({ description: 'Most severe first. Without `body`, `suggestion` and `anchor`. On `GET /code-reviews/{id}` only.' }),
  })
  .openapi('CodeReview');

export const CodeReviewList = z
  .object({
    object: z.literal('list'),
    data: z.array(CodeReview).openapi({ description: 'A pull request has at most one review. It holds every cycle.' }),
    has_more: z.literal(false),
    next_cursor: z.null(),
  })
  .openapi('CodeReviewList');

export const StartCodeReviewBody = z
  .object({
    preset: z.enum(presets).optional().openapi({ description: 'How deep to review. Default: the workspace setting.' }),
    reset: z.boolean().optional().openapi({ description: 'Throw away the findings on record instead of carrying them forward.' }),
  })
  .strict()
  .openapi('StartCodeReviewRequest');

export const DismissFindingBody = z
  .object({
    reason: z.enum(dismissReasons).optional(),
  })
  .strict()
  .openapi('DismissFindingRequest');

export const PostCodeReviewBody = z
  .object({
    finding_ids: z
      .array(z.string().min(1).max(200))
      .max(500)
      .optional()
      .openapi({ description: 'The findings to post. Empty or absent: every open finding not posted yet.' }),
  })
  .strict()
  .openapi('PostCodeReviewRequest');

export const CodeReviewPost = z
  .object({
    object: z.literal('code_review_post'),
    review_id: Id,
    posted: z.number().int().openapi({ description: 'Findings written to the pull request.' }),
    inline: z.number().int().openapi({ description: 'Of those, comments on a line of the diff.' }),
    in_summary: z.number().int().openapi({ description: 'Of those, in the review body.' }),
    review_url: z.string().nullable().openapi({ description: 'The GitHub review.' }),
  })
  .openapi('CodeReviewPost');

export const CodeReviewEvent = z
  .object({
    object: z.literal('code_review_event'),
    at: Timestamp,
    from_phase: z.string().nullable(),
    to_phase: z.string(),
    trigger: z.string(),
    code: z.string().nullable(),
    message: z.string(),
  })
  .openapi('CodeReviewEvent');

export const CodeReviewEventList = z
  .object({
    object: z.literal('list'),
    data: z.array(CodeReviewEvent).openapi({ description: 'Newest first. At most the newest 200.' }),
  })
  .openapi('CodeReviewEventList');

export const FindingParams = z.object({ id: Id, finding_id: Id });
