import { and, eq, inArray, isNull, lte, lt, or } from 'drizzle-orm';
import type { WorkflowDefinition } from '@talyn/shared';
import { DEFAULT_POSTHOG_INBOX_ACTIONABILITY, workflowIntegrationOf } from '@talyn/shared';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { integrations, posthogInboxPollers, workflows as workflowsTable } from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { PostHogCodeApiError } from '../posthogCode/client.js';
import { POSTHOG_INTEGRATION_TYPE } from '../posthogCode/integrationRow.js';
import { TickGuard } from '../tickGuard.js';
import { enabledWorkflowsFor } from '../workflows/store.js';
import {
  workflowsKillSwitchPulled,
  workspaceMayUsePostHogInboxRules,
  workspaceMayUseWorkflows,
} from '../workflowsAccess.js';
import type { PostHogInboxListQuery, PostHogInboxReport } from './api.js';
import { getPostHogInboxConnection, type PostHogInboxConnection } from './connection.js';
import { timestampMicros } from './facts.js';
import { ingestPostHogReport } from './ingest.js';

/**
 * The PostHog Inbox poller: every few minutes, per PostHog connection that has
 * an enabled PostHog Inbox rule, it lists the reports that changed since its
 * cursor and hands each id to {@link ingestPostHogReport}.
 *
 * # Why a cursor on `updated_at`
 *
 * PostHog's report list has `created_after` but no "updated after" filter, so
 * the poller sorts by `-updated_at` and pages down until it reaches the
 * cursor. A report that changes moves back above the cursor and is read
 * again; the dedupe key (`posthog_inbox:<id>:<updated_at>`) decides whether
 * a rule acts on it again. The cursor is PostHog's own timestamp text, and
 * `cursor_report_ids` holds the reports at exactly that instant, so a tie is
 * neither lost nor read twice.
 *
 * A new connection's cursor starts at the moment of its first poll: rules
 * act on reports that become ready or change after that. The editor's dry
 * run shows what is ready now.
 *
 * # Safe across replicas
 *
 * Each connection has one `posthog_inbox_pollers` row. A replica takes it with
 * a conditional UPDATE (due, and no live lease) and writes the next poll time
 * and the cursor when it is done. A replica that dies mid-poll leaves a lease
 * that expires; the next poll starts from the last cursor it saved, and the
 * run claim (`UNIQUE (workflow_id, delivery_id)`) makes any repeat a no-op.
 */

const TICK_MS = 60_000;
/** How often one connection is polled. */
export const POSTHOG_INBOX_POLL_INTERVAL_MS = 3 * 60_000;
/** A poll that died keeps the connection for this long. */
const LEASE_MS = 15 * 60_000;
/** After a 401 or 403: the connection needs the user, not a retry. */
const AUTH_BACKOFF_MS = 30 * 60_000;
/** After any other failure. */
const ERROR_BACKOFF_MS = 10 * 60_000;
/** When a poll stopped at its ingest cap: come back soon for the rest. */
const CONTINUE_MS = 30_000;

const PAGE_LIMIT = 100;
/** Pages overlap, so a report that moves up between two page reads is not missed. */
const PAGE_STEP = 90;
const MAX_PAGES = 5;
/** Reports one poll hands to the engine. A run can start a session, which takes seconds. */
export const MAX_INGEST_PER_POLL = 10;
/** Connections one tick polls. */
const MAX_CONNECTIONS_PER_TICK = 20;

export interface PollerCursor {
  updatedAt: string | null;
  reportIds: string[];
}

export interface ListedReport {
  id: string;
  updatedAt: string;
  micros: number;
}

/**
 * PURE: the listed reports that are past the cursor, oldest first, without
 * repeats (the newest `updated_at` of a repeated id wins).
 */
export function reportsPastCursor(reports: Array<Pick<PostHogInboxReport, 'id' | 'updated_at'>>, cursor: PollerCursor): ListedReport[] {
  const cursorMicros = cursor.updatedAt ? timestampMicros(cursor.updatedAt) : NaN;
  const seenAtCursor = new Set(cursor.reportIds);
  const byId = new Map<string, ListedReport>();
  for (const report of reports) {
    const id = typeof report.id === 'string' ? report.id : '';
    const updatedAt = typeof report.updated_at === 'string' ? report.updated_at : '';
    const micros = timestampMicros(updatedAt);
    if (!id || Number.isNaN(micros)) continue;
    if (!Number.isNaN(cursorMicros)) {
      if (micros < cursorMicros) continue;
      if (micros === cursorMicros && seenAtCursor.has(id)) continue;
    }
    const known = byId.get(id);
    if (!known || known.micros < micros) byId.set(id, { id, updatedAt, micros });
  }
  return [...byId.values()].sort((a, b) => a.micros - b.micros || a.id.localeCompare(b.id));
}

