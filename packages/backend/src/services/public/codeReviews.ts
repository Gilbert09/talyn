import { codeReviewLensLabel, type CodeReviewPublic } from '@talyn/shared';
import type { ApiTokenPrincipal } from '../apiTokens.js';
import type { FindingDetailRow, FindingListRow } from '../codeReview/findings.js';
import { getReview, type ReviewRow } from '../codeReview/store.js';
import { authorizeWorkspace } from './authorize.js';
import { notFound } from './errors.js';

/**
 * Code reviews as `/v1` sends them. Built from the app's own payload
 * (`toPublicReview` in `codeReview/public.ts`), so counts, `open_count` and
 * `stale_for_head` are the numbers the app shows. Fix runs are tasks
 * underneath, so `fixTaskId` and every other task id stay out.
 */

/** The review row, checked against the token. 404 when out of reach. */
export async function authorizedReview(token: ApiTokenPrincipal, id: string): Promise<ReviewRow> {
  const review = await getReview(id);
  if (!review) throw notFound('code_review');
  try {
    await authorizeWorkspace(token, review.workspaceId);
  } catch {
    throw notFound('code_review');
  }
  return review;
}

type LensNames = Record<string, string>;

/** The names a review's own reviewers ran under, for labelling lens keys. */
export function lensNamesOf(review: Pick<ReviewRow, 'customReviewers'>): LensNames {
  const names: LensNames = {};
  for (const r of review.customReviewers ?? []) names[r.lensKey] = r.name;
  return names;
}

const lens = (key: string, names: LensNames) => ({ key, name: codeReviewLensLabel(key, names) });

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const STATUSES = new Set(['open', 'selected', 'dismissed', 'fixed', 'stale']);
const VERDICTS = new Set(['unvalidated', 'confirmed', 'rejected', 'uncertain']);

export function toPublicFinding(f: FindingListRow | FindingDetailRow, names: LensNames, detail = false) {
  return {
    object: 'code_review_finding' as const,
    id: f.id,
    review_id: f.reviewId,
    severity: f.severity as 'blocker' | 'major' | 'minor' | 'nit',
    category: f.category,
    title: f.title,
    file_path: f.filePath,
    line_start: f.lineStart ?? null,
    line_end: f.lineEnd ?? null,
    anchor_verified: f.anchorVerified,
    lenses: ((f.lenses as string[] | null) ?? []).map((k) => lens(k, names)),
    confidence: f.confidence ?? null,
    verdict: (VERDICTS.has(f.verdict) ? f.verdict : 'unvalidated') as 'unvalidated' | 'confirmed' | 'rejected' | 'uncertain',
    verdict_reason: f.verdictReason ?? null,
    status: (STATUSES.has(f.disposition) ? f.disposition : 'stale') as 'open' | 'selected' | 'dismissed' | 'fixed' | 'stale',
    dismissed_reason: f.dismissedReason ?? null,
    seen_count: f.seenCount,
    carried_over: f.firstSeenCycle < f.lastSeenCycle,
    posted_at: iso(f.postedAt),
    fixed_at: iso(f.fixedAt),
    fixed_head_sha: f.fixedHeadSha ?? null,
    created_at: f.createdAt.toISOString(),
    ...(detail && 'body' in f ? { body: f.body, suggestion: f.suggestion ?? null, anchor: f.anchor ?? null } : {}),
  };
}

/** A finding a reset threw away is gone for the person, so it is gone for the API too. */
export function isVisibleFinding(f: Pick<FindingListRow, 'disposition'>): boolean {
  return f.disposition !== 'discarded';
}

export function toPublicCodeReview(
  review: ReviewRow,
  payload: CodeReviewPublic,
  findings?: FindingListRow[],
) {
  const names = lensNamesOf(review);
  return {
    object: 'code_review' as const,
    id: review.id,
    workspace_id: review.workspaceId,
    pull_request_id: review.pullRequestId,
    cycle: review.cycle,
    preset: payload.preset,
    phase: payload.phase,
    phase_plan: payload.phasePlan,
    runs_done: payload.runsDone,
    runs_total: payload.runsTotal,
    lenses_run: payload.lensesRun.map((k) => lens(k, names)),
    head_sha: payload.headSha,
    reviewed_head_sha: payload.reviewedHeadSha || null,
    stale_for_head: payload.staleForHead,
    counts: {
      blocker: payload.counts.blocker,
      major: payload.counts.major,
      minor: payload.counts.minor,
      nit: payload.counts.nit,
    },
    open_count: payload.openCount,
    dismissed_count: payload.dismissedCount,
    funnel: { raised: payload.funnel.raised, kept: payload.funnel.kept, rejected: payload.funnel.rejected },
    failure_reason: payload.failureReason,
    deferred_since: payload.deferredSince,
    started_at: payload.startedAt,
    finished_at: payload.finishedAt,
    created_at: review.createdAt.toISOString(),
    ...(findings ? { findings: findings.filter(isVisibleFinding).map((f) => toPublicFinding(f, names)) } : {}),
  };
}

export function toPublicCodeReviewEvent(e: {
  at: Date;
  fromPhase: string | null;
  toPhase: string;
  trigger: string;
  code: string | null;
  message: string;
}) {
  return {
    object: 'code_review_event' as const,
    at: e.at.toISOString(),
    from_phase: e.fromPhase ?? null,
    to_phase: e.toPhase,
    trigger: e.trigger,
    code: e.code ?? null,
    message: e.message,
  };
}

export type PublicCodeReview = ReturnType<typeof toPublicCodeReview>;
export type PublicFinding = ReturnType<typeof toPublicFinding>;
