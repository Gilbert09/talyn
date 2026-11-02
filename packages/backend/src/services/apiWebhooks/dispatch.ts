import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import {
  apiWebhookEndpoints as endpointsTable,
  apiWebhookObjectStates as statesTable,
  users as usersTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { userMayUsePublicApi } from '../public/access.js';
import { publicSessionStatus, toPublicChat, toPublicSession } from '../public/projections.js';
import { getChatQuery, getSessionQuery } from '../public/queries.js';
import { toJsonbSafe } from '../workbenches/jsonSafe.js';
import {
  buildEnvelope,
  toWebhookCodeReview,
  toWebhookPullRequest,
  webhookPullRequestQuery,
  type CodeReviewSignal,
  type WebhookEnvelope,
  type WebhookEventType,
} from './events.js';
import type { WebhookSignal } from './signals.js';
import { enqueueDeliveries } from './store.js';
import { webhookDeliveryWorker } from './worker.js';

/**
 * The ONE way an internal change becomes a webhook event.
 *
 * Emitters call `sendWebhookSignal` (signals.ts) beside their WebSocket
 * emit, and it lands here. It returns at once: the work runs in the
 * background, off any request scope, and a fault is logged and swallowed. It
 * never sends HTTP; it writes delivery rows, and the delivery worker sends them.
 *
 * Hooked at the ORIGIN of each change (the process that made it), not on the
 * WebSocket fan-out: `subscribeWorkspace` also receives frames relayed from
 * other replicas, so a listener there would enqueue once per replica.
 *
 * Exactly-once, across replicas, comes from two places:
 *  - A fact with a natural key (a turn number, a merge, a review cycle) gets a
 *    deterministic event id, and `UNIQUE (endpoint_id, event_id)` drops a repeat.
 *  - A change of state (a session's status, a pull request's title) is found
 *    with a compare-and-set on `api_webhook_object_states`: the upsert that
 *    changes the stored state is the one that announces it.
 *
 * Signals for one object run one after another in this process, so a quick
 * pair of emits is compared in the order they happened.
 */

const SESSION_EVENTS: WebhookEventType[] = ['session.created', 'session.updated', 'session.archived', 'session.pull_request_opened'];
const PULL_REQUEST_EVENTS: WebhookEventType[] = ['pull_request.updated', 'pull_request.merged', 'pull_request.closed'];

// ---------------------------------------------------------------------------
// Which endpoints listen to a workspace
// ---------------------------------------------------------------------------

interface Targets {
  endpoints: Array<{ id: string; eventTypes: string[] }>;
}

/**
 * Endpoints per workspace, cached for 30 seconds per process. Most workspaces
 * have none, and the emitters fire on every check run, so the cache is what
 * keeps the dispatcher at one small query per workspace per 30 seconds. A new
 * endpoint is seen at once on the process that created it and within 30
 * seconds on the others. A disabled endpoint that is still cached gets rows;
 * the worker abandons them.
 */
const TARGET_TTL_MS = 30_000;
const TARGET_CACHE_MAX = 10_000;
const targetCache = new Map<string, { at: number; value: Promise<Targets> }>();

async function loadTargets(workspaceId: string): Promise<Targets> {
  const rows = await getPoolDbClient()
    .select({ id: endpointsTable.id, eventTypes: endpointsTable.eventTypes, ownerId: workspacesTable.ownerId, email: usersTable.email })
    .from(workspacesTable)
    .innerJoin(
      endpointsTable,
      and(
        eq(endpointsTable.ownerId, workspacesTable.ownerId),
        eq(endpointsTable.enabled, true),
        or(isNull(endpointsTable.workspaceId), eq(endpointsTable.workspaceId, workspacesTable.id)),
      ),
    )
    .leftJoin(usersTable, eq(usersTable.id, workspacesTable.ownerId))
    .where(eq(workspacesTable.id, workspaceId));
  if (rows.length === 0) return { endpoints: [] };
  // The API's own flag decides whether its webhooks run, like its requests.
  if (!(await userMayUsePublicApi({ distinctId: rows[0].ownerId, email: rows[0].email }))) return { endpoints: [] };
  return { endpoints: rows.map((r) => ({ id: r.id, eventTypes: r.eventTypes ?? [] })) };
}

function targetsFor(workspaceId: string): Promise<Targets> {
  const now = Date.now();
  const hit = targetCache.get(workspaceId);
  if (hit && now - hit.at < TARGET_TTL_MS) return hit.value;
  if (targetCache.size >= TARGET_CACHE_MAX) {
    const oldest = targetCache.keys().next().value;
    if (oldest !== undefined) targetCache.delete(oldest);
  }
  const value = loadTargets(workspaceId);
  targetCache.set(workspaceId, { at: now, value });
  value.catch(() => targetCache.delete(workspaceId));
  return value;
}

/** Forget cached endpoints. Called after an endpoint is created, changed or deleted on this process. */
export function invalidateWebhookTargets(): void {
  targetCache.clear();
}

function listening(targets: Targets, type: WebhookEventType): string[] {
  return targets.endpoints.filter((e) => e.eventTypes.length === 0 || e.eventTypes.includes(type)).map((e) => e.id);
}

function anyListening(targets: Targets, types: WebhookEventType[]): boolean {
  return types.some((t) => listening(targets, t).length > 0);
}

async function publish(targets: Targets, envelope: WebhookEnvelope): Promise<void> {
  const ids = listening(targets, envelope.type as WebhookEventType);
  if (ids.length === 0) return;
  const inserted = await enqueueDeliveries(ids, toJsonbSafe(envelope));
  if (inserted > 0) webhookDeliveryWorker.nudge();
}

// ---------------------------------------------------------------------------
// The last announced state of an object
// ---------------------------------------------------------------------------

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/**
 * Store `fingerprint` for `key` when it differs from what is stored. Returns
 * the old value and whether THIS call changed it. Two callers with the same
 * new state: the second waits on the row, sees it already equal, and gets
 * `changed: false`.
 */
export async function swapObjectState(key: string, fingerprint: string): Promise<{ previous: string | null; changed: boolean }> {
  const result = await getPoolDbClient().execute(sql`
    WITH old AS (
      SELECT fingerprint FROM api_webhook_object_states WHERE object_key = ${key}
    ), up AS (
      INSERT INTO api_webhook_object_states (object_key, fingerprint, updated_at)
      VALUES (${key}, ${fingerprint}, now())
      ON CONFLICT (object_key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, updated_at = now()
      WHERE api_webhook_object_states.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
      RETURNING 1
    )
    SELECT (SELECT fingerprint FROM old) AS previous, (SELECT count(*) FROM up)::int AS changed
  `);
  const row = rowsOf<{ previous: string | null; changed: number | string }>(result)[0];
  return { previous: row?.previous ?? null, changed: Number(row?.changed ?? 0) > 0 };
}

async function setObjectState(key: string, fingerprint: string): Promise<void> {
  await getPoolDbClient()
    .insert(statesTable)
    .values({ objectKey: key, fingerprint })
    .onConflictDoUpdate({ target: statesTable.objectKey, set: { fingerprint, updatedAt: new Date() } });
}

function parseState<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

interface SessionState {
  s: string;
  pr: string | null;
}

function sessionState(session: { status: string; archivedAt: string | Date | null; pullRequestId: string | null }): SessionState {
  const archivedAt = session.archivedAt ? new Date(session.archivedAt) : null;
  return { s: publicSessionStatus({ status: session.status, archivedAt }), pr: session.pullRequestId ?? null };
}

async function readSession(id: string) {
  const [row] = await getSessionQuery(id);
  return row ?? null;
}

async function onSessionCreated(signal: Extract<WebhookSignal, { kind: 'session_created' }>, targets: Targets): Promise<void> {
  const row = await readSession(signal.sessionId);
  if (!row) return;
  // The baseline, so the emit that follows the create is not read as a change.
  await setObjectState(`session:${row.id}`, JSON.stringify(sessionState(row)));
  await publish(
    targets,
    buildEnvelope('session.created', signal.workspaceId, { object: toPublicSession(row) }, { key: `session.created:${row.id}` }),
  );
}

async function onSession(signal: Extract<WebhookSignal, { kind: 'session' }>, targets: Targets): Promise<void> {
  const next = sessionState(signal.session);
  const { previous, changed } = await swapObjectState(`session:${signal.session.id}`, JSON.stringify(next));
  if (!changed) return;
  const row = await readSession(signal.session.id);
  if (!row) return;
  const object = toPublicSession(row);
  const old = parseState<SessionState>(previous);

  if (!old || old.s !== next.s) {
    if (next.s === 'archived') {
      const archivedAt = row.archivedAt ? row.archivedAt.toISOString() : 'unknown';
      await publish(
        targets,
        buildEnvelope('session.archived', signal.workspaceId, { object }, { key: `session.archived:${row.id}:${archivedAt}` }),
      );
    } else {
      // No previous value the first time this session is seen: the receiver gets its current state.
      await publish(
        targets,
        buildEnvelope('session.updated', signal.workspaceId, {
          object,
          previous_attributes: old ? { status: old.s } : {},
        }),
      );
    }
  }
  if (old && next.pr && next.pr !== old.pr) {
    const [pr] = await webhookPullRequestQuery(next.pr);
    await publish(
      targets,
      buildEnvelope(
        'session.pull_request_opened',
        signal.workspaceId,
        { object, pull_request: pr ? toWebhookPullRequest(pr) : null },
        { key: `session.pull_request_opened:${row.id}:${next.pr}` },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

async function onTurn(signal: Extract<WebhookSignal, { kind: 'turn_started' | 'turn_completed' }>, targets: Targets): Promise<void> {
  const type: WebhookEventType = signal.kind === 'turn_started' ? 'chat.turn_started' : 'chat.turn_completed';
  if (listening(targets, type).length === 0) return;
  const [chat] = await getChatQuery(signal.chatId);
  if (!chat) return;
  const data: WebhookEnvelope['data'] = { object: toPublicChat(chat), turn: signal.turn };
  if (signal.kind === 'turn_completed') data.final_status = signal.finalStatus;
  await publish(targets, buildEnvelope(type, signal.workspaceId, data, { key: `${type}:${signal.chatId}:${signal.turn}` }));
}

// ---------------------------------------------------------------------------
// Pull requests and code reviews
// ---------------------------------------------------------------------------

interface PullRequestState {
  s: string;
  d: boolean;
  t: string;
}

function pullRequestState(pr: { state: string; lastSummary: Record<string, unknown> }): PullRequestState {
  const summary = pr.lastSummary ?? {};
  return {
    s: pr.state === 'merged' || pr.state === 'closed' ? pr.state : 'open',
    d: summary.draft === true,
    t: typeof summary.title === 'string' ? summary.title : '',
  };
}

async function onPullRequest(signal: Extract<WebhookSignal, { kind: 'pull_request' }>, targets: Targets): Promise<void> {
  const { pullRequest } = signal;
  if (anyListening(targets, PULL_REQUEST_EVENTS)) {
    const next = pullRequestState(pullRequest);
    const { previous, changed } = await swapObjectState(`pull_request:${pullRequest.id}`, JSON.stringify(next));
    const old = parseState<PullRequestState>(previous);
    // The first sight records a baseline and sends nothing: pull requests emit on
    // every check run, and announcing every tracked one once would be a burst
    // with no news in it.
    if (changed && old) {
      const [row] = await webhookPullRequestQuery(pullRequest.id);
      if (row) {
        const object = toWebhookPullRequest(row);
        if (old.s === 'open' && next.s === 'merged') {
          await publish(targets, buildEnvelope('pull_request.merged', signal.workspaceId, { object }, { key: `pull_request.merged:${row.id}` }));
        } else if (old.s === 'open' && next.s === 'closed') {
          await publish(targets, buildEnvelope('pull_request.closed', signal.workspaceId, { object }));
        } else {
          const previousAttributes: Record<string, unknown> = {};
          if (old.s !== next.s) previousAttributes.state = old.s;
          if (old.d !== next.d) previousAttributes.draft = old.d;
          if (old.t !== next.t) previousAttributes.title = old.t;
          await publish(
            targets,
            buildEnvelope('pull_request.updated', signal.workspaceId, { object, previous_attributes: previousAttributes }),
          );
        }
      }
    }
  }

  const review = pullRequest.codeReview as CodeReviewSignal | null | undefined;
  if (review && (review.phase === 'ready' || review.phase === 'failed') && listening(targets, 'code_review.completed').length > 0) {
    // The cycle's start names the cycle: the same review broadcast again (a
    // finding dismissed) is the same event.
    const cycle = review.startedAt ?? review.finishedAt ?? review.headSha ?? '';
    await publish(
      targets,
      buildEnvelope(
        'code_review.completed',
        signal.workspaceId,
        { object: toWebhookCodeReview(review, { id: pullRequest.id, workspaceId: signal.workspaceId }) },
        { key: `code_review.completed:${review.id}:${review.phase}:${cycle}` },
      ),
    );
  }
}

async function onMergeQueueBlocked(signal: Extract<WebhookSignal, { kind: 'merge_queue_blocked' }>, targets: Targets): Promise<void> {
  if (listening(targets, 'merge_queue.blocked').length === 0) return;
  const [row] = await webhookPullRequestQuery(signal.pullRequestId);
  if (!row) return;
  await publish(
    targets,
    buildEnvelope('merge_queue.blocked', signal.workspaceId, {
      object: toWebhookPullRequest(row),
      reason: signal.reason,
      attempts: signal.attempts,
    }),
  );
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

function objectKey(signal: WebhookSignal): string {
  switch (signal.kind) {
    case 'session_created':
      return `session:${signal.sessionId}`;
    case 'session':
      return `session:${signal.session.id}`;
    case 'turn_started':
    case 'turn_completed':
      return `chat:${signal.chatId}`;
    case 'pull_request':
      return `pull_request:${signal.pullRequest.id}`;
    case 'merge_queue_blocked':
      return `pull_request:${signal.pullRequestId}`;
  }
}

async function handle(signal: WebhookSignal): Promise<void> {
  const targets = await targetsFor(signal.workspaceId);
  if (targets.endpoints.length === 0) return;
  switch (signal.kind) {
    case 'session_created':
      if (anyListening(targets, SESSION_EVENTS)) await onSessionCreated(signal, targets);
      return;
    case 'session':
      if (anyListening(targets, SESSION_EVENTS)) await onSession(signal, targets);
      return;
    case 'turn_started':
    case 'turn_completed':
      await onTurn(signal, targets);
      return;
    case 'pull_request':
      await onPullRequest(signal, targets);
      return;
    case 'merge_queue_blocked':
      await onMergeQueueBlocked(signal, targets);
      return;
  }
}

const chains = new Map<string, Promise<void>>();

/**
 * Turn an internal change into webhook events. Never throws and never waits:
 * an emitter's own work must not depend on a webhook.
 */
export function dispatchWebhookSignal(signal: WebhookSignal): void {
  try {
    const key = objectKey(signal);
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(() =>
      runWithoutScope(() => handle(signal)).catch((error: unknown) => {
        debugBus.recordEvent({
          service: 'api_webhooks',
          action: 'dispatch_failed',
          ok: false,
          summary: `${signal.kind} in ${signal.workspaceId.slice(0, 8)}`,
          error,
        });
      }),
    );
    chains.set(key, next);
    void next.then(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
  } catch (error) {
    console.warn('[api-webhooks] dispatch failed:', error instanceof Error ? error.message : error);
  }
}

/** Tests: wait until every signal dispatched so far has been handled. */
export async function settleWebhookDispatchForTests(): Promise<void> {
  while (chains.size > 0) await Promise.all([...chains.values()]);
}

export function resetWebhookDispatchForTests(): void {
  targetCache.clear();
  chains.clear();
}
