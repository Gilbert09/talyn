import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import { pullRequests as pullRequestsTable } from '../../db/schema.js';
import { newEventId } from './signing.js';

/**
 * The webhook event catalogue and the shapes events carry.
 *
 * Event names are part of the public contract: never rename one. A new event
 * is additive. `data.object` is the object the event is about, in the same
 * snake_case shape the REST API returns for it where one exists.
 */

export const WEBHOOK_EVENT_TYPES = [
  'session.created',
  'session.updated',
  'session.archived',
  'session.pull_request_opened',
  'chat.turn_started',
  'chat.turn_completed',
  'pull_request.updated',
  'pull_request.merged',
  'pull_request.closed',
  'merge_queue.blocked',
  'code_review.completed',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** `ping` is sent only by `POST /webhooks/{id}/test`; an endpoint cannot subscribe to it. */
export type WebhookDeliveryEventType = WebhookEventType | 'ping';

export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEventType, string> = {
  'session.created': 'A session was started, in the app or through the API. `data.object` is the session.',
  'session.updated':
    "A session's status changed, for example from `provisioning` to `ready` or `error`. `data.previous_attributes` holds the old values.",
  'session.archived': 'A session was archived. `data.object` is the session.',
  'session.pull_request_opened':
    'A pull request was linked to a session: the agent or a person opened it from the session, or linked an existing one. `data.object` is the session; `data.pull_request` is the pull request.',
  'chat.turn_started': 'The agent started a turn in a chat. `data.turn` is the turn number.',
  'chat.turn_completed':
    'A turn ended. `data.final_status` is how it ended: `idle` (done or cancelled), `awaiting_input` or `error`.',
  'pull_request.updated':
    'A tracked pull request changed its title, draft state or open state. `data.previous_attributes` holds the old values.',
  'pull_request.merged': 'A tracked pull request was merged.',
  'pull_request.closed': 'A tracked pull request was closed without a merge.',
  'merge_queue.blocked':
    'The merge queue gave up on a pull request after its fix attempts. `data.reason` says why; a person must act.',
  'code_review.completed':
    'A code review cycle finished. `data.object.result` is `ready` (findings are ready) or `failed`.',
};

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === 'string' && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/** The body of every delivery. */
export interface WebhookEnvelope {
  id: string;
  type: WebhookDeliveryEventType;
  created_at: string;
  workspace_id: string | null;
  data: { object: Record<string, unknown> } & Record<string, unknown>;
}

/**
 * The event id. A deterministic `key` makes the id a hash of it, so the same
 * fact seen twice (two replicas, a re-emit) has one id, and the unique key
 * `(endpoint_id, event_id)` enqueues it once.
 */
export function eventIdFor(key?: string): string {
  if (!key) return newEventId();
  return `evt_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

export function buildEnvelope(
  type: WebhookDeliveryEventType,
  workspaceId: string | null,
  data: WebhookEnvelope['data'],
  opts: { key?: string; now?: Date } = {},
): WebhookEnvelope {
  return {
    id: eventIdFor(opts.key),
    type,
    created_at: (opts.now ?? new Date()).toISOString(),
    workspace_id: workspaceId,
    data,
  };
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

/**
 * A small, stable pull request shape for events. Read in SQL from the row so
 * `last_summary` never ships: only three of its keys are taken.
 */
export const WEBHOOK_PULL_REQUEST_COLUMNS = {
  id: pullRequestsTable.id,
  workspaceId: pullRequestsTable.workspaceId,
  repositoryId: pullRequestsTable.repositoryId,
  owner: pullRequestsTable.owner,
  repo: pullRequestsTable.repo,
  number: pullRequestsTable.number,
  state: pullRequestsTable.state,
  mergedAt: pullRequestsTable.mergedAt,
  title: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'title'`,
  draft: sql<boolean | null>`(${pullRequestsTable.lastSummary} ->> 'draft')::boolean`,
  url: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'url'`,
} as const;

export interface WebhookPullRequestRow {
  id: string;
  workspaceId: string;
  repositoryId: string;
  owner: string;
  repo: string;
  number: number;
  state: string;
  mergedAt: Date | null;
  title: string | null;
  draft: boolean | null;
  url: string | null;
}

export function webhookPullRequestQuery(id: string) {
  return getPoolDbClient().select(WEBHOOK_PULL_REQUEST_COLUMNS).from(pullRequestsTable).where(eq(pullRequestsTable.id, id)).limit(1);
}

export function toWebhookPullRequest(row: WebhookPullRequestRow) {
  const fullName = `${row.owner}/${row.repo}`;
  const state = row.state === 'merged' || row.state === 'closed' ? row.state : 'open';
  return {
    object: 'pull_request' as const,
    id: row.id,
    workspace_id: row.workspaceId,
    repository_id: row.repositoryId,
    repository_full_name: fullName,
    number: row.number,
    title: row.title ?? '',
    state: state as 'open' | 'closed' | 'merged',
    draft: row.draft === true,
    html_url: row.url ?? `https://github.com/${fullName}/pull/${row.number}`,
    merged_at: row.mergedAt ? row.mergedAt.toISOString() : null,
  };
}

export type WebhookPullRequest = ReturnType<typeof toWebhookPullRequest>;

// ---------------------------------------------------------------------------
// Code reviews
// ---------------------------------------------------------------------------

/** What the code review payload on `pull_request:updated` carries that events use. */
export interface CodeReviewSignal {
  id: string;
  phase: string;
  reviewedHeadSha?: string | null;
  headSha?: string | null;
  openCount?: number;
  counts?: Record<string, number> | null;
  failureReason?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export function toWebhookCodeReview(review: CodeReviewSignal, pr: { id: string; workspaceId: string }) {
  return {
    object: 'code_review' as const,
    id: review.id,
    workspace_id: pr.workspaceId,
    pull_request_id: pr.id,
    result: (review.phase === 'failed' ? 'failed' : 'ready') as 'ready' | 'failed',
    head_sha: review.reviewedHeadSha || review.headSha || null,
    open_finding_count: typeof review.openCount === 'number' ? review.openCount : 0,
    failure_reason: review.phase === 'failed' ? (review.failureReason ?? null) : null,
    finished_at: review.finishedAt ?? null,
  };
}
