import { githubService } from './github.js';

/**
 * Batched GraphQL fetch for a workspace's PRs, modelled on supacode's
 * `GithubCLIClient.batchPullRequests`.
 *
 * One repo at a time, PRs chunked into small groups per query. Each PR
 * pulls a full `statusCheckRollup.contexts(first: 100)` + reviews +
 * comments, which is expensive server-side — large repos (e.g. ones
 * with big CI matrices) make a 25-wide query time out (504). Keep the
 * chunk small so each request stays within GitHub's GraphQL budget. Up
 * to 3 chunks fire concurrently.
 *
 * Each query aliases per-branch sub-queries inside one `repository`
 * node and pulls everything the cache layer needs in one shot:
 * pull-request summary, last 5 reviews (full history is paginated on
 * demand by the detail panel), `statusCheckRollup.contexts(first: 100)`
 * as a `CheckRun | StatusContext` union, plus `mergeable`,
 * `mergeStateStatus`, and `reviewDecision`.
 *
 * Pure-functional response decoders + state-collapse logic live below
 * so they can be unit-tested without a live token.
 */

// ---------- Public types ----------

export type PRState = 'open' | 'closed' | 'merged';

export type CheckState =
  | 'pending'
  | 'in_progress'
  | 'success'
  | 'failure'
  | 'skipped'
  | 'neutral'
  | 'cancelled';

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

export type BlockingReason =
  | 'mergeable'
  | 'merge_conflicts'
  | 'changes_requested'
  | 'checks_failed'
  // Mergeable, but one or more *non-required* checks are failing. GitHub
  // doesn't block the merge on these, so we surface them as a distinct,
  // de-emphasised state rather than the hard red 'checks_failed'.
  | 'checks_failed_optional'
  | 'blocked'
  | 'unknown';

export interface CheckBreakdown {
  total: number;
  passed: number;
  failed: number;
  inProgress: number;
  skipped: number;
}

export interface PRSummary {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  draft: boolean;
  state: PRState;
  mergedAt: string | null;
  closedAt: string | null;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  reviewDecision: ReviewDecision;
  blockingReason: BlockingReason;
  checks: CheckBreakdown;
  /** Count of unresolved review threads (capped at the first 100 threads). */
  unresolvedReviewThreads: number;
  /**
   * Per-check rows behind the `checks` rollup — name, normalized state,
   * and a link to the run/target. Not persisted (summaryToJsonb keeps
   * only the counts); flows through the live detail fetch so the
   * desktop Checks tab can render individual rows instead of a rollup +
   * "view on GitHub".
   */
  checkContexts: Array<{ name: string; state: CheckState; url: string | null }>;
  /** Rolling hash of `headSha + sorted(check.state per name)` — used by
   *  the cursor logic to detect "checks changed" without diffing the
   *  whole rollup payload. */
  checkDigest: string;
  /** Last 5 reviews, freshest first. Detail-view paginates more on demand. */
  recentReviews: Array<{
    id: string;
    author: string;
    state: string;
    submittedAt: string | null;
    url: string;
  }>;
  /**
   * Last 5 review-thread comments (inline-on-diff comments), freshest
   * first. Used by the prCache to detect new pr_comment events; the
   * detail-view review tab fetches the full thread on demand.
   */
  recentReviewComments: Array<{
    id: string;
    author: string;
    /** True when the author is a GitHub App / bot (e.g. `foo[bot]`). */
    authorIsBot: boolean;
    /** Plain-text comment body — used to detect @-mentions of the viewer. */
    bodyText: string;
    createdAt: string;
    url: string;
  }>;
  /**
   * Last 5 issue-style PR comments (top-level conversation), freshest
   * first. Same delta-detection role as recentReviewComments.
   */
  recentComments: Array<{
    id: string;
    author: string;
    authorIsBot: boolean;
    bodyText: string;
    createdAt: string;
    url: string;
  }>;
}

export interface BatchPRResult {
  /** The branch we asked about. */
  branch: string;
  /** Null when the branch has no PR (or only closed/merged PRs we didn't
   *  ask for — query is `states: [OPEN]`). */
  pr: PRSummary | null;
}

// ---------- Public API ----------

