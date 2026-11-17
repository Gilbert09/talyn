import { and, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type {
  PostHogInboxBacklogCount,
  PostHogInboxBacklogDays,
  PostHogInboxBacklogPage,
  PostHogInboxBacklogRow,
  PostHogInboxBacklogState,
  PostHogInboxFacts,
  PostHogInboxRunResponse,
  PostHogInboxRunResult,
  WorkflowConditions,
  WorkflowDefinition,
} from '@talyn/shared';
import {
  DEFAULT_POSTHOG_INBOX_ACTIONABILITY,
  MAX_POSTHOG_INBOX_BACKLOG_COUNT_SCAN,
  MAX_POSTHOG_INBOX_RUN_REPORTS,
  POSTHOG_INBOX_BACKLOG_STATE_LABELS,
  posthogInboxBacklogState,
  posthogInboxContentMatches,
  posthogInboxMismatchReason,
  posthogInboxRunSummary,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { externalIssueLinks, workflowRuns } from '../../db/schema.js';
import { PostHogCodeApiError } from '../posthogCode/client.js';
import { runWorkflowManually, type ManualRunOutcome } from '../workflows/engine.js';
import { checkDailyCap } from '../workflows/runs.js';
import {
  posthogInboxDeliveryId,
  posthogInboxWorkflowSource,
  preparePostHogInboxFacts,
  workspaceRepositoryIds,
} from '../workflows/sources/posthogInbox.js';
import type { PostHogInboxReport, PostHogInboxListQuery } from './api.js';
import type { PostHogInboxConnection } from './connection.js';
import { reportToFacts } from './facts.js';

/**
 * The backlog of a PostHog Inbox rule: older reports that match it, and
 * "Run selected" to start work on some of them.
 *
 * A rule acts only on reports that change after its connection's first poll
 * (the poller cursor). The backlog reads further back, up to all time:
 * PostHog's own filters narrow the list (status, priority, actionability,
 * source product, scout, search, `created_after`), then Talyn's matcher
 * applies the rest. A page reads more PostHog pages until it has a page of
 * matches, so a narrow rule does not show empty pages. A separate count reads
 * the whole range (up to a limit) and says exactly how many reports match.
 * Each row says where the report stands for Talyn, and only a row the rule
 * would act on can be selected.
 *
 * A manual run goes through the engine (`runWorkflowManually`): the same
 * matcher, caps, dedupe key, link, PostHog claim and session as a poll. It
 * reads each report again by id first, so a stale list never decides.
 */

/** Matching reports one backlog page shows, and the size of each PostHog read for it. */
export const BACKLOG_PAGE_SIZE = 25;
/** The most reports one backlog page reads from PostHog while it looks for a page of matches. */
export const BACKLOG_PAGE_SCAN_LIMIT = 100;
/** The size of each PostHog read for a backlog count. */
export const BACKLOG_COUNT_READ_SIZE = 100;
/** Parallel report reads (a list row without its repository, or the reviewers artefact). */
const READ_CONCURRENCY = 5;

const db = () => getPoolDbClient();

/**
 * PURE: PostHog's list filters for a rule's backlog. Each one keeps a superset
 * of what the rule matches. `'all'` sends no `created_after`.
 */
export function backlogQuery(
  conditions: WorkflowConditions,
  days: PostHogInboxBacklogDays,
  offset: number,
  now: Date = new Date(),
  limit: number = BACKLOG_PAGE_SIZE
): PostHogInboxListQuery {
  const join = (values: readonly string[] | undefined): string | undefined => {
    const list = [...new Set((values ?? []).map((v) => v.trim()).filter(Boolean))].sort();
    return list.length > 0 ? list.join(',') : undefined;
  };
  const search = (conditions.titleContains ?? '').trim() || (conditions.summaryContains ?? '').trim();
  return {
    // `suppressed` for the reports the safety judge held back: the backlog
    // shows them, and never lets them be selected.
    status: 'ready,suppressed',
    actionability: join(conditions.actionability ?? [...DEFAULT_POSTHOG_INBOX_ACTIONABILITY]),
    priority: join(conditions.priorities),
    source_product: join(conditions.sourceProducts),
    scout: join(conditions.scouts?.include),
    // PostHog's search reads the title OR the summary, a superset of either condition.
    search: search || undefined,
    created_after: days === 'all' ? undefined : new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString(),
    ordering: '-created_at',
    include_source_metadata: true,
    limit,
    offset: Math.max(0, Math.floor(offset)),
  };
}

/** PURE: whether PostHog has more reports after this page. `next` decides when it is sent (null on the last page). */
export function listHasMore(page: { next?: string | null }, read: number, limit: number): boolean {
  return page.next !== undefined ? typeof page.next === 'string' && page.next.length > 0 : read >= limit;
}

/** PURE: whether somebody holds the report in PostHog. */
export function claimedInPostHog(report: Pick<PostHogInboxReport, 'assignee' | 'implementation_pr_url' | 'implementation_pr_state'>): boolean {
  if (report.assignee && (report.assignee.claim_id || report.assignee.kind)) return true;
  const prState = (report.implementation_pr_state ?? '').toLowerCase();
  return !!report.implementation_pr_url && (prState === '' || prState === 'unknown' || prState === 'draft' || prState === 'open');
}

/** Talyn's links to these reports, newest first per report. */
async function linksFor(workspaceId: string, reportIds: string[]) {
  if (reportIds.length === 0) return new Map<string, LinkSummary[]>();
  const rows = await db()
    .select({
      externalId: externalIssueLinks.externalId,
      status: externalIssueLinks.status,
      runId: externalIssueLinks.runId,
      workbenchId: externalIssueLinks.workbenchId,
      pullRequestId: externalIssueLinks.pullRequestId,
      claimId: externalIssueLinks.posthogClaimId,
      prUrl: externalIssueLinks.posthogClaimPrUrl,
      createdAt: externalIssueLinks.createdAt,
    })
    .from(externalIssueLinks)
    .where(
      and(
        eq(externalIssueLinks.workspaceId, workspaceId),
        eq(externalIssueLinks.integration, 'posthog_inbox'),
        inArray(externalIssueLinks.externalId, reportIds)
      )
    )
    .orderBy(desc(externalIssueLinks.createdAt));
  const out = new Map<string, LinkSummary[]>();
  for (const row of rows) out.set(row.externalId, [...(out.get(row.externalId) ?? []), row]);
  return out;
}

interface LinkSummary {
  status: string;
  runId: string | null;
  workbenchId: string | null;
  pullRequestId: string | null;
  claimId: string | null;
  prUrl: string | null;
}

/** This rule's runs for these report versions, by delivery id. */
async function runsFor(workflowId: string, deliveryIds: string[]) {
  const out = new Map<string, { id: string; status: string }>();
  if (deliveryIds.length === 0) return out;
  const rows = await db()
    .select({ id: workflowRuns.id, deliveryId: workflowRuns.deliveryId, status: workflowRuns.status })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.workflowId, workflowId), inArray(workflowRuns.deliveryId, deliveryIds)));
  for (const row of rows) out.set(row.deliveryId, { id: row.id, status: row.status });
  return out;
}

