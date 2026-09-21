// Read a viewer's own review history out of GitHub, once.
//
// # Why this exists at all
//
// A per-user ranking model needs labelled examples of what that person chose to
// review. The obvious source is in-app telemetry, and it is the wrong one: a
// single user generates on the order of 20-100 review decisions a month, so a
// defensible sample is six to twenty-four months away. GitHub already holds the
// same history, complete, and hands it over in two searches.
//
// # Why GraphQL search and not REST search
//
// This bills against the ~5,000/hr POINT budget that `graphqlBudget.ts` tracks,
// and therefore never touches the 30/min REST Search budget that
// `github.searchPullRequestNumbers` serializes per account — the budget the
// poll's three-searches-per-repo-per-tick already lives inside. A backfill that
// competed there would stall PR discovery for every workspace on the same
// installation, to populate one person's model.
//
// # The cost, stated
//
// Per PR the selection is ~61 nodes (files 20, reviews 20, timeline 20, plus
// scalars). At 25 PRs a page that is ~1,525 nodes ≈ 16 points. Capped at 400
// PRs per class, so 32 pages ≈ 510 points — about 10% of one hour's budget,
// once per viewer, and skipped outright when the budget is already in reserve.

import { and, eq, sql } from 'drizzle-orm';
import { githubService } from '../github.js';
// One definition of "which directories is this PR in", shared with the live
// poll. Two copies would let the backfill's history and the live rows disagree
// about the same repository's layout, and the model would be fitted on one set
// of directory names and applied to another.
import { topDirsOf } from '../githubGraphql.js';
import { graphqlBudget } from '../graphqlBudget.js';
import { getPoolDbClient } from '../../db/client.js';
import { reviewHistory, reviewRankModels } from '../../db/schema.js';

/**
 * How many PRs to read per class.
 *
 * Not a round number for its own sake: 400 reviewed PRs is about a year for
 * somebody doing 5-15 a week, which is the population this feature is for, and
 * it is the point where the per-page cost stops buying much — habits from two
 * years ago describe a different team. Raising it costs points linearly.
 */
export const BACKFILL_PR_CAP = 400;

/**
 * The recipe version of the collected history.
 *
 * BUMP THIS whenever the shape this backfill writes changes — a new column, a
 * different derivation, a widened cap. `hasBackfilled` compares against it, so
 * a bump re-reads history for every viewer on the next sweep.
 *
 * Without it a completion marker means "done" and cannot mean "done, to an
 * older recipe": everyone already marked done keeps a history missing the new
 * field, every feature reading it returns zero for all of them, and nothing
 * reports it. The model just quietly gets worse than it should be.
 *
 *  1 — author, repo, size, dirs, request/review timestamps
 *  2 — adds the requesting TEAM slugs (migration 0063)
 */
export const BACKFILL_VERSION = 2;

/** GitHub's search page size. 25 keeps each query's node count off the 504 line. */
const PAGE_SIZE = 25;

/** Nothing about a PR's live state — see the module header of `reviewRank.ts`. */
const HISTORY_PR_FIELDS = `
  number
  createdAt
  closedAt
  additions
  deletions
  author { login }
  repository { nameWithOwner }
  files(first: 20) { nodes { path } }
  reviews(first: 20) { nodes { author { login } submittedAt } }
  timelineItems(first: 20, itemTypes: [REVIEW_REQUESTED_EVENT]) {
    nodes {
      ... on ReviewRequestedEvent {
        createdAt
        requestedReviewer {
          __typename
          ... on User { login }
          ... on Team { combinedSlug }
        }
      }
    }
  }
`;

interface RawHistoryPr {
  number: number;
  createdAt: string;
  closedAt: string | null;
  additions: number | null;
  deletions: number | null;
  author: { login: string } | null;
  repository: { nameWithOwner: string };
  files?: { nodes: Array<{ path: string }> } | null;
  reviews?: { nodes: Array<{ author: { login: string } | null; submittedAt: string | null }> } | null;
  timelineItems?: {
    nodes: Array<{
      createdAt?: string;
      requestedReviewer?:
        | { __typename: 'User'; login: string }
        | { __typename: 'Team'; combinedSlug: string }
        | { __typename: string }
        | null;
    }>;
  } | null;
}

interface SearchResponse {
  search: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<RawHistoryPr | Record<string, never>>;
  };
  rateLimit?: { limit: number; cost: number; remaining: number; resetAt: string };
}

/** One row of training data, before it is written. */
export interface ReviewHistoryRow {
  repoFullName: string;
  prNumber: number;
  authorLogin: string;
  requestedAt: Date | null;
  reviewedAt: Date | null;
  closedAt: Date | null;
  direct: boolean;
  additions: number | null;
  deletions: number | null;
  dirs: string[];
  /** Team slugs whose request put this PR in front of the viewer. */
  teams: string[];
}