// Small chunk: each PR's statusCheckRollup is heavy to resolve, so a
// wide query times out on big repos. 5 keeps requests fast at the cost
// of a few more round-trips.
const CHUNK_SIZE = 5;
const CONCURRENCY = 3;

export async function batchPullRequests(opts: {
  workspaceId: string;
  owner: string;
  repo: string;
  branches: string[];
}): Promise<BatchPRResult[]> {
  const { workspaceId, owner, repo, branches } = opts;
  if (branches.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < branches.length; i += CHUNK_SIZE) {
    chunks.push(branches.slice(i, i + CHUNK_SIZE));
  }

  // Bounded-concurrency runner: never more than CONCURRENCY queries in
  // flight at once. Each chunk is one GraphQL request.
  const results: BatchPRResult[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < chunks.length) {
      const idx = cursor++;
      const chunk = chunks[idx];
      const query = makeBatchPullRequestsQuery(chunk);
      const data = await githubService.executeGraphql<BatchPullRequestsResponse>(
        workspaceId,
        query,
        { owner, repo }
      );
      await topUpCheckContexts(extractBranchPRs(data, chunk.length), {
        workspaceId,
        owner,
        repo,
      });
      results.push(...decodeBatchResponse(chunk, data, owner, repo));
    }
  }
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, chunks.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

export interface BatchPRByNumberResult {
  number: number;
  pr: PRSummary | null;
}

/**
 * Fetch PR summaries by number (chunked + bounded-concurrency, same as
 * batchPullRequests). Unlike the branch variant this returns
 * merged/closed PRs too — `pullRequest(number:)` has no `states` filter.
 */
export async function batchPullRequestsByNumber(opts: {
  workspaceId: string;
  owner: string;
  repo: string;
  numbers: number[];
}): Promise<BatchPRByNumberResult[]> {
  const { workspaceId, owner, repo, numbers } = opts;
  if (numbers.length === 0) return [];

  const chunks: number[][] = [];
  for (let i = 0; i < numbers.length; i += CHUNK_SIZE) {
    chunks.push(numbers.slice(i, i + CHUNK_SIZE));
  }

  const results: BatchPRByNumberResult[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < chunks.length) {
      const idx = cursor++;
      const chunk = chunks[idx];
      const query = makeBatchPullRequestsByNumberQuery(chunk);
      const data = await githubService.executeGraphql<BatchByNumberResponse>(
        workspaceId,
        query,
        { owner, repo }
      );
      await topUpCheckContexts(extractByNumberPRs(data, chunk.length), {
        workspaceId,
        owner,
        repo,
      });
      results.push(...decodeBatchByNumberResponse(chunk, data, owner, repo));
    }
  }
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, chunks.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

// ---------- statusCheckRollup pagination ----------
//
// GraphQL caps a connection's `first` at 100, so a PR with >100 check
// contexts comes back truncated — wrong counts AND a wrong blocking
// reason (a failure beyond #100 would read as green). For any PR whose
// `contexts` page reports `hasNextPage`, we walk the remaining pages and
// splice them into the raw nodes before `rawToSummary` counts them.
// Cheap in practice: only PRs with 100+ checks pay for extra round-trips.

const MAX_CONTEXT_PAGES = 50; // 50 * 100 = 5000 checks — a sane ceiling.

interface ContextsPageResponse {
  repository: {
    pullRequest: {
      commits: {
        nodes: Array<{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: Array<RawCheckContext>;
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
              };
            } | null;
          };
        }>;
      };
    } | null;
  } | null;
}

function makeContextsPageQuery(): string {
  return `query ContextsPage($owner: String!, $repo: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100, after: $after) {
                nodes {
                  ${CONTEXT_NODE_FIELDS}
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      }
    }
  }
}`;
}

async function fetchRemainingCheckContexts(
  workspaceId: string,
  owner: string,
  repo: string,
  number: number,
  startCursor: string
): Promise<RawCheckContext[]> {
  const out: RawCheckContext[] = [];
  const query = makeContextsPageQuery();
  let after: string | null = startCursor;
  let page = 0;
  while (after && page < MAX_CONTEXT_PAGES) {
    page++;
    const data: ContextsPageResponse =
      await githubService.executeGraphql<ContextsPageResponse>(workspaceId, query, {
        owner,
        repo,
        number,
        after,
      });
    const conn =
      data.repository?.pullRequest?.commits.nodes[0]?.commit.statusCheckRollup
        ?.contexts;
    if (!conn) break;
    out.push(...conn.nodes);
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  }
  return out;
}