/** Runs in the last 24 hours that count toward the daily cap (`checkDailyCap` counts the same). */
export async function runsInLastDay(workflowId: string, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 24 * 60 * 60_000);
  const rows = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.workflowId, workflowId), gt(workflowRuns.createdAt, since), ne(workflowRuns.status, 'skipped')));
  return Number(rows[0]?.n ?? 0);
}

/** The facts of one report for this workspace, read again by id when the list row lacks the repository. */
async function factsFor(
  connection: PostHogInboxConnection,
  row: PostHogInboxReport,
  needsReviewers: boolean,
  repositoryIds: Map<string, string>
): Promise<PostHogInboxFacts | null> {
  const report = row.repo_slug === undefined ? await connection.client.getReport(row.id) : row;
  const raw = reportToFacts(report, connection);
  if (!raw) return null;
  return preparePostHogInboxFacts(connection.workspaceId, raw, { needsReviewers, client: connection.client, repositoryIds });
}

interface MatchedReport {
  row: PostHogInboxReport;
  facts: PostHogInboxFacts;
  /** The row's place in the PostHog list, from 0. */
  index: number;
}

/**
 * The rows of one PostHog list read that match the conditions, in list order.
 * A report somebody dismissed is left out: only the safety judge's
 * suppressions are shown, as held back. A report Talyn cannot read is left out.
 */