/**
 * Turn one raw PR into a training row from `viewerLogin`'s point of view.
 *
 * Returns null when the PR cannot be labelled — no author, or the viewer is the
 * author. A viewer's own PR is not a review decision and would teach the model
 * that people love their own code.
 */
export function toHistoryRow(raw: RawHistoryPr, viewerLogin: string): ReviewHistoryRow | null {
  const author = raw.author?.login;
  if (!author) return null;
  const me = viewerLogin.toLowerCase();
  if (author.toLowerCase() === me) return null;

  const myReview = (raw.reviews?.nodes ?? []).find(
    (r) => r.author?.login?.toLowerCase() === me && r.submittedAt,
  );

  // The earliest request that named the viewer. Team requests count — they are
  // how most review work arrives — but `direct` records which it was, because
  // the two are not equally strong asks.
  let requestedAt: Date | null = null;
  let direct = false;
  const teams: string[] = [];
  for (const node of raw.timelineItems?.nodes ?? []) {
    const rr = node.requestedReviewer;
    if (!rr || !node.createdAt) continue;
    const isMe = rr.__typename === 'User' && (rr as { login: string }).login.toLowerCase() === me;
    const isTeam = rr.__typename === 'Team';
    if (!isMe && !isTeam) continue;
    const at = new Date(node.createdAt);
    if (!Number.isFinite(at.getTime())) continue;
    if (!requestedAt || at < requestedAt) requestedAt = at;
    if (isMe) direct = true;
    if (isTeam) {
      // The slug the request actually carried, kept rather than reduced to the
      // `direct` boolean it used to be. This is the team-affinity feature's
      // only source of history.
      const slug = (rr as { combinedSlug: string }).combinedSlug?.toLowerCase();
      if (slug && !teams.includes(slug)) teams.push(slug);
    }
  }

  // GitHub does not emit a ReviewRequestedEvent for a reviewer named in the
  // PR's opening payload, so a PR the viewer reviewed with no timeline entry
  // was requested at creation. Falling back is better than dropping the row:
  // opening-payload requests are common and skew toward the people you work
  // with most, which is the signal this whole thing is about.
  if (!requestedAt && myReview) requestedAt = new Date(raw.createdAt);

  return {
    repoFullName: raw.repository.nameWithOwner,
    prNumber: raw.number,
    authorLogin: author,
    requestedAt,
    reviewedAt: myReview?.submittedAt ? new Date(myReview.submittedAt) : null,
    closedAt: raw.closedAt ? new Date(raw.closedAt) : null,
    direct,
    additions: raw.additions ?? null,
    deletions: raw.deletions ?? null,
    dirs: topDirsOf((raw.files?.nodes ?? []).map((f) => f.path)),
    teams,
  };
}

function searchQuery(): string {
  return `query ReviewHistory($q: String!, $after: String) {
    search(type: ISSUE, first: ${PAGE_SIZE}, query: $q, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ... on PullRequest { ${HISTORY_PR_FIELDS} } }
    }
    rateLimit { limit cost remaining resetAt }
  }`;
}

async function searchPage(
  workspaceId: string,
  q: string,
  after: string | null,
): Promise<{ rows: RawHistoryPr[]; next: string | null }> {
  const data = await githubService.executeGraphql<SearchResponse>(workspaceId, searchQuery(), {
    q,
    after,
  });
  const rows = (data.search?.nodes ?? []).filter(
    (n): n is RawHistoryPr => !!n && typeof (n as RawHistoryPr).number === 'number',
  );
  const page = data.search?.pageInfo;
  return { rows, next: page?.hasNextPage ? (page.endCursor ?? null) : null };
}

/** Read up to `cap` PRs matching one search, honouring the point budget. */
async function collect(
  workspaceId: string,
  q: string,
  cap: number,
  accountKey: string,
): Promise<RawHistoryPr[]> {
  const out: RawHistoryPr[] = [];
  let cursor: string | null = null;
  while (out.length < cap) {
    // Re-checked EVERY page, not once at the start: the poller, the merge queue
    // and the reconcile sweep are spending from the same per-account bucket
    // while this runs, and a backfill that kept going would take the reserve
    // they depend on.
    if (graphqlBudget.shouldDefer(accountKey)) break;
    const { rows, next } = await searchPage(workspaceId, q, cursor);
    out.push(...rows);
    if (!next) break;
    cursor = next;
  }
  return out.slice(0, cap);
}

export interface BackfillResult {
  rows: number;
  /** True when the point budget cut the read short — a partial history. */
  deferred: boolean;
}

