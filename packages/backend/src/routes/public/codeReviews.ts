import { CODE_REVIEW_PHASE_AT_REST, type CodeReviewDismissReason, type CodeReviewPhase } from '@talyn/shared';
import { dismissFinding, postReviewFindings, undismissFinding } from '../../services/codeReview/actions.js';
import { cancelReviewCycle, startReviewCycle } from '../../services/codeReview/cycle.js';
import { getFinding, listFindings, type FindingDetailRow } from '../../services/codeReview/findings.js';
import { toPublicReview } from '../../services/codeReview/public.js';
import { getReview, getReviewForPr, listReviewEvents, type ReviewRow } from '../../services/codeReview/store.js';
import {
  authorizedReview,
  isVisibleFinding,
  lensNamesOf,
  toPublicCodeReview,
  toPublicCodeReviewEvent,
  toPublicFinding,
} from '../../services/public/codeReviews.js';
import { PublicApiError, notFound } from '../../services/public/errors.js';
import { authorizedPullRequest } from '../../services/public/pullRequests.js';
import { IdParams } from '../../schemas/public/resources.js';
import {
  CodeReview,
  CodeReviewEventList,
  CodeReviewList,
  CodeReviewPost,
  DismissFindingBody,
  Finding,
  FindingParams,
  PostCodeReviewBody,
  StartCodeReviewBody,
} from '../../schemas/public/codeReviews.js';
import { definePublicRoute, type PublicRoute } from './define.js';

/** The review as stored now, with or without its findings. */
async function reviewBody(reviewId: string, withFindings: boolean) {
  const review = await getReview(reviewId);
  if (!review) throw notFound('code_review');
  const [payload, findings] = await Promise.all([
    toPublicReview(review),
    withFindings ? listFindings(review.id, { includeInactive: true }) : Promise.resolve(undefined),
  ]);
  return toPublicCodeReview(review, payload, findings);
}

/** A finding of this review. A finding id from another review is 404, whoever holds it. */
async function findingOf(review: ReviewRow, findingId: string): Promise<FindingDetailRow> {
  const finding = await getFinding(findingId);
  if (!finding || finding.reviewId !== review.id || !isVisibleFinding(finding)) throw notFound('finding');
  return finding;
}

async function findingBody(review: ReviewRow, findingId: string) {
  const finding = await findingOf(review, findingId);
  return toPublicFinding(finding, lensNamesOf(review), true);
}

const START_REFUSAL_STATUS: Record<string, number> = { pr_missing: 404, pr_closed: 409, busy: 409, no_reviewers: 409 };

/**
 * Code reviews: AI review of a pull request, with the findings shown in Talyn.
 * Nothing reaches GitHub until a person posts it (`POST /code-reviews/{id}/post`).
 * Fix runs are tasks underneath and are not part of the API.
 */