/** PURE: the cursor after one more report was handled. Never moves back. */
export function advanceCursor(cursor: PollerCursor, report: ListedReport): PollerCursor {
  const cursorMicros = cursor.updatedAt ? timestampMicros(cursor.updatedAt) : NaN;
  if (Number.isNaN(cursorMicros) || report.micros > cursorMicros) {
    return { updatedAt: report.updatedAt, reportIds: [report.id] };
  }
  if (report.micros === cursorMicros && !cursor.reportIds.includes(report.id)) {
    return { updatedAt: cursor.updatedAt, reportIds: [...cursor.reportIds, report.id] };
  }
  return cursor;
}

/**
 * PURE: the list query for a set of rules. Always ready, not already
 * addressed and unclaimed. The actionability and priority filters are the
 * union of the rules' own, so PostHog does the coarse filtering; the matcher
 * still tests every rule.
 */
export function pollQuery(rules: WorkflowDefinition[]): PostHogInboxListQuery {
  const actionability = new Set<string>();
  for (const rule of rules) {
    for (const a of rule.conditions.actionability ?? DEFAULT_POSTHOG_INBOX_ACTIONABILITY) actionability.add(a);
  }
  // Only when EVERY rule names priorities: one rule without the condition
  // wants every priority, including reports PostHog has not judged.
  const everyRuleHasPriorities = rules.length > 0 && rules.every((r) => (r.conditions.priorities?.length ?? 0) > 0);
  const priorities = new Set<string>();
  if (everyRuleHasPriorities) for (const r of rules) for (const p of r.conditions.priorities ?? []) priorities.add(p);
  return {
    status: 'ready',
    actionability: [...actionability].sort().join(','),
    ...(priorities.size > 0 ? { priority: [...priorities].sort().join(',') } : {}),
    already_addressed: false,
    unclaimed: true,
    ordering: '-updated_at',
    include_source_metadata: false,
    limit: PAGE_LIMIT,
  };
}

/**
 * Read pages newest first until a page reaches the cursor. `truncated` when
 * the newest {@link MAX_PAGES} pages are all past the cursor.
 */
export async function listPastCursor(
  client: PostHogInboxConnection['client'],
  query: PostHogInboxListQuery,
  cursor: PollerCursor
): Promise<{ reports: ListedReport[]; truncated: boolean }> {
  const cursorMicros = cursor.updatedAt ? timestampMicros(cursor.updatedAt) : NaN;
  const all: Array<Pick<PostHogInboxReport, 'id' | 'updated_at'>> = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { results } = await client.listReports({ ...query, offset: page * PAGE_STEP });
    const rows = Array.isArray(results) ? results : [];
    all.push(...rows);
    const oldest = rows.length > 0 ? timestampMicros(rows[rows.length - 1].updated_at) : NaN;
    if (rows.length < PAGE_LIMIT) break;
    if (!Number.isNaN(cursorMicros) && !Number.isNaN(oldest) && oldest < cursorMicros) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { reports: reportsPastCursor(all, cursor), truncated };
}

export interface PollResult {
  status: 'initialized' | 'polled' | 'gated' | 'no_connection' | 'error';
  ingested: number;
  ran: number;
  cursor: PollerCursor;
  more: boolean;
  error?: string;
  errorStatus?: number | null;
  /** PostHog's Retry-After on a 429. */
  retryAfterMs?: number | null;
}

/**
 * Poll one connection once: list past the cursor, ingest the oldest first, and
 * move the cursor after each report that was handled. A failure keeps the
 * cursor at the last report that was handled.
 */
export async function pollConnection(
  connection: PostHogInboxConnection,
  rules: WorkflowDefinition[],
  cursor: PollerCursor,
  now: Date = new Date()
): Promise<PollResult> {
  if (!cursor.updatedAt) {
    return { status: 'initialized', ingested: 0, ran: 0, more: false, cursor: { updatedAt: now.toISOString(), reportIds: [] } };
  }
  let current = cursor;
  let ingested = 0;
  let ran = 0;
  try {
    const { reports, truncated } = await listPastCursor(connection.client, pollQuery(rules), cursor);
    if (truncated) {
      debugBus.recordEvent({
        service: 'workflows',
        action: 'posthog_inbox_backlog_truncated',
        summary: `connection ${connection.id}: more than ${MAX_PAGES} pages of reports changed since the last poll`,
        ok: false,
        workspaceId: connection.workspaceId,
      });
    }
    const batch = reports.slice(0, MAX_INGEST_PER_POLL);
    for (const report of batch) {
      try {
        const outcome = await ingestPostHogReport(connection, report.id);
        if (outcome.kind === 'evaluated') ran += outcome.ran;
      } catch (err) {
        // A report deleted between the list and the read is simply gone.
        if (!(err instanceof PostHogCodeApiError && err.status === 404)) throw err;
      }
      ingested += 1;
      current = advanceCursor(current, report);
    }
    return { status: 'polled', ingested, ran, cursor: current, more: reports.length > batch.length };
  } catch (err) {
    return {
      status: 'error',
      ingested,
      ran,
      cursor: current,
      more: false,
      error: err instanceof Error ? err.message : String(err),
      errorStatus: err instanceof PostHogCodeApiError ? err.status : null,
      retryAfterMs: err instanceof PostHogCodeApiError ? err.retryAfterMs : null,
    };
  }
}

