import { AGENTS } from './resources.js';
import { Id, listOf, PageQuery, QueryBoolean, Timestamp } from './common.js';
import { z } from './zod.js';

/**
 * Pull requests and the merge queue on `/v1`. Same rules as `resources.ts`:
 * requests are `.strict()`, responses are snake_case, and enum values that
 * come from GitHub are lower-cased.
 */

export const PR_STATES = ['open', 'closed', 'merged'] as const;
export const PR_STATE_FILTERS = [...PR_STATES, 'all'] as const;
export const PR_RELATIONSHIPS = ['authored', 'review_requested', 'watching'] as const;
export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const;
export const CI_STATUSES = ['none', 'passing', 'running', 'failing_optional', 'failing_required', 'needs_human'] as const;

export const MergeQueueState = z
  .object({
    status: z.string().openapi({
      description:
        'Where the entry is: `queued`, `awaiting_ci`, `awaiting_review`, `automerge_armed`, `awaiting_external`, ' +
        '`awaiting_stack`, `fixing`, `merging`, `blocked` or `blocked_manual`. New values can appear.',
      example: 'awaiting_ci',
    }),
    position: z.number().int().openapi({ description: '1-based place in the queue of its repository and base branch.' }),
    method: z.enum(MERGE_METHODS),
    base_branch: z.string(),
    head_sha: z.string().nullable().openapi({ description: 'The head the queue last saw. Null before it has seen one.' }),
    blocked_code: z.string().nullable().openapi({
      description: 'Why a `blocked` or `blocked_manual` entry is parked, e.g. `draft`, `no_progress`, `awaiting_human_check`. New values can appear.',
    }),
    blocked_reason: z.string().nullable().openapi({ description: 'The same reason, in words for a person.' }),
    auto_merge_armed: z.boolean().openapi({ description: "GitHub's own auto-merge is armed on the pull request." }),
    external_state: z.string().nullable().openapi({ description: 'The state an external merge queue (trunk.io) reports, when one owns the base branch.' }),
    enqueued_at: Timestamp,
  })
  .openapi('MergeQueueState');

const HumanGate = z.object({
  id: z.string(),
  label: z.string().openapi({ example: 'Visual review' }),
  name: z.string().openapi({ description: 'The failing check or status.' }),
  url: z.string().nullable(),
});

const CodeReviewSummary = z
  .object({
    id: Id,
    phase: z.string().openapi({ example: 'ready' }),
    preset: z.string().openapi({ example: 'standard' }),
    open_count: z.number().int().openapi({ description: 'Open findings at or above the workspace reporting bar.' }),
    stale_for_head: z.boolean().openapi({ description: 'The pull request has new commits since the findings were made.' }),
    finished_at: Timestamp.nullable(),
  })
  .openapi('CodeReviewSummary');

export const PullRequest = z
  .object({
    object: z.literal('pull_request'),
    id: Id,
    workspace_id: Id,
    repository_id: Id,
    repository_full_name: z.string().openapi({ example: 'acme/app' }),
    number: z.number().int(),
    title: z.string().nullable().openapi({ description: 'Null until Talyn has read the pull request from GitHub once. So are the other GitHub fields.' }),
    url: z.string().nullable(),
    author: z.string().nullable(),
    author_is_bot: z.boolean().nullable().openapi({ description: 'Null: not known.' }),
    state: z.enum(PR_STATES),
    draft: z.boolean().nullable(),
    head_branch: z.string().nullable(),
    base_branch: z.string().nullable(),
    head_sha: z.string().nullable(),
    additions: z.number().int().nullable(),
    deletions: z.number().int().nullable(),
    changed_files: z.number().int().nullable(),
    authored: z.boolean().openapi({ description: 'You opened it. The "Mine" bucket in the app.' }),
    review_requested: z.boolean().openapi({ description: 'It waits for your review. The "Review" bucket in the app.' }),
    watching: z.boolean().openapi({ description: 'You track it by URL.' }),
    review_hidden_at: Timestamp.nullable().openapi({ description: 'When you hid it from the Reviews tab.' }),
    ci_status: z.enum(CI_STATUSES).nullable().openapi({
      description:
        'The CI picture alone. `failing_required` includes a failing check whose required-ness is not known. ' +
        '`needs_human`: only gates a person must clear are failing. Null: not computed yet.',
    }),
    checks: z
      .object({
        total: z.number().int(),
        passed: z.number().int(),
        failed: z.number().int(),
        in_progress: z.number().int(),
        skipped: z.number().int(),
      })
      .nullable(),
    human_gates: z.array(HumanGate).openapi({ description: 'Failing gates only a person can clear, e.g. a visual review.' }),
    blocking_reason: z.string().nullable().openapi({
      description:
        'The whole merge verdict: `mergeable`, `merge_conflicts`, `changes_requested`, `checks_failed`, ' +
        '`checks_failed_optional`, `blocked`, `behind`, `needs_human`, ... New values can appear.',
    }),
    mergeable: z.string().nullable().openapi({ description: "GitHub's answer, lower-cased: `mergeable`, `conflicting` or `unknown`." }),
    merge_state_status: z.string().nullable().openapi({ description: "GitHub's merge state, lower-cased, e.g. `clean`, `blocked`, `behind`." }),
    review_decision: z.string().nullable().openapi({
      description:
        '`approved`, `changes_requested` or `review_required`, as the app shows it. Where the base branch does not require reviews, Talyn works it out from the reviews.',
    }),
    unresolved_review_threads: z.number().int().nullable(),
    auto_keep_mergeable: z.boolean().openapi({ description: 'Talyn starts a fix when the pull request stops being mergeable.' }),
    merge_queue: MergeQueueState.nullable().openapi({ description: "The pull request's entry in Talyn's merge queue. Null when it is not queued." }),
    merged_at: Timestamp.nullable(),
    opened_at: Timestamp.nullable().openapi({ description: 'When the pull request was opened on GitHub.' }),
    last_synced_at: Timestamp.openapi({ description: 'When Talyn last read the pull request from GitHub.' }),
    created_at: Timestamp.openapi({ description: 'When Talyn started to track it. Lists are ordered by this.' }),
    updated_at: Timestamp,
    session_ids: z
      .array(Id)
      .optional()
      .openapi({ description: 'Sessions that work on this pull request and are not archived, most recent first. On single responses only.' }),
    code_review: CodeReviewSummary.nullable()
      .optional()
      .openapi({ description: 'The latest code review. Null: never reviewed. On single responses only.' }),
  })
  .openapi('PullRequest');