export const codeReviewRoutes: PublicRoute[] = [
  definePublicRoute({
    method: 'get',
    path: '/pull-requests/{id}/code-reviews',
    operationId: 'listPullRequestCodeReviews',
    summary: 'List the code reviews of a pull request',
    description: 'A pull request has at most one review. Each new review is a new `cycle` of it, and findings carry over between cycles.',
    tag: 'Code reviews',
    scope: 'code_reviews:read',
    params: IdParams,
    responses: { 200: { description: 'The review, if there is one. Without findings.', schema: CodeReviewList } },
    async handler({ params, token }) {
      const pr = await authorizedPullRequest(token, params.id);
      const review = await getReviewForPr(pr.id);
      const data = review ? [toPublicCodeReview(review, await toPublicReview(review))] : [];
      return { status: 200, body: { object: 'list', data, has_more: false, next_cursor: null } };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/pull-requests/{id}/code-reviews',
    operationId: 'startCodeReview',
    summary: 'Start a code review',
    description:
      'Starts a new review cycle on the pull request. If a cycle is already running, the answer is that cycle with status 200. ' +
      'The free plan allows 1 cycle at a time: over that, 402 `code_review_limit_reached`. ' +
      "409 `no_reviewers` when the workspace turned Talyn's reviewers off and has none of its own for this repository; " +
      '409 `pr_closed` for a pull request that is not open.',
    tag: 'Code reviews',
    scope: 'code_reviews:write',
    creates: true,
    params: IdParams,
    body: StartCodeReviewBody,
    responses: {
      200: { description: 'A cycle was already running. This is it.', schema: CodeReview },
      201: { description: 'The new cycle.', schema: CodeReview },
    },
    async handler({ params, body, token }) {
      const pr = await authorizedPullRequest(token, params.id);
      const outcome = await startReviewCycle({
        pullRequestId: pr.id,
        ...(body.preset ? { preset: body.preset as 'quick' | 'standard' | 'deep' } : {}),
        ...(body.reset ? { reset: true } : {}),
        userId: token.ownerId,
      });
      if (!outcome.ok) throw new PublicApiError(START_REFUSAL_STATUS[outcome.code] ?? 409, outcome.code, outcome.message);
      return { status: outcome.started ? 201 : 200, body: await reviewBody(outcome.review.id, false) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/code-reviews/{id}',
    operationId: 'getCodeReview',
    summary: 'Get a code review with its findings',
    tag: 'Code reviews',
    scope: 'code_reviews:read',
    params: IdParams,
    responses: { 200: { description: 'The review and its findings.', schema: CodeReview } },
    async handler({ params, token }) {
      const review = await authorizedReview(token, params.id);
      return { status: 200, body: await reviewBody(review.id, true) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/code-reviews/{id}/cancel',
    operationId: 'cancelCodeReview',
    summary: 'Stop a running code review',
    description: 'Stops the reviewers of the running cycle. A review at rest answers as it is.',
    tag: 'Code reviews',
    scope: 'code_reviews:write',
    params: IdParams,
    responses: { 200: { description: 'The review.', schema: CodeReview } },
    async handler({ params, token }) {
      const review = await authorizedReview(token, params.id);
      if (!CODE_REVIEW_PHASE_AT_REST[review.phase as CodeReviewPhase]) await cancelReviewCycle(review);
      return { status: 200, body: await reviewBody(review.id, false) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/code-reviews/{id}/events',
    operationId: 'listCodeReviewEvents',
    summary: 'List the history of a code review',
    description: 'Each phase change and action, with the reason.',
    tag: 'Code reviews',
    scope: 'code_reviews:read',
    params: IdParams,
    responses: { 200: { description: 'The events, newest first.', schema: CodeReviewEventList } },
    async handler({ params, token }) {
      const review = await authorizedReview(token, params.id);
      const events = await listReviewEvents(review.id);
      return { status: 200, body: { object: 'list', data: events.map(toPublicCodeReviewEvent) } };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/code-reviews/{id}/findings/{finding_id}',
    operationId: 'getCodeReviewFinding',
    summary: 'Get a finding',
    description: 'With its full `body`, the `suggestion` and the quoted `anchor`.',
    tag: 'Code reviews',
    scope: 'code_reviews:read',
    params: FindingParams,
    responses: { 200: { description: 'The finding.', schema: Finding } },
    async handler({ params, token }) {
      const review = await authorizedReview(token, params.id);
      return { status: 200, body: await findingBody(review, params.finding_id) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/code-reviews/{id}/findings/{finding_id}/dismiss',
    operationId: 'dismissCodeReviewFinding',
    summary: 'Dismiss a finding',
    description:
      'A dismissal stays across cycles: a later review that finds the same thing does not ask again. ' +
      'Dismissing a blocker can let a parked merge-queue entry go on.',
    tag: 'Code reviews',
    scope: 'code_reviews:write',
    idempotent: true,
    params: FindingParams,
    body: DismissFindingBody,
    responses: { 200: { description: 'The finding.', schema: Finding } },
    async handler({ params, body, token }) {
      const review = await authorizedReview(token, params.id);
      const finding = await findingOf(review, params.finding_id);
      await dismissFinding({
        review,
        finding,
        reason: (body.reason as CodeReviewDismissReason | undefined) ?? null,
        userId: token.ownerId,
      });
      return { status: 200, body: await findingBody(review, finding.id) };
    },
  }),

  definePublicRoute({
    method: 'delete',
    path: '/code-reviews/{id}/findings/{finding_id}/dismiss',
    operationId: 'undismissCodeReviewFinding',
    summary: 'Undo a dismissal',
    tag: 'Code reviews',
    scope: 'code_reviews:write',
    params: FindingParams,
    responses: { 200: { description: 'The finding, open again.', schema: Finding } },
    async handler({ params, token }) {
      const review = await authorizedReview(token, params.id);
      const finding = await findingOf(review, params.finding_id);
      if (finding.disposition === 'dismissed') await undismissFinding({ review, findingId: finding.id });
      return { status: 200, body: await findingBody(review, finding.id) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/code-reviews/{id}/post',
    operationId: 'postCodeReview',
    summary: 'Post findings to the pull request',
    description:
      'Writes the findings to the pull request as one GitHub review from your account, always as a comment (never approve or request changes). ' +
      'A finding goes on a line of the diff only when its quoted code was found there; the others go in the review body. ' +
      'A finding is never posted twice. 409 `code_review_post_not_ready` or `code_review_post_nothing_to_post`; ' +
      '502 `code_review_post_github_failed` when GitHub refuses.',
    tag: 'Code reviews',
    scope: 'code_reviews:write',
    idempotent: true,
    github: true,
    params: IdParams,
    body: PostCodeReviewBody,
    responses: { 200: { description: 'What was posted.', schema: CodeReviewPost } },
    async handler({ params, body, token }) {
      const review = await authorizedReview(token, params.id);
      const outcome = await postReviewFindings({ review, findingIds: body.finding_ids ?? [], userId: token.ownerId });
      if (!outcome.ok) {
        throw new PublicApiError(outcome.code === 'github_failed' ? 502 : 409, `code_review_post_${outcome.code}`, outcome.message);
      }
      return {
        status: 200,
        body: {
          object: 'code_review_post',
          review_id: review.id,
          posted: outcome.posted,
          inline: outcome.inline,
          in_summary: outcome.inSummary,
          review_url: outcome.reviewUrl,
        },
      };
    },
  }),
];