/**
 * Read `viewerLogin`'s review history into `review_history`.
 *
 * Both classes come from a search, and the negative one is the interesting
 * half: GitHub REMOVES an individual review request the moment you submit a
 * review, so a PR still carrying a standing `review-requested:{login}` is, to a
 * good approximation, exactly a request that was never serviced. Closed and
 * merged PRs keep the record, which is what makes the class collectable at all.
 *
 * Idempotent: rows are keyed by (workspace, viewer, repo, number) and upserted,
 * so a re-run after a deferral fills in what it missed rather than duplicating.
 */
export async function backfillReviewHistory(
  workspaceId: string,
  viewerLogin: string,
  cap = BACKFILL_PR_CAP,
): Promise<BackfillResult> {
  const db = getPoolDbClient();
  const accountKey = githubService.accountKeyFor(workspaceId);

  if (graphqlBudget.shouldDefer(accountKey)) return { rows: 0, deferred: true };

  const reviewed = await collect(
    workspaceId,
    `is:pr reviewed-by:${viewerLogin} sort:updated-desc`,
    cap,
    accountKey,
  );
  const requested = await collect(
    workspaceId,
    `is:pr review-requested:${viewerLogin} sort:updated-desc`,
    cap,
    accountKey,
  );

  // A PR can legitimately appear in both — reviewed once, then re-requested —
  // and the reviewed reading is the truthful one, so it wins.
  const byKey = new Map<string, RawHistoryPr>();
  for (const raw of requested) byKey.set(`${raw.repository.nameWithOwner}#${raw.number}`, raw);
  for (const raw of reviewed) byKey.set(`${raw.repository.nameWithOwner}#${raw.number}`, raw);

  const rows: ReviewHistoryRow[] = [];
  for (const raw of byKey.values()) {
    const row = toHistoryRow(raw, viewerLogin);
    if (row) rows.push(row);
  }

  if (rows.length > 0) {
    await db
      .insert(reviewHistory)
      .values(
        rows.map((r) => ({
          workspaceId,
          viewerLogin,
          repoFullName: r.repoFullName,
          prNumber: r.prNumber,
          authorLogin: r.authorLogin,
          requestedAt: r.requestedAt,
          reviewedAt: r.reviewedAt,
          closedAt: r.closedAt,
          direct: r.direct,
          additions: r.additions,
          deletions: r.deletions,
          dirs: r.dirs,
          teams: r.teams,
        })),
      )
      .onConflictDoUpdate({
        target: [
          reviewHistory.workspaceId,
          reviewHistory.viewerLogin,
          reviewHistory.repoFullName,
          reviewHistory.prNumber,
        ],
        set: {
          reviewedAt: sql`excluded.reviewed_at`,
          closedAt: sql`excluded.closed_at`,
          requestedAt: sql`excluded.requested_at`,
          direct: sql`excluded.direct`,
          additions: sql`excluded.additions`,
          deletions: sql`excluded.deletions`,
          dirs: sql`excluded.dirs`,
          teams: sql`excluded.teams`,
        },
      });
  }

  const deferred = graphqlBudget.shouldDefer(accountKey);
  // Only a COMPLETE read marks the backfill done. A run the budget cut short
  // leaves `backfilledAt` null so the next sweep finishes the job — otherwise a
  // single unlucky hour would permanently cap somebody's history at whatever
  // fitted in it.
  if (!deferred) {
    await db
      .insert(reviewRankModels)
      .values({
        workspaceId,
        viewerLogin,
        backfilledAt: new Date(),
        backfillVersion: BACKFILL_VERSION,
      })
      .onConflictDoUpdate({
        target: [reviewRankModels.workspaceId, reviewRankModels.viewerLogin],
        set: { backfilledAt: new Date(), backfillVersion: BACKFILL_VERSION },
      });
  }

  return { rows: rows.length, deferred };
}

/**
 * Whether this viewer's history has been read AT THE CURRENT RECIPE.
 *
 * Not merely "has it ever been read". A viewer backfilled under an older
 * {@link BACKFILL_VERSION} is missing whatever that version did not collect, so
 * they are re-read — which is the whole point of versioning the marker.
 */
export async function hasBackfilled(workspaceId: string, viewerLogin: string): Promise<boolean> {
  const db = getPoolDbClient();
  const [row] = await db
    .select({
      backfilledAt: reviewRankModels.backfilledAt,
      backfillVersion: reviewRankModels.backfillVersion,
    })
    .from(reviewRankModels)
    .where(
      and(
        eq(reviewRankModels.workspaceId, workspaceId),
        eq(reviewRankModels.viewerLogin, viewerLogin),
      ),
    )
    .limit(1);
  return !!row?.backfilledAt && (row.backfillVersion ?? 0) >= BACKFILL_VERSION;
}