async function matchRows(
  connection: PostHogInboxConnection,
  listed: PostHogInboxReport[],
  firstIndex: number,
  conditions: WorkflowConditions,
  repositoryIds: Map<string, string>
): Promise<MatchedReport[]> {
  const needsReviewers = (conditions.suggestedReviewers?.length ?? 0) > 0;
  const read = await mapLimited(listed, READ_CONCURRENCY, async (row, i): Promise<MatchedReport | null> => {
    if ((row.status ?? '').toLowerCase() === 'suppressed' && (row.suppression_source ?? '').toLowerCase() !== 'safety_judge') {
      return null;
    }
    try {
      const facts = await factsFor(connection, row, needsReviewers, repositoryIds);
      if (!facts || !posthogInboxContentMatches(conditions, facts)) return null;
      return { row, facts, index: firstIndex + i };
    } catch {
      return null;
    }
  });
  return read.filter((r): r is MatchedReport => r !== null);
}

interface StateContext {
  links: Map<string, LinkSummary[]>;
  runs: Map<string, { id: string; status: string }>;
}

/** The state of one report, and Talyn's work on it. */
function stateOf(report: PostHogInboxReport, facts: PostHogInboxFacts, ctx: StateContext) {
  const links = ctx.links.get(facts.reportId) ?? [];
  const active = links.find((l) => l.status === 'active') ?? null;
  const claimId = report.assignee?.claim_id ?? null;
  const ran = ctx.runs.get(posthogInboxDeliveryId(facts)) ?? null;
  const state = posthogInboxBacklogState({
    suppressionSource: facts.suppressionSource,
    alreadyAddressed: facts.alreadyAddressed,
    workspaceRepositoryId: facts.workspaceRepositoryId,
    claimedInPostHog: claimedInPostHog(report),
    claimIsTalyns: !!active || (!!claimId && links.some((l) => l.claimId === claimId)),
    talynActive: !!active,
    ranThisVersion: !!ran,
  });
  const work = active ?? (ran ? (links.find((l) => l.runId === ran.id) ?? null) : null);
  return {
    state,
    runId: work?.runId ?? ran?.id ?? null,
    workbenchId: work?.workbenchId ?? null,
    pullRequestId: work?.pullRequestId ?? null,
    prUrl: work?.prUrl ?? null,
  };
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Whether a rule may run reports by hand, and why not. */
export function manualRunRefusal(workflow: Pick<WorkflowDefinition, 'enabled'> | null): string | null {
  if (!workflow) return 'Save the automation first. Then you can run reports.';
  if (!workflow.enabled) return 'Turn the automation on first. Then you can run reports.';
  return null;
}

/**
 * One page of a rule's backlog. `workflow` is the saved rule when there is
 * one: it decides the dedupe state, the daily cap and whether rows can be
 * selected. `conditions` are what to match, the editor's unsaved ones or the
 * saved rule's. Reads only; starts nothing.
 *
 * The page reads PostHog {@link BACKLOG_PAGE_SIZE} reports at a time until it
 * has {@link BACKLOG_PAGE_SIZE} matches, PostHog has no more, or it has read
 * {@link BACKLOG_PAGE_SCAN_LIMIT} reports. `nextOffset` is the PostHog offset
 * after the last report the page used.
 */
export async function posthogInboxBacklog(
  connection: PostHogInboxConnection,
  opts: {
    conditions: WorkflowConditions;
    workflow: WorkflowDefinition | null;
    /** The editor's conditions differ from the saved rule's. */
    unsavedChanges?: boolean;
    days: PostHogInboxBacklogDays;
    offset: number;
    now?: Date;
  }
): Promise<PostHogInboxBacklogPage> {
  const start = Math.max(0, Math.floor(opts.offset));
  const repositoryIds = await workspaceRepositoryIds(connection.workspaceId);
  let matched: MatchedReport[] = [];
  let offset = start;
  let more = false;
  let total: number | null = null;
  for (;;) {
    const query = backlogQuery(opts.conditions, opts.days, offset, opts.now);
    const page = await connection.client.listReports(query);
    const listed = (Array.isArray(page.results) ? page.results : []).slice(0, BACKLOG_PAGE_SIZE);
    if (typeof page.count === 'number') total = page.count;
    matched = matched.concat(await matchRows(connection, listed, offset, opts.conditions, repositoryIds));
    offset += listed.length;
    more = listHasMore(page, listed.length, BACKLOG_PAGE_SIZE) && listed.length > 0;
    if (!more || matched.length >= BACKLOG_PAGE_SIZE || offset - start >= BACKLOG_PAGE_SCAN_LIMIT) break;
  }
  // The last read can bring more matches than a page shows. The next page
  // starts after the last match this page shows.
  if (matched.length > BACKLOG_PAGE_SIZE) {
    matched = matched.slice(0, BACKLOG_PAGE_SIZE);
    offset = matched[matched.length - 1].index + 1;
    more = true;
  }

  const ctx: StateContext = {
    links: await linksFor(connection.workspaceId, matched.map((m) => m.facts.reportId)),
    runs: opts.workflow ? await runsFor(opts.workflow.id, matched.map((m) => posthogInboxDeliveryId(m.facts))) : new Map(),
  };
  let notRunnableReason = manualRunRefusal(opts.workflow);
  if (!notRunnableReason && opts.unsavedChanges) notRunnableReason = 'Save your changes first. Then you can run reports.';
  const runnable = notRunnableReason === null;

  const rows: PostHogInboxBacklogRow[] = matched.map(({ row, facts }) => {
    const s = stateOf(row, facts, ctx);
    return {
      id: facts.reportId,
      title: facts.title,
      url: facts.url,
      priority: facts.priority,
      actionability: facts.actionability,
      repository: facts.repository,
      sourceProducts: facts.sourceProducts,
      signalCount: facts.signalCount,
      createdAt: typeof row.created_at === 'string' ? row.created_at : null,
      updatedAt: facts.updatedAt,
      state: s.state,
      selectable: runnable && s.state === 'not_run',
      runId: s.runId,
      workbenchId: s.workbenchId,
      pullRequestId: s.pullRequestId,
      prUrl: s.prUrl,
    };
  });

  return {
    rows,
    scanned: offset - start,
    nextOffset: more ? offset : null,
    total,
    days: opts.days,
    workflowId: opts.workflow?.id ?? null,
    runnable,
    notRunnableReason,
    dailyCap: opts.workflow?.maxRunsPerDay ?? null,
    runsToday: opts.workflow ? await runsInLastDay(opts.workflow.id, opts.now) : 0,
  };
}

/** PURE: a count with every state at zero. */
export function emptyBacklogStateCounts(): Record<PostHogInboxBacklogState, number> {
  const out = {} as Record<PostHogInboxBacklogState, number>;
  for (const state of Object.keys(POSTHOG_INBOX_BACKLOG_STATE_LABELS) as PostHogInboxBacklogState[]) out[state] = 0;
  return out;
}

/**
 * How many reports in the range match a rule, by state. Reads PostHog
 * {@link BACKLOG_COUNT_READ_SIZE} reports at a time, newest first, up to
 * {@link MAX_POSTHOG_INBOX_BACKLOG_COUNT_SCAN}. Reads only; starts nothing.
 */
export async function posthogInboxBacklogCount(
  connection: PostHogInboxConnection,
  opts: {
    conditions: WorkflowConditions;
    workflow: WorkflowDefinition | null;
    days: PostHogInboxBacklogDays;
    now?: Date;
  }
): Promise<PostHogInboxBacklogCount> {
  const repositoryIds = await workspaceRepositoryIds(connection.workspaceId);
  const byState = emptyBacklogStateCounts();
  let matched = 0;
  let offset = 0;
  let more = true;
  let total: number | null = null;
  while (more && offset < MAX_POSTHOG_INBOX_BACKLOG_COUNT_SCAN) {
    const limit = Math.min(BACKLOG_COUNT_READ_SIZE, MAX_POSTHOG_INBOX_BACKLOG_COUNT_SCAN - offset);
    const page = await connection.client.listReports(backlogQuery(opts.conditions, opts.days, offset, opts.now, limit));
    const listed = (Array.isArray(page.results) ? page.results : []).slice(0, limit);
    if (typeof page.count === 'number') total = page.count;
    const found = await matchRows(connection, listed, offset, opts.conditions, repositoryIds);
    // The states of one read at a time: two queries per read, never one per report.
    const ctx: StateContext = {
      links: await linksFor(connection.workspaceId, found.map((m) => m.facts.reportId)),
      runs: opts.workflow ? await runsFor(opts.workflow.id, found.map((m) => posthogInboxDeliveryId(m.facts))) : new Map(),
    };
    for (const { row, facts } of found) byState[stateOf(row, facts, ctx).state] += 1;
    matched += found.length;
    offset += listed.length;
    more = listHasMore(page, listed.length, limit) && listed.length > 0;
  }
  return { days: opts.days, matched, byState, scanned: offset, total, complete: !more };
}

// ---- Run selected ------------------------------------------------------------

/** PURE: the report ids of a run request, trimmed and without repeats. Null when the shape is wrong. */
export function parseRunReportIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (!raw.every((id) => typeof id === 'string')) return null;
  return [...new Set((raw as string[]).map((id) => id.trim()).filter(Boolean))];
}