/**
 * For each PR whose first contexts page reports more pages, fetch the
 * rest and append them in place. Mutates the raw nodes so the existing
 * `rawToSummary` path sees the complete list. Runs sequentially — the
 * surrounding batch worker is already concurrency-bounded, and >100-check
 * PRs are rare enough that serial top-ups don't meaningfully add latency.
 */
async function topUpCheckContexts(
  prs: RawPullRequest[],
  ctx: { workspaceId: string; owner: string; repo: string }
): Promise<void> {
  for (const pr of prs) {
    const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
    const pageInfo = rollup?.contexts.pageInfo;
    if (!rollup || !pageInfo?.hasNextPage || !pageInfo.endCursor) continue;
    const remaining = await fetchRemainingCheckContexts(
      ctx.workspaceId,
      ctx.owner,
      ctx.repo,
      pr.number,
      pageInfo.endCursor
    );
    rollup.contexts.nodes.push(...remaining);
    rollup.contexts.pageInfo = { hasNextPage: false, endCursor: null };
  }
}

function extractBranchPRs(
  data: BatchPullRequestsResponse,
  count: number
): RawPullRequest[] {
  const prs: RawPullRequest[] = [];
  for (let idx = 0; idx < count; idx++) {
    const node = data.repository?.[aliasForBranch(idx)]?.nodes?.[0];
    if (node) prs.push(node);
  }
  return prs;
}

function extractByNumberPRs(
  data: BatchByNumberResponse,
  count: number
): RawPullRequest[] {
  const prs: RawPullRequest[] = [];
  for (let idx = 0; idx < count; idx++) {
    const node = data.repository?.[aliasForBranch(idx)];
    if (node) prs.push(node);
  }
  return prs;
}

// ---------- Pure helpers (unit-tested) ----------

/**
 * Collapse GitHub's three-axis check signal (`status` / `conclusion` /
 * `state`) into one verdict. Modelled on supacode's
 * `GithubPullRequestStatusCheck.normalize`.
 *
 *   - `status != COMPLETED` → in_progress / pending
 *   - else `conclusion` wins (NEUTRAL/SKIPPED → success-ish; FAILURE →
 *     failure; etc.)
 *   - falls back to legacy `state` for `StatusContext` nodes that don't
 *     have a conclusion.
 */
export function normalizeCheckState(input: {
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}): CheckState {
  const status = input.status?.toUpperCase();
  const conclusion = input.conclusion?.toUpperCase();
  const state = input.state?.toUpperCase();

  if (status && status !== 'COMPLETED') {
    if (status === 'QUEUED' || status === 'WAITING' || status === 'PENDING') return 'pending';
    return 'in_progress';
  }
  if (conclusion) {
    switch (conclusion) {
      case 'SUCCESS':
      case 'NEUTRAL':
        return 'success';
      case 'SKIPPED':
        return 'skipped';
      case 'FAILURE':
      case 'TIMED_OUT':
      case 'STARTUP_FAILURE':
      case 'ACTION_REQUIRED':
        return 'failure';
      case 'CANCELLED':
        return 'cancelled';
      default:
        // Unknown conclusion — be conservative.
        return 'failure';
    }
  }
  if (state) {
    switch (state) {
      case 'SUCCESS':
        return 'success';
      case 'FAILURE':
      case 'ERROR':
        return 'failure';
      case 'PENDING':
        return 'pending';
      case 'EXPECTED':
        return 'pending';
      default:
        return 'pending';
    }
  }
  return 'pending';
}

/**
 * Compute the merge-readiness verdict from the rolled-up signals.
 * Modelled on supacode's `PullRequestMergeReadiness`.
 *
 * Order matters: a PR can be CONFLICTING AND have failed checks AND
 * have changes requested — we surface the most actionable single
 * reason. Conflicts are first because the PR can't be merged at all
 * until they're resolved; reviews are next because they need a human;
 * checks are last because they often re-run on push.
 */