/** PURE: when to poll a connection next, from how its poll ended. */
export function nextPollDelayMs(result: Pick<PollResult, 'status' | 'more' | 'errorStatus' | 'retryAfterMs'>): number {
  if (result.status === 'error') {
    if (result.errorStatus === 401 || result.errorStatus === 403) return AUTH_BACKOFF_MS;
    if (result.errorStatus === 429) return Math.max(POSTHOG_INBOX_POLL_INTERVAL_MS, result.retryAfterMs ?? 0);
    return ERROR_BACKOFF_MS;
  }
  if (result.status === 'no_connection') return AUTH_BACKOFF_MS;
  if (result.more) return CONTINUE_MS;
  return POSTHOG_INBOX_POLL_INTERVAL_MS;
}

const db = () => getPoolDbClient();

/** The PostHog connections that have at least one enabled PostHog Inbox rule. */
async function connectionsWithRules(): Promise<Array<{ integrationId: string; workspaceId: string }>> {
  return db()
    .selectDistinct({ integrationId: integrations.id, workspaceId: integrations.workspaceId })
    .from(workflowsTable)
    .innerJoin(
      integrations,
      and(
        eq(integrations.workspaceId, workflowsTable.workspaceId),
        eq(integrations.type, POSTHOG_INTEGRATION_TYPE),
        eq(integrations.enabled, true)
      )
    )
    .where(and(eq(workflowsTable.integration, 'posthog_inbox'), eq(workflowsTable.enabled, true)));
}

/**
 * Take a connection's row for one poll: due, and no live lease. The
 * conditional UPDATE is the claim, so two replicas cannot both win it.
 */
export async function claimPoller(integrationId: string, now: Date): Promise<PollerCursor | null> {
  const rows = await db()
    .update(posthogInboxPollers)
    .set({ leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now })
    .where(
      and(
        eq(posthogInboxPollers.integrationId, integrationId),
        lte(posthogInboxPollers.nextPollAt, now),
        or(isNull(posthogInboxPollers.leaseUntil), lt(posthogInboxPollers.leaseUntil, now))
      )
    )
    .returning({ cursorUpdatedAt: posthogInboxPollers.cursorUpdatedAt, cursorReportIds: posthogInboxPollers.cursorReportIds });
  const row = rows[0];
  if (!row) return null;
  return { updatedAt: row.cursorUpdatedAt, reportIds: Array.isArray(row.cursorReportIds) ? row.cursorReportIds : [] };
}

/** Save the poll's outcome and release the lease. */
async function settlePoller(integrationId: string, result: PollResult, now: Date, delayMs: number): Promise<void> {
  const polled = result.status === 'polled' || result.status === 'initialized';
  await db()
    .update(posthogInboxPollers)
    .set({
      cursorUpdatedAt: result.cursor.updatedAt,
      cursorReportIds: result.cursor.reportIds,
      nextPollAt: new Date(now.getTime() + delayMs),
      leaseUntil: null,
      updatedAt: new Date(),
      ...(polled ? { lastPolledAt: now, lastError: null, lastErrorStatus: null } : {}),
      ...(result.status === 'error' || result.status === 'no_connection'
        ? { lastError: (result.error ?? 'error').slice(0, 500), lastErrorStatus: result.errorStatus ?? null }
        : {}),
    })
    .where(eq(posthogInboxPollers.integrationId, integrationId));
}

/** The enabled PostHog Inbox rules of a workspace. */
async function inboxRules(workspaceId: string): Promise<WorkflowDefinition[]> {
  return (await enabledWorkflowsFor(workspaceId)).filter((w) => workflowIntegrationOf(w) === 'posthog_inbox');
}

class PostHogInboxPoller {
  private timer: NodeJS.Timeout | null = null;
  private guard = new TickGuard('posthog_inbox_poller', LEASE_MS);