function result(reportId: string, outcome: PostHogInboxRunResult['outcome'], message: string, extra: Partial<PostHogInboxRunResult> = {}): PostHogInboxRunResult {
  return { reportId, outcome, message, runId: null, workbenchId: null, ...extra };
}

const STATE_MESSAGES: Partial<Record<PostHogInboxBacklogState, string>> = {
  running: 'Talyn already works on this report.',
  already_run: 'This automation already ran on this version of the report.',
  claimed_elsewhere: 'Another person or agent holds this report in PostHog.',
  already_addressed: 'PostHog says somebody already handles this report.',
  repository_not_connected: "The report's repository is not connected to this workspace.",
  held_back: "PostHog's safety judge held this report back. Talyn never acts on it.",
};

/** PURE: a manual run's engine outcome, as the answer for one report. */
export function manualOutcomeResult(reportId: string, outcome: ManualRunOutcome, dailyCap: number | null): PostHogInboxRunResult {
  switch (outcome.kind) {
    case 'unavailable':
      return result(reportId, 'failed', 'PostHog Inbox automations are not available for this workspace now.');
    case 'no_target':
      return result(reportId, 'failed', 'The report does not belong to this workspace.');
    case 'not_matching':
      return result(reportId, 'not_eligible', 'The report no longer matches this automation.');
    case 'daily_capped':
      return result(reportId, 'daily_cap', `The daily cap of ${dailyCap ?? 'this automation'} is reached.`);
    case 'rate_capped':
      return result(reportId, 'failed', 'This automation already ran on this report too often in the last hour.');
    case 'duplicate':
      return result(reportId, 'already_run', STATE_MESSAGES.already_run!);
    case 'acted': {
      const ids = { runId: outcome.run?.id ?? null, workbenchId: outcome.workbenchId };
      if (outcome.status === 'succeeded' && outcome.workbenchId) return result(reportId, 'started', 'Talyn started a session.', ids);
      if (outcome.status === 'pending_retry') {
        const failed = outcome.outcomes.find((o) => !o.ok);
        return result(reportId, 'parked', failed?.error ?? 'Talyn tries again later.', ids);
      }
      if (outcome.outcomes.some((o) => o.code === 'report_claimed_elsewhere')) {
        return result(reportId, 'claimed_elsewhere', 'Another person or agent claimed this report in PostHog first.', ids);
      }
      if (outcome.status === 'succeeded') return result(reportId, 'started', 'Talyn started the run.', ids);
      const failed = outcome.outcomes.find((o) => !o.ok);
      return result(reportId, 'failed', failed?.error ?? 'The run failed.', ids);
    }
  }
}