export const PullRequestList = listOf(PullRequest, 'PullRequestList');

export const ListPullRequestsQuery = z
  .object({
    workspace_id: Id.optional().openapi({ description: 'Required unless the token is bound to exactly one workspace.' }),
    state: z.enum(PR_STATE_FILTERS).default('open').openapi({ description: 'Default `open`.' }),
    relationship: z.enum(PR_RELATIONSHIPS).optional().openapi({
      description: '`authored` is the "Mine" bucket, `review_requested` the "Review" bucket. Default: all.',
    }),
    repository_id: Id.optional(),
    merge_queued: QueryBoolean.optional().openapi({ description: 'Only pull requests in (true) or not in (false) the merge queue.' }),
    ...PageQuery,
  })
  .strict();

export const UpdatePullRequestBody = z
  .object({
    auto_keep_mergeable: z.boolean().optional(),
  })
  .strict()
  .openapi('UpdatePullRequestRequest');

export const PullRequestDescription = z
  .object({
    object: z.literal('pull_request_description'),
    pull_request_id: Id,
    body: z.string().nullable().openapi({ description: 'The description as Talyn last read it. Null: not read yet.' }),
  })
  .openapi('PullRequestDescription');

export const AddToMergeQueueBody = z
  .object({
    method: z.enum(MERGE_METHODS).optional().openapi({ description: 'How to merge. Default: the last method used for this pull request, else `squash`.' }),
  })
  .strict()
  .openapi('AddToMergeQueueRequest');

export const MergeQueueEntry = MergeQueueState.extend({
  object: z.literal('merge_queue_entry'),
  pull_request_id: Id,
  repository_id: Id,
  repository_full_name: z.string(),
  number: z.number().int(),
  title: z.string().nullable(),
}).openapi('MergeQueueEntry');

export const MergeQueueList = z
  .object({
    object: z.literal('list'),
    data: z.array(MergeQueueEntry),
    has_more: z.literal(false).openapi({ description: 'Always false: the queue is one page.' }),
    next_cursor: z.null(),
  })
  .openapi('MergeQueueList');

export const MergeQueueQuery = z
  .object({
    workspace_id: Id.optional().openapi({ description: 'Required unless the token is bound to exactly one workspace.' }),
  })
  .strict();

export const MergeQueueEvent = z
  .object({
    object: z.literal('merge_queue_event'),
    at: Timestamp,
    from_status: z.string().nullable(),
    to_status: z.string(),
    trigger: z.string().openapi({ example: 'user:enqueue' }),
    code: z.string().nullable(),
    message: z.string(),
  })
  .openapi('MergeQueueEvent');

export const MergeQueueEventList = z
  .object({
    object: z.literal('list'),
    data: z.array(MergeQueueEvent).openapi({ description: 'Newest first. At most the newest 100.' }),
  })
  .openapi('MergeQueueEventList');

export const StartPrSessionBody = z
  .object({
    agent: z.enum(AGENTS),
    model: z.string().min(1).max(200).optional(),
    prompt: z.string().min(1).max(100_000).optional().openapi({ description: 'The first message. The agent starts on it when the sandbox is ready.' }),
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
      .optional()
      .openapi({ description: 'Lowercase letters, digits and hyphens. Default: made from the prompt. A name that a live session uses gets `-2`, `-3` and so on; read `name` in the response.' }),
    internet_access: z.boolean().optional(),
  })
  .strict()
  .openapi('StartPullRequestSessionRequest');