export function computeBlockingReason(input: {
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  reviewDecision: ReviewDecision;
  checks: CheckBreakdown;
}): BlockingReason {
  if (input.mergeable === 'CONFLICTING') return 'merge_conflicts';
  if (input.reviewDecision === 'CHANGES_REQUESTED') return 'changes_requested';

  const upper = input.mergeStateStatus.toUpperCase();
  // A failing check only *blocks* the merge when it's a required check.
  // GitHub reports "mergeable, but with non-passing checks" as the
  // UNSTABLE merge state — those failing checks aren't required (a failing
  // required check would make the PR BLOCKED instead), so they don't
  // block. Any other state with failures means a required check is red.
  const failuresBlock =
    input.checks.failed > 0 && !(input.mergeable === 'MERGEABLE' && upper === 'UNSTABLE');
  if (failuresBlock) return 'checks_failed';

  // A required review that hasn't landed yet → "Review". Checked before
  // the mergeable branch because GitHub computes `mergeable` lazily and
  // returns UNKNOWN on first fetch — reviewDecision is computed
  // independently, so this keeps a waiting-on-review PR from flashing as
  // an unknown "—" until mergeability resolves.
  if (input.reviewDecision === 'REVIEW_REQUIRED') return 'blocked';
  if (input.mergeable === 'MERGEABLE') {
    // A PR can be MERGEABLE but still BLOCKED by branch-protection
    // (e.g. required reviews missing). The mergeStateStatus surfaces
    // that.
    if (upper === 'BLOCKED') return 'blocked';
    // Mergeable, but non-required checks are failing (we only reach here
    // with failures when the state is UNSTABLE) — de-emphasised, not red.
    if (input.checks.failed > 0) return 'checks_failed_optional';
    return 'mergeable';
  }
  // mergeable === 'UNKNOWN' — GitHub hasn't computed it yet (background
  // job). Surface as `unknown` so the UI can show a spinner rather
  // than guessing.
  return 'unknown';
}

/**
 * Hash of `headSha + sorted "name=state" pairs`. Used by the cursor
 * logic to detect "checks changed" without diffing the whole rollup.
 *
 * Stable: same input always produces the same string. Cheap: scan +
 * sort + concat, no crypto. Length-bounded: ~32 chars per check times
 * a few hundred checks max.
 */
export function computeCheckDigest(
  headSha: string,
  contexts: Array<{ name: string; state: CheckState }>
): string {
  const sorted = contexts
    .map((c) => `${c.name}=${c.state}`)
    .sort()
    .join('|');
  return `${headSha}:${sorted}`;
}

// ---------- GraphQL query construction ----------

/**
 * Build the per-chunk query. Each branch becomes one aliased
 * sub-selection on `repository.pullRequests` (states: [OPEN], first: 1,
 * head order). Aliases must be valid GraphQL identifiers — we hash the
 * branch name to a stable safe alias.
 */
// Selection for one statusCheckRollup context node. Shared by the
// PRFields fragment and the standalone contexts-pagination query so the
// two never drift.
const CONTEXT_NODE_FIELDS = `__typename
              ... on CheckRun {
                id
                name
                status
                conclusion
                detailsUrl
                startedAt
                completedAt
                checkSuite { app { name } }
              }
              ... on StatusContext {
                id
                context
                state
                description
                targetUrl
                createdAt
              }`;

const PR_FIELDS_FRAGMENT = `fragment PRFields on PullRequest {
  number
  title
  body
  url
  isDraft
  state
  mergedAt
  closedAt
  createdAt
  updatedAt
  mergeable
  mergeStateStatus
  reviewDecision
  author { login }
  headRefName
  baseRefName
  headRefOid
  reviews(last: 5) {
    nodes { id author { login } state submittedAt url }
  }
  reviewThreads(last: 5) {
    nodes {
      comments(last: 1) {
        nodes { id author { login __typename } createdAt url bodyText }
      }
    }
  }
  unresolvedThreads: reviewThreads(first: 100) {
    nodes { isResolved }
  }
  comments(last: 5) {
    nodes { id author { login __typename } createdAt url bodyText }
  }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          contexts(first: 100) {
            nodes {
              ${CONTEXT_NODE_FIELDS}
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
}`;

