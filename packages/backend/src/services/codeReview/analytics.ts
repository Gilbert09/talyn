import { and, eq, sql } from 'drizzle-orm';
import {
  CODE_REVIEW_REPORTING_BAR,
  isCodeReviewPreset,
  type CodeReviewPhase,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { prCodeReviewEvents, prCodeReviewRuns } from '../../db/schema.js';
import { captureWorkspaceEvent } from '../analytics.js';
import { funnelCounts, openCountOf, severityCounts } from './findings.js';
import { reportingBarsFor } from './workspaceSettings.js';
import type { ReviewRow } from './store.js';

/**
 * What a review is worth knowing about, once it is over.
 *
 * # Why this exists at all
 *
 * Everything this feature captured for its first weeks was a user ACTION —
 * started, viewed, expanded, dismissed, fix requested. So the dashboard could say
 * that people press the button and nothing whatever about whether the product
 * works: not how long a review takes, not what it costs, not how many of its
 * findings survive judging, not how often it fails. The two questions Tom has
 * actually asked of this feature — "how long did this review take?" and "is this
 * finding wrong?" — were both unanswerable from analytics.
 *
 * # Shape only
 *
 * `loopShape`'s rule, which matters more here: this pipeline reads private source
 * code and its findings quote it. Counts, durations, booleans, severities,
 * model and provider ids. Never a file path, a finding title or body, a repo name,
 * a branch or a prompt. The `workspace_id` that `captureWorkspaceEvent` adds is
 * the only identity, and it is the same one every other server event carries.
 *
 * # Never a reason a review fails
 *
 * Every function here swallows its own errors. A cycle that finished must not be
 * reported as failed because PostHog would not answer, and the gathering queries
 * are several reads that each have their own ways to go wrong.
 */

/** The run facts, aggregated in SQL so no per-unit row ships for a count. */
interface UnitFacts {
  total: number;
  settled: number;
  failed: number;
  skipped: number;
  parseRetries: number;
  costUsd: number;
  firstDispatchedAt: Date | null;
  providers: string[];
  models: string[];
}

async function unitFacts(reviewId: string, cycle: number): Promise<UnitFacts> {
  const rows = await getDbClient()
    .select({
      total: sql<number>`count(*)::int`,
      settled: sql<number>`count(*) filter (where ${prCodeReviewRuns.status} = 'settled')::int`,
      failed: sql<number>`count(*) filter (where ${prCodeReviewRuns.status} = 'failed')::int`,
      skipped: sql<number>`count(*) filter (where ${prCodeReviewRuns.status} = 'skipped')::int`,
      // Above one means the unit's first output would not parse. The plan's own
      // open question — "does the JSON contract actually hold?" — is this number.
      parseRetries: sql<number>`coalesce(sum(greatest(${prCodeReviewRuns.parseAttempts} - 1, 0)), 0)::int`,
      // `cost_usd` is numeric, so postgres-js hands it back as a string.
      costUsd: sql<string | null>`sum(${prCodeReviewRuns.costUsd})`,
      firstDispatchedAt: sql<Date | null>`min(${prCodeReviewRuns.dispatchedAt})`,
      providers: sql<string[]>`coalesce(array_agg(distinct ${prCodeReviewRuns.provider}) filter (where ${prCodeReviewRuns.provider} is not null), '{}')`,
      models: sql<string[]>`coalesce(array_agg(distinct ${prCodeReviewRuns.model}) filter (where ${prCodeReviewRuns.model} is not null), '{}')`,
    })
    .from(prCodeReviewRuns)
    .where(and(eq(prCodeReviewRuns.reviewId, reviewId), eq(prCodeReviewRuns.cycle, cycle)));

  const row = rows[0];
  return {
    total: row?.total ?? 0,
    settled: row?.settled ?? 0,
    failed: row?.failed ?? 0,
    skipped: row?.skipped ?? 0,
    parseRetries: row?.parseRetries ?? 0,
    costUsd: row?.costUsd ? Number(row.costUsd) : 0,
    firstDispatchedAt: row?.firstDispatchedAt ? new Date(row.firstDispatchedAt) : null,
    providers: (row?.providers ?? []).slice().sort(),
    models: (row?.models ?? []).slice().sort(),
  };
}

/**
 * When this cycle was asked for.
 *
 * Read from the audit log rather than from `phase_started_at`, which holds the
 * CURRENT phase's start and would report the last step's duration as the whole
 * review's. `max(at)` is safe because a second cycle cannot start while this one
 * is running — the start path hands back the review in flight instead.
 */
async function cycleStartedAt(reviewId: string): Promise<Date | null> {
  const rows = await getDbClient()
    .select({ at: sql<Date | null>`max(${prCodeReviewEvents.at})` })
    .from(prCodeReviewEvents)
    .where(
      and(eq(prCodeReviewEvents.reviewId, reviewId), eq(prCodeReviewEvents.code, 'cycle_started'))
    );
  const at = rows[0]?.at;
  return at ? new Date(at) : null;
}

function secondsBetween(from: Date | null, to: Date): number | null {
  if (!from) return null;
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
}

/**
 * The facts both outcomes share, so a completed and a failed review compare.
 *
 * Exported for its test. Every capture here swallows its own errors, which is
 * right for a dashboard and wrong for a suite — a broken aggregate would pass
 * silently — so the test calls this and reads the numbers.
 */
export async function codeReviewCycleShape(review: ReviewRow): Promise<Record<string, unknown>> {
  const now = new Date();
  const [units, startedAt] = await Promise.all([
    unitFacts(review.id, review.cycle),
    cycleStartedAt(review.id),
  ]);
  return {
    preset: isCodeReviewPreset(review.preset) ? review.preset : 'unknown',
    cycle: review.cycle,
    // Whether this is the first look at the pull request or a re-review, which is
    // the difference between "does it find things" and "does a fix hold".
    is_rereview: review.cycle > 1,
    auto: review.auto === true,
    lenses: ((review.lensKeys as string[]) ?? []).length,
    chunks: review.chunkTotal,
    units_planned: review.runsTotal,
    units_total: units.total,
    units_settled: units.settled,
    units_failed: units.failed,
    units_skipped: units.skipped,
    parse_retries: units.parseRetries,
    cost_usd: units.costUsd,
    providers: units.providers,
    models: units.models,
    // Split deliberately. `queue_seconds` is ours to fix — it is scheduler latency,
    // and a start race once put two minutes in it. `agent_seconds` is the
    // vendors', and no amount of our own work shortens it.
    queue_seconds: secondsBetween(startedAt, units.firstDispatchedAt ?? now),
    agent_seconds: secondsBetween(units.firstDispatchedAt, now),
    total_seconds: secondsBetween(startedAt, now),
  };
}

/** A cycle reached `ready`. The one event that says whether the feature works. */
export async function captureCycleFinished(review: ReviewRow): Promise<void> {
  try {
    const [shape, counts, funnel, bars] = await Promise.all([
      codeReviewCycleShape(review),
      severityCounts(review.id),
      funnelCounts(review.id),
      reportingBarsFor([review.workspaceId]),
    ]);
    const bar = bars.get(review.workspaceId) ?? CODE_REVIEW_REPORTING_BAR;
    captureWorkspaceEvent(review.workspaceId, 'code_review_completed', {
      ...shape,
      // The judging funnel. `kept / raised` is the number that says whether the
      // reviewers or the judge is the part that needs work — on the first real
      // review it was one in six, and nothing recorded it.
      findings_raised: funnel.raised,
      findings_kept: funnel.kept,
      findings_rejected: funnel.rejected,
      blockers: counts.blocker,
      majors: counts.major,
      minors: counts.minor,
      nits: counts.nit,
      // What the user is actually shown, which is the bar their workspace chose.
      open_count: openCountOf(counts, bar),
      reporting_bar: bar,
      // A cycle where some lenses died still reaches `ready`, by design. This is
      // how often that happens, which is otherwise invisible.
      partial: (shape.units_failed as number) > 0 || (shape.units_skipped as number) > 0,
    });
  } catch (err) {
    console.warn(`[code-review] analytics for finished ${review.id} failed:`, err);
  }
}

/** A cycle gave up. The failure code is the whole point of the event. */
export async function captureCycleFailed(
  review: ReviewRow,
  code: string
): Promise<void> {
  try {
    captureWorkspaceEvent(review.workspaceId, 'code_review_failed', {
      ...(await codeReviewCycleShape(review)),
      failure_code: code,
      // Which phase it died in. A review that fails while preparing is our bug;
      // one that fails while reviewing is usually a runner or a vendor.
      phase: review.phase as CodeReviewPhase,
    });
  } catch (err) {
    console.warn(`[code-review] analytics for failed ${review.id} failed:`, err);
  }
}

/**
 * A fix run reached a terminal status.
 *
 * The other half of `code_review_fix_requested`, which had no counterpart — so
 * the funnel could show fixes being asked for and nothing about whether any of
 * them landed, which is the one thing that decides whether the findings are worth
 * reading.
 */
export async function captureFixSettled(
  review: ReviewRow,
  status: string,
  findingCount: number
): Promise<void> {
  try {
    captureWorkspaceEvent(review.workspaceId, 'code_review_fix_settled', {
      cycle: review.cycle,
      preset: isCodeReviewPreset(review.preset) ? review.preset : 'unknown',
      status,
      findings: findingCount,
      // An unattended push, which is the one path here with no human in the loop
      // and therefore the one whose outcome matters most.
      auto_fix: review.startedBy === null && review.auto === true,
      fix_seconds: secondsBetween(review.fixStartedAt ?? null, new Date()),
    });
  } catch (err) {
    console.warn(`[code-review] analytics for fix on ${review.id} failed:`, err);
  }
}

/**
 * A unit ran on the workspace's other fleet agent, because the first one was
 * limited.
 *
 * `at` separates the two ways it happens. 'failure' is a unit that ran, was
 * refused and moved. 'dispatch' is a unit that never tried the limited agent,
 * because a hold or an earlier unit of the same cycle had already said so.
 * Shape only, as everywhere in this module.
 */
export function captureUnitFailedOver(
  workspaceId: string,
  properties: {
    from_agent: string;
    to_agent: string;
    reason: 'usage_limit' | 'quota_exhausted';
    kind: string;
    lens: string;
    cycle: number;
    at: 'dispatch' | 'failure';
  }
): void {
  try {
    captureWorkspaceEvent(workspaceId, 'code_review_unit_failed_over', properties);
  } catch (err) {
    console.warn('[code-review] analytics for a unit failover failed:', err);
  }
}