/**
 * "Run selected": start the rule on these reports, one at a time, in order.
 *
 * Each report is read again from PostHog and checked again: its state (the
 * same as the backlog's) and the rule's conditions. Then the engine runs it,
 * which claims the report in Talyn and in PostHog before the session starts.
 * Manual runs count toward the daily cap. When the cap is reached, the rest
 * are refused without a read.
 */
export async function runPostHogInboxReports(
  connection: PostHogInboxConnection,
  workflow: WorkflowDefinition,
  reportIds: string[],
  manual: { userId: string; label: string | null }
): Promise<PostHogInboxRunResponse> {
  const ids = reportIds.slice(0, MAX_POSTHOG_INBOX_RUN_REPORTS);
  const cap = workflow.maxRunsPerDay ?? null;
  const results: PostHogInboxRunResult[] = [];
  let capReached = false;
  for (const reportId of ids) {
    // The cap first: a report the cap refuses is not read from PostHog.
    if (!capReached && cap !== null && !(await checkDailyCap({ workflowId: workflow.id, cap })).allowed) capReached = true;
    if (capReached) {
      results.push(result(reportId, 'daily_cap', `The daily cap of ${cap} is reached.`));
      continue;
    }
    let report: PostHogInboxReport;
    try {
      report = await connection.client.getReport(reportId);
    } catch (err) {
      const status = err instanceof PostHogCodeApiError ? err.status : null;
      results.push(
        status === 404 || status === 400
          ? result(reportId, 'not_found', 'PostHog does not have this report.')
          : result(reportId, 'unreadable', `Talyn could not read the report from PostHog${status ? ` (${status})` : ''}.`)
      );
      continue;
    }
    const raw = reportToFacts(report, connection);
    if (!raw) {
      results.push(result(reportId, 'unreadable', 'PostHog answered without a report.'));
      continue;
    }
    const facts = await preparePostHogInboxFacts(connection.workspaceId, raw, {
      needsReviewers: (workflow.conditions.suggestedReviewers?.length ?? 0) > 0,
      client: connection.client,
    });
    const s = stateOf(report, facts, {
      links: await linksFor(connection.workspaceId, [facts.reportId]),
      runs: await runsFor(workflow.id, [posthogInboxDeliveryId(facts)]),
    });
    if (s.state !== 'not_run') {
      const outcome = s.state === 'claimed_elsewhere' ? 'claimed_elsewhere' : s.state === 'running' || s.state === 'already_run' ? 'already_run' : 'not_eligible';
      results.push(result(reportId, outcome, STATE_MESSAGES[s.state] ?? POSTHOG_INBOX_BACKLOG_STATE_LABELS[s.state], { runId: s.runId, workbenchId: s.workbenchId }));
      continue;
    }
    const mismatch = posthogInboxMismatchReason(workflow.conditions, facts);
    if (mismatch) {
      results.push(result(reportId, 'not_eligible', `The report no longer matches: ${mismatch}.`));
      continue;
    }
    const outcome = await runWorkflowManually(posthogInboxWorkflowSource, { connection, facts: raw }, workflow, manual);
    const one = manualOutcomeResult(reportId, outcome, cap);
    if (one.outcome === 'daily_cap') capReached = true;
    results.push(one);
  }
  return {
    results,
    requested: ids.length,
    started: results.filter((r) => r.outcome === 'started').length,
    dailyCap: cap,
    summary: posthogInboxRunSummary(results, cap),
  };
}