export function makeBatchPullRequestsQuery(branches: string[]): string {
  const aliasFields = branches
    .map((branch, idx) => {
      const alias = aliasForBranch(idx);
      // Escape branch names safely as JSON strings inside the GraphQL doc.
      const head = JSON.stringify(branch);
      return `    ${alias}: pullRequests(headRefName: ${head}, first: 1, states: [OPEN]) {
      nodes { ...PRFields }
    }`;
    })
    .join('\n');

  return `query BatchPullRequests($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
${aliasFields}
  }
}

${PR_FIELDS_FRAGMENT}`;
}

/**
 * Same as makeBatchPullRequestsQuery but keyed by PR number instead of
 * branch — `pullRequest(number:)` resolves to a single node (no
 * `states` filter, so it also returns merged/closed PRs). Used by the
 * search-driven monitor, where we know numbers but not head refs.
 */
export function makeBatchPullRequestsByNumberQuery(numbers: number[]): string {
  const aliasFields = numbers
    .map((number, idx) => {
      const alias = aliasForBranch(idx);
      return `    ${alias}: pullRequest(number: ${number}) {
      ...PRFields
    }`;
    })
    .join('\n');

  return `query BatchPullRequestsByNumber($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
${aliasFields}
  }
}

${PR_FIELDS_FRAGMENT}`;
}

export function aliasForBranch(idx: number): string {
  return `b${idx}`;
}

// ---------- GraphQL response decoding ----------

interface BatchPullRequestsResponse {
  repository: Record<string, { nodes: Array<RawPullRequest> }> | null;
}

interface BatchByNumberResponse {
  repository: Record<string, RawPullRequest | null> | null;
}

export function decodeBatchByNumberResponse(
  numbers: number[],
  data: BatchByNumberResponse,
  owner: string,
  repo: string
): BatchPRByNumberResult[] {
  if (!data.repository) {
    return numbers.map((number) => ({ number, pr: null }));
  }
  return numbers.map((number, idx) => {
    const alias = aliasForBranch(idx);
    const node = data.repository?.[alias];
    if (!node) return { number, pr: null };
    return { number, pr: rawToSummary(node, owner, repo) };
  });
}

interface RawPullRequest {
  number: number;
  title: string;
  body: string | null;
  url: string;
  isDraft: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  reviewDecision: ReviewDecision;
  author: { login: string } | null;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  reviews: {
    nodes: Array<{
      id: string;
      author: { login: string } | null;
      state: string;
      submittedAt: string | null;
      url: string;
    }>;
  };
  reviewThreads: {
    nodes: Array<{
      comments: {
        nodes: Array<{
          id: string;
          author: { login: string; __typename?: string } | null;
          createdAt: string;
          url: string;
          bodyText?: string | null;
        }>;
      };
    }>;
  };
  unresolvedThreads: {
    nodes: Array<{ isResolved: boolean }>;
  };
  comments: {
    nodes: Array<{
      id: string;
      author: { login: string; __typename?: string } | null;
      createdAt: string;
      url: string;
      bodyText?: string | null;
    }>;
  };
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          state: string;
          contexts: {
            nodes: Array<RawCheckContext>;
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      };
    }>;
  };
}

interface RawCheckRun {
  __typename: 'CheckRun';
  id: string;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
  checkSuite: { app: { name: string } | null } | null;
}

interface RawStatusContext {
  __typename: 'StatusContext';
  id: string;
  context: string;
  state: string;
  description: string | null;
  targetUrl: string | null;
  createdAt: string | null;
}

type RawCheckContext = RawCheckRun | RawStatusContext;

export function decodeBatchResponse(
  branches: string[],
  data: BatchPullRequestsResponse,
  owner: string,
  repo: string
): BatchPRResult[] {
  if (!data.repository) {
    // Repo deleted, renamed, or visibility changed. Map every branch
    // to "no PR found" rather than crashing the whole batch.
    return branches.map((branch) => ({ branch, pr: null }));
  }
  return branches.map((branch, idx) => {
    const alias = aliasForBranch(idx);
    const node = data.repository?.[alias]?.nodes?.[0];
    if (!node) return { branch, pr: null };
    return { branch, pr: rawToSummary(node, owner, repo) };
  });
}