  init(): void {
    if (this.timer) return;
    debugBus.registerPoller(
      'posthog_inbox_poller',
      TICK_MS,
      'PostHog Inbox rules: every 3 minutes per PostHog connection with an enabled rule, reads the reports that changed and runs the rules on them.'
    );
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now: Date = new Date()): Promise<number> {
    if (!this.guard.tryBegin()) return 0;
    const startedAt = Date.now();
    try {
      const polled = await this.run(now);
      debugBus.pollerTick('posthog_inbox_poller', { durationMs: Date.now() - startedAt, ok: true });
      return polled;
    } catch (err) {
      debugBus.pollerTick('posthog_inbox_poller', { durationMs: Date.now() - startedAt, ok: false, error: err });
      return 0;
    } finally {
      this.guard.end();
    }
  }

  private async run(now: Date): Promise<number> {
    if (workflowsKillSwitchPulled()) return 0;
    const candidates = await connectionsWithRules();
    if (candidates.length === 0) return 0;
    await db()
      .insert(posthogInboxPollers)
      .values(candidates.map((c) => ({ integrationId: c.integrationId, workspaceId: c.workspaceId, nextPollAt: now })))
      .onConflictDoNothing({ target: posthogInboxPollers.integrationId });

    const due = await db()
      .select({ integrationId: posthogInboxPollers.integrationId, workspaceId: posthogInboxPollers.workspaceId })
      .from(posthogInboxPollers)
      .where(
        and(
          inArray(posthogInboxPollers.integrationId, candidates.map((c) => c.integrationId)),
          lte(posthogInboxPollers.nextPollAt, now),
          or(isNull(posthogInboxPollers.leaseUntil), lt(posthogInboxPollers.leaseUntil, now))
        )
      )
      .orderBy(posthogInboxPollers.nextPollAt)
      .limit(MAX_CONNECTIONS_PER_TICK);

    let polled = 0;
    for (const row of due) {
      const cursor = await claimPoller(row.integrationId, now);
      if (!cursor) continue; // Another replica took it.
      polled += 1;
      await this.pollOne(row.integrationId, row.workspaceId, cursor, now);
    }
    return polled;
  }

  private async pollOne(integrationId: string, workspaceId: string, cursor: PollerCursor, now: Date): Promise<void> {
    let result: PollResult;
    try {
      const allowed =
        (await workspaceMayUseWorkflows(workspaceId)) && (await workspaceMayUsePostHogInboxRules(workspaceId));
      const rules = allowed ? await inboxRules(workspaceId) : [];
      const connection = allowed && rules.length > 0 ? await getPostHogInboxConnection(workspaceId) : null;
      if (!allowed || rules.length === 0) {
        result = { status: 'gated', ingested: 0, ran: 0, more: false, cursor };
      } else if (!connection || connection.id !== integrationId) {
        result = {
          status: 'no_connection',
          ingested: 0,
          ran: 0,
          more: false,
          cursor,
          error: 'The PostHog connection cannot read the Inbox. Connect PostHog again.',
          errorStatus: null,
        };
      } else {
        result = await pollConnection(connection, rules, cursor, now);
      }
    } catch (err) {
      result = {
        status: 'error',
        ingested: 0,
        ran: 0,
        more: false,
        cursor,
        error: err instanceof Error ? err.message : String(err),
        errorStatus: err instanceof PostHogCodeApiError ? err.status : null,
        retryAfterMs: err instanceof PostHogCodeApiError ? err.retryAfterMs : null,
      };
    }
    await settlePoller(integrationId, result, now, nextPollDelayMs(result));
    debugBus.recordEvent({
      service: 'workflows',
      action: `posthog_inbox_poll:${result.status}`,
      summary: `connection ${integrationId}: ${result.ingested} report(s) read, ${result.ran} run(s)${result.error ? ` — ${result.error}` : ''}`,
      ok: result.status !== 'error' && result.status !== 'no_connection',
      workspaceId,
    });
  }
}

export const posthogInboxPoller = new PostHogInboxPoller();

/** Wrapped so the timer's work never inherits a request's transaction handle. */
export function initPostHogInboxPoller(): void {
  runWithoutScope(() => posthogInboxPoller.init());
}

/** The poller's state for one connection, for the editor's status line. */
export async function pollerState(integrationId: string): Promise<{
  lastPolledAt: Date | null;
  lastError: string | null;
  lastErrorStatus: number | null;
} | null> {
  const rows = await db()
    .select({
      lastPolledAt: posthogInboxPollers.lastPolledAt,
      lastError: posthogInboxPollers.lastError,
      lastErrorStatus: posthogInboxPollers.lastErrorStatus,
    })
    .from(posthogInboxPollers)
    .where(eq(posthogInboxPollers.integrationId, integrationId))
    .limit(1);
  return rows[0] ?? null;
}

