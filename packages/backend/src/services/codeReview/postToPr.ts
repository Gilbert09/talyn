import { CODE_REVIEW_PHASE_AT_REST, type CodeReviewPhase } from '@talyn/shared';
import { runWithoutScope } from '../../db/client.js';
import { GitHubApiError, githubService } from '../github.js';
import { findingsForPost, markPosted, type FindingDetailRow } from './findings.js';
import {
  buildReviewBody,
  commentableRightLines,
  GITHUB_BODY_LIMIT,
  inlineCommentBody,
  placeFinding,
  sortFindingsForPost,
  type LineRange,
} from './postFormat.js';
import { appendReviewEvent, getPrForReview, getReview, type ReviewRow } from './store.js';

/**
 * "Post to PR": write a review's findings onto the pull request.
 *
 * One GitHub review, event COMMENT, from the workspace user's account. A
 * finding whose lines are in the diff becomes an inline comment. Every other
 * finding goes in the review body.
 *
 * # Posting once
 *
 * A finding with `posted_at` set is never posted again. Two presses at the same
 * time are made safe by running the whole "select, post, mark" sequence one at
 * a time per review, and by reading what is eligible INSIDE that sequence. The
 * second press then finds nothing left and is refused.
 *
 * The sequence runs on the pool, not on the request's transaction. A request
 * commits when its response ends, so a mark written on it would be invisible to
 * the press waiting behind it.
 *
 * There is no advisory lock. The queue is per process, so two replicas could
 * still both post during a deploy overlap. That costs one duplicate comment.
 */

export type PostOutcome =
  | {
      ok: true;
      posted: number;
      inline: number;
      inSummary: number;
      reviewUrl: string | null;
    }
  | { ok: false; code: 'not_ready' | 'nothing_to_post' | 'github_failed'; message: string };

const tails = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier call for the same key has ended. */
function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

export function postFindingsToPr(
  reviewId: string,
  findingIds: string[],
  userId: string | null
): Promise<PostOutcome> {
  return oneAtATime(reviewId, () => runWithoutScope(() => postOnce(reviewId, findingIds, userId)));
}

/** Every eligible finding is longer than GitHub accepts, so none can be posted whole. */
const TOO_LARGE: PostOutcome = {
  ok: false,
  code: 'nothing_to_post',
  message: 'These findings are too long for a GitHub comment. You can read them in Talyn.',
};

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function postOnce(
  reviewId: string,
  findingIds: string[],
  userId: string | null
): Promise<PostOutcome> {
  // Read again here: the press ahead of this one may have changed the review.
  const review = await getReview(reviewId);
  if (!review) {
    return { ok: false, code: 'not_ready', message: 'That pull request has no review.' };
  }
  if (!CODE_REVIEW_PHASE_AT_REST[review.phase as CodeReviewPhase]) {
    return {
      ok: false,
      code: 'not_ready',
      message: 'The review is still running. Post the findings when it has finished.',
    };
  }
  if (!review.reviewedHeadSha) {
    return {
      ok: false,
      code: 'not_ready',
      message: 'This review has not finished on a commit, so there is nothing to post.',
    };
  }
  const pr = await getPrForReview(review.pullRequestId);
  if (!pr) {
    return { ok: false, code: 'not_ready', message: 'That pull request is not tracked any more.' };
  }

  const eligible = sortFindingsForPost(
    await findingsForPost(review.id, findingIds.length ? findingIds : null)
  );
  if (!eligible.length) {
    return {
      ok: false,
      code: 'nothing_to_post',
      message: 'There is nothing to post. Every open finding is already on the pull request.',
    };
  }

  let rangesByPath: Map<string, LineRange[]>;
  try {
    rangesByPath = await diffRanges(review, pr, eligible);
  } catch (err) {
    return { ok: false, code: 'github_failed', message: describe(err) };
  }

  const reviewedHeadSha = review.reviewedHeadSha;
  const plan = planReview(reviewedHeadSha, eligible, rangesByPath);
  if (!plan.postedIds.length) return TOO_LARGE;

  let sent = plan;
  let created: { id: number; html_url?: string };
  try {
    created = await send(review, pr, sent);
  } catch (err) {
    // 422 means GitHub refused a comment's position, and it refuses the whole
    // review for one bad comment. Send it once more with every finding in the
    // body, which has no position to refuse.
    const refusedPosition =
      err instanceof GitHubApiError && err.status === 422 && plan.comments.length > 0;
    if (!refusedPosition) return { ok: false, code: 'github_failed', message: describe(err) };
    sent = planReview(reviewedHeadSha, eligible, new Map());
    if (!sent.postedIds.length) return TOO_LARGE;
    try {
      created = await send(review, pr, sent);
    } catch (retryErr) {
      return { ok: false, code: 'github_failed', message: describe(retryErr) };
    }
  }

  const githubReviewId = created?.id != null ? String(created.id) : null;
  await markPosted(review.id, sent.postedIds, githubReviewId);
  const inline = sent.comments.length;
  const inSummary = sent.postedIds.length - inline;
  await appendReviewEvent(review.id, {
    fromPhase: review.phase as CodeReviewPhase,
    toPhase: review.phase as CodeReviewPhase,
    trigger: 'user:post',
    code: 'posted_to_pr',
    message: `Posted ${sent.postedIds.length} finding(s) to the pull request.`,
    detail: {
      findingIds: sent.postedIds,
      inline,
      inSummary,
      leftOut: sent.leftOut,
      githubReviewId,
      userId,
    },
  });
  return {
    ok: true,
    posted: sent.postedIds.length,
    inline,
    inSummary,
    reviewUrl: created?.html_url ?? null,
  };
}