function rawToSummary(raw: RawPullRequest, owner: string, repo: string): PRSummary {
  const contexts =
    raw.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const normalizedContexts = contexts.map((c) => ({
    name: c.__typename === 'CheckRun' ? c.name : c.context,
    state: normalizeCheckState(
      c.__typename === 'CheckRun'
        ? { status: c.status, conclusion: c.conclusion }
        : { state: c.state }
    ),
    url: (c.__typename === 'CheckRun' ? c.detailsUrl : c.targetUrl) ?? null,
  }));
  const checks: CheckBreakdown = {
    total: normalizedContexts.length,
    passed: normalizedContexts.filter((c) => c.state === 'success').length,
    failed: normalizedContexts.filter((c) => c.state === 'failure').length,
    inProgress: normalizedContexts.filter(
      (c) => c.state === 'in_progress' || c.state === 'pending'
    ).length,
    skipped: normalizedContexts.filter((c) => c.state === 'skipped').length,
  };
  const blockingReason = computeBlockingReason({
    mergeable: raw.mergeable,
    mergeStateStatus: raw.mergeStateStatus,
    reviewDecision: raw.reviewDecision,
    checks,
  });
  const unresolvedReviewThreads = (raw.unresolvedThreads?.nodes ?? []).filter(
    (t) => !t.isResolved
  ).length;
  const state: PRState = raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : 'open';
  return {
    owner,
    repo,
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    url: raw.url,
    author: raw.author?.login ?? '',
    draft: raw.isDraft,
    state,
    mergedAt: raw.mergedAt,
    closedAt: raw.closedAt,
    headBranch: raw.headRefName,
    baseBranch: raw.baseRefName,
    headSha: raw.headRefOid,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    mergeable: raw.mergeable,
    mergeStateStatus: raw.mergeStateStatus,
    reviewDecision: raw.reviewDecision,
    blockingReason,
    checks,
    unresolvedReviewThreads,
    checkContexts: normalizedContexts,
    checkDigest: computeCheckDigest(raw.headRefOid, normalizedContexts),
    recentReviews: raw.reviews.nodes
      .slice()
      .reverse() // GitHub returns last:N oldest-first; we want freshest first
      .map((r) => ({
        id: r.id,
        author: r.author?.login ?? '',
        state: r.state,
        submittedAt: r.submittedAt,
        url: r.url,
      })),
    recentReviewComments: raw.reviewThreads.nodes
      .flatMap((thread) => thread.comments.nodes)
      .slice()
      .reverse()
      .slice(0, 5)
      .map((c) => ({
        id: c.id,
        author: c.author?.login ?? '',
        authorIsBot: isBotActor(c.author),
        bodyText: c.bodyText ?? '',
        createdAt: c.createdAt,
        url: c.url,
      })),
    recentComments: raw.comments.nodes
      .slice()
      .reverse()
      .map((c) => ({
        id: c.id,
        author: c.author?.login ?? '',
        authorIsBot: isBotActor(c.author),
        bodyText: c.bodyText ?? '',
        createdAt: c.createdAt,
        url: c.url,
      })),
  };
}

/**
 * Whether a comment author is a GitHub App / bot rather than a person.
 * GitHub marks App actors with `__typename: 'Bot'`; the `[bot]` login
 * suffix is the canonical fallback for cases where typename is absent.
 */
function isBotActor(
  author: { login: string; __typename?: string } | null | undefined
): boolean {
  if (!author) return false;
  if (author.__typename === 'Bot') return true;
  return author.login.endsWith('[bot]');
}

// ---------- Full review detail (Reviews tab) ----------
//
// The summary path keeps only the last 5 of each kind (delta detection).
// The detail panel's Reviews tab wants the full, GitHub-like picture:
// every submitted review with its body, every inline review thread
// (grouped, with the diff hunk + resolved state), and the top-level
// conversation comments — all with author avatars and markdown bodies.

export interface PRReviewDetailReview {
  id: string;
  author: string;
  avatarUrl: string | null;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED. */
  state: string;
  body: string;
  submittedAt: string | null;
  url: string;
}

export interface PRReviewThreadComment {
  id: string;
  author: string;
  avatarUrl: string | null;
  body: string;
  createdAt: string;
  url: string;
}

export interface PRReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  /** Diff context for the thread (from its first comment). */
  diffHunk: string | null;
  comments: PRReviewThreadComment[];
}

export interface PRConversationComment {
  id: string;
  author: string;
  avatarUrl: string | null;
  body: string;
  createdAt: string;
  url: string;
}

export interface PRReviewDetail {
  reviews: PRReviewDetailReview[];
  threads: PRReviewThread[];
  comments: PRConversationComment[];
}

interface RawReviewDetailResponse {
  repository: {
    pullRequest: {
      reviews: {
        nodes: Array<{
          id: string;
          author: { login: string; avatarUrl: string | null } | null;
          state: string;
          body: string | null;
          submittedAt: string | null;
          url: string;
        }>;
      };
      reviewThreads: {
        nodes: Array<{
          id: string;
          isResolved: boolean;
          isOutdated: boolean;
          path: string | null;
          line: number | null;
          comments: {
            nodes: Array<{
              id: string;
              author: { login: string; avatarUrl: string | null } | null;
              body: string | null;
              diffHunk: string | null;
              createdAt: string;
              url: string;
            }>;
          };
        }>;
      };
      comments: {
        nodes: Array<{
          id: string;
          author: { login: string; avatarUrl: string | null } | null;
          body: string | null;
          createdAt: string;
          url: string;
        }>;
      };
    } | null;
  } | null;
}

const REVIEW_DETAIL_QUERY = `query PRReviewDetail($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(first: 50) {
        nodes { id author { login avatarUrl } state body submittedAt url }
      }
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 100) {
            nodes { id author { login avatarUrl } body diffHunk createdAt url }
          }
        }
      }
      comments(first: 100) {
        nodes { id author { login avatarUrl } body createdAt url }
      }
    }
  }
}`;

/**
 * Fetch the full review/comment thread for a PR for the detail panel's
 * Reviews tab. One GraphQL round-trip; decoded into a GitHub-like shape
 * (reviews timeline + grouped inline threads + conversation comments).
 */
export async function fetchPRReviewDetail(opts: {
  workspaceId: string;
  owner: string;
  repo: string;
  number: number;
}): Promise<PRReviewDetail> {
  const data = await githubService.executeGraphql<RawReviewDetailResponse>(
    opts.workspaceId,
    REVIEW_DETAIL_QUERY,
    { owner: opts.owner, repo: opts.repo, number: opts.number }
  );
  return decodeReviewDetail(data);
}

export function decodeReviewDetail(data: RawReviewDetailResponse): PRReviewDetail {
  const pr = data.repository?.pullRequest;
  if (!pr) return { reviews: [], threads: [], comments: [] };

  const reviews: PRReviewDetailReview[] = pr.reviews.nodes
    // A COMMENTED review with no body is just a container for inline
    // comments (rendered as threads below) — drop it to cut noise.
    .filter((r) => {
      const state = (r.state || '').toUpperCase();
      if (state === 'PENDING') return false;
      if (state === 'COMMENTED') return Boolean(r.body && r.body.trim());
      return true;
    })
    .map((r) => ({
      id: r.id,
      author: r.author?.login ?? 'unknown',
      avatarUrl: r.author?.avatarUrl ?? null,
      state: (r.state || '').toUpperCase(),
      body: r.body ?? '',
      submittedAt: r.submittedAt,
      url: r.url,
    }))
    .sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''));

  const threads: PRReviewThread[] = pr.reviewThreads.nodes
    .map((t) => ({
      id: t.id,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      path: t.path,
      line: t.line,
      diffHunk: t.comments.nodes[0]?.diffHunk ?? null,
      comments: t.comments.nodes.map((c) => ({
        id: c.id,
        author: c.author?.login ?? 'unknown',
        avatarUrl: c.author?.avatarUrl ?? null,
        body: c.body ?? '',
        createdAt: c.createdAt,
        url: c.url,
      })),
    }))
    .filter((t) => t.comments.length > 0)
    // Unresolved threads first; within each group, oldest first.
    .sort((a, b) => {
      if (a.isResolved !== b.isResolved) return a.isResolved ? 1 : -1;
      return (a.comments[0]?.createdAt ?? '').localeCompare(
        b.comments[0]?.createdAt ?? ''
      );
    });

  const comments: PRConversationComment[] = pr.comments.nodes
    .map((c) => ({
      id: c.id,
      author: c.author?.login ?? 'unknown',
      avatarUrl: c.author?.avatarUrl ?? null,
      body: c.body ?? '',
      createdAt: c.createdAt,
      url: c.url,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return { reviews, threads, comments };
}