/**
 * The commentable lines of each file a finding names.
 *
 * Empty when no finding could go inline, which saves the request. Also empty
 * when the pull request has moved past the reviewed commit: the file listing
 * describes the newest commit, and its lines prove nothing about the old one.
 */
async function diffRanges(
  review: ReviewRow,
  pr: { workspaceId: string; owner: string; repo: string; number: number; lastSummary: unknown },
  findings: FindingDetailRow[]
): Promise<Map<string, LineRange[]>> {
  const ranges = new Map<string, LineRange[]>();
  const wanted = new Set(
    findings.filter((f) => f.anchorVerified && f.filePath && f.lineStart).map((f) => f.filePath)
  );
  if (!wanted.size) return ranges;
  const currentHead = ((pr.lastSummary ?? {}) as { headSha?: string }).headSha;
  if (currentHead && currentHead !== review.reviewedHeadSha) return ranges;

  const files = await githubService.getAllPRFiles(pr.workspaceId, pr.owner, pr.repo, pr.number);
  for (const file of files) {
    if (wanted.has(file.filename)) ranges.set(file.filename, commentableRightLines(file.patch));
  }
  return ranges;
}

interface ReviewPlan {
  body: string;
  comments: Array<{
    path: string;
    line: number;
    side: 'RIGHT';
    start_line?: number;
    start_side?: 'RIGHT';
    body: string;
  }>;
  /** Every finding this plan puts on the pull request, inline or in the body. */
  postedIds: string[];
  /** How many did not fit. They stay unposted. */
  leftOut: number;
}

/** Decide where each finding goes and write the text. Pure. */
export function planReview(
  reviewedHeadSha: string,
  findings: FindingDetailRow[],
  rangesByPath: ReadonlyMap<string, LineRange[]>
): ReviewPlan {
  const comments: ReviewPlan['comments'] = [];
  const inlineIds: string[] = [];
  const summary: FindingDetailRow[] = [];
  for (const finding of findings) {
    const placement = placeFinding(finding, rangesByPath);
    const body = placement.kind === 'inline' ? inlineCommentBody(finding) : '';
    // A comment has the same size limit as the body. One that is over it goes
    // to the summary, where the whole-finding rule leaves it out.
    if (placement.kind !== 'inline' || body.length > GITHUB_BODY_LIMIT) {
      summary.push(finding);
      continue;
    }
    inlineIds.push(finding.id);
    comments.push({
      path: placement.path,
      line: placement.line,
      side: 'RIGHT',
      ...(placement.startLine !== undefined
        ? { start_line: placement.startLine, start_side: 'RIGHT' as const }
        : {}),
      body,
    });
  }
  const reviewBody = buildReviewBody({
    shaShort: reviewedHeadSha.slice(0, 7),
    inlineCount: comments.length,
    summaryFindings: summary,
  });
  return {
    body: reviewBody.body,
    comments,
    postedIds: [...inlineIds, ...reviewBody.included.map((f) => f.id)],
    leftOut: reviewBody.leftOut.length,
  };
}

function send(
  review: ReviewRow,
  pr: { workspaceId: string; owner: string; repo: string; number: number },
  plan: ReviewPlan
) {
  return githubService.createPRReview(pr.workspaceId, pr.owner, pr.repo, pr.number, {
    // Always a comment. A review bot must never approve or block a merge.
    event: 'COMMENT',
    commit_id: review.reviewedHeadSha as string,
    body: plan.body,
    ...(plan.comments.length ? { comments: plan.comments } : {}),
  });
}
