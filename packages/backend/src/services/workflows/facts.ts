import type {
  WorkflowCheckConclusion,
  WorkflowEventFacts,
  WorkflowFactField,
  WorkflowReviewState,
  WorkflowTriggerEvent,
} from '@talyn/shared';
import { loginLooksLikeBot } from '@talyn/shared';
import { terminalOutcomeFromPayload, type WebhookDelivery } from '../webhookPayload.js';

/**
 * Turn one webhook delivery into the facts a workflow matches on.
 *
 * PURE — payload in, facts out, no GitHub call and no DB read. That is what
 * makes the whole trigger taxonomy testable against verbatim GitHub bodies
 * (the `terminalOutcomeFromPayload` / `parseCheckRunPayload` precedent), and it
 * is what lets a workflow act on a PR Talyn has never tracked: there is no row
 * to be missing.
 *
 * Returns an ARRAY because one delivery can be several PRs: a `check_suite`
 * references every PR whose head is that commit.
 *
 * Returns `[]` — never throws — for anything that is not a PR lifecycle event
 * a workflow can trigger on: a `push`, an `issue_comment` on a plain issue, a
 * `pull_request` action Talyn has no trigger for (`auto_merge_enabled`), a
 * `check_suite` that is still running. An unmapped action must be inert, not an
 * exception on the webhook worker's hot path.
 */

interface RawUser {
  login?: unknown;
  type?: unknown;
}

function actorOf(raw: unknown): { login: string; isBot: boolean } | undefined {
  const u = raw as RawUser | undefined;
  const login = typeof u?.login === 'string' ? u.login : '';
  if (!login) return undefined;
  const type = typeof u?.type === 'string' ? u.type : null;
  return { login, isBot: loginLooksLikeBot(login, type) };
}

const NOBODY = { login: '', isBot: false } as const;

function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => (l as { name?: unknown } | null)?.name)
    .filter((n): n is string => typeof n === 'string');
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * The repository's default branch.
 *
 * GitHub puts a full `repository` object on every repo-scoped delivery, so this
 * is available for all of them — including `issue_comment` and `check_suite`,
 * whose own nodes say nothing about branches. Blank when absent, and the caller
 * lists `defaultBranch` as unknown so a condition on it fails rather than
 * guessing "main" for a repo that uses "master".
 */
function defaultBranchOf(payload: Record<string, unknown>): string {
  const repo = payload.repository as { default_branch?: unknown } | undefined;
  return str(repo?.default_branch);
}

/**
 * The `pull_request` action → trigger mapping, minus `closed` (which splits on
 * whether it merged) and the review-request actions GitHub spells with
 * underscores. Anything absent is deliberately inert.
 */
const PR_ACTION_EVENTS: Record<string, WorkflowTriggerEvent> = {
  opened: 'pr_opened',
  reopened: 'pr_reopened',
  edited: 'pr_edited',
  synchronize: 'pr_synchronized',
  ready_for_review: 'pr_ready_for_review',
  converted_to_draft: 'pr_converted_to_draft',
  labeled: 'pr_labeled',
  unlabeled: 'pr_unlabeled',
  assigned: 'pr_assigned',
  unassigned: 'pr_unassigned',
  review_requested: 'pr_review_requested',
  review_request_removed: 'pr_review_request_removed',
};

/** Review states GitHub sends that a workflow can test. */
const REVIEW_STATES: Record<string, WorkflowReviewState> = {
  approved: 'approved',
  changes_requested: 'changes_requested',
  commented: 'commented',
};

export function workflowFactsFromDelivery(delivery: WebhookDelivery): WorkflowEventFacts[] {
  const { eventType, action, payload, repoFullName } = delivery;
  if (!repoFullName) return [];

  switch (eventType) {
    case 'pull_request':
      return fromPullRequest(delivery);
    case 'pull_request_review':
      return fromReview(delivery);
    case 'pull_request_review_comment':
      return fromReviewComment(delivery);
    case 'issue_comment':
      return fromIssueComment(delivery);
    case 'check_suite':
      return fromCheckSuite(delivery);
    default:
      // `check_run` is deliberately absent: a CI suite fires dozens per commit
      // and the per-run conclusion is not "the checks finished". `check_suite`
      // completed is that moment, once. See fromCheckSuite.
      void action;
      void payload;
      return [];
  }
}

/**
 * The full-fidelity case. A `pull_request` payload carries the whole PR, so
 * nothing is unknown.
 */
function fromPullRequest(delivery: WebhookDelivery): WorkflowEventFacts[] {
  const { action, payload, repoFullName } = delivery;
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  if (!pr || typeof pr.number !== 'number') return [];

  let event: WorkflowTriggerEvent | undefined;
  if (action === 'closed') {
    // GitHub sends ONE `closed` for both outcomes, and "abandoned" vs "shipped"
    // are opposite intentions. Reuse the worker's own reader so the
    // merged/merged_at precedence has one definition.
    const outcome = terminalOutcomeFromPayload(action, payload);
    event = outcome?.merged ? 'pr_merged' : 'pr_closed';
  } else if (action) {
    event = PR_ACTION_EVENTS[action];
  }
  if (!event) return [];

  const base = pr.base as { ref?: unknown } | undefined;
  const head = pr.head as { ref?: unknown } | undefined;
  const author = actorOf(pr.user) ?? NOBODY;

  const facts: WorkflowEventFacts = {
    event,
    repoFullName,
    number: pr.number,
    title: str(pr.title),
    url: str(pr.html_url),
    author,
    // `sender` is who did the thing; on `opened` it is the author, but on
    // `labeled` it is whoever added the label — which is exactly the difference
    // the self-echo guard and the `actor` condition are about.
    actor: actorOf(payload.sender) ?? author,
    baseBranch: str(base?.ref),
    defaultBranch: defaultBranchOf(payload),
    headBranch: str(head?.ref),
    draft: pr.draft === true,
    labels: labelNames(pr.labels),
  };

  if (event === 'pr_labeled' || event === 'pr_unlabeled') {
    const name = str((payload.label as { name?: unknown } | undefined)?.name);
    if (name) facts.labelName = name;
  }

  if (
    event === 'pr_review_requested' ||
    event === 'pr_review_request_removed' ||
    event === 'pr_assigned' ||
    event === 'pr_unassigned'
  ) {
    // A team review request carries `requested_team` and no user at all. The
    // team becomes the target, with its slug in `teamSlugs`, so a rule can say
    // "a review was requested from the frontend team".
    //
    // What it deliberately does NOT do is resolve the team's MEMBERS: a
    // `viewer` or per-login target still fails on a team request, because
    // answering otherwise needs a membership lookup per delivery — a GitHub call
    // on the webhook hot path, against the account's shared budget, for every
    // team request in every watched repo.
    const team = payload.requested_team as { slug?: unknown; name?: unknown } | undefined;
    const teamSlug = typeof team?.slug === 'string' ? team.slug : '';
    const target =
      actorOf(payload.requested_reviewer) ??
      actorOf(payload.assignee) ??
      (teamSlug ? { login: teamSlug, isBot: false, teamSlugs: [teamSlug] } : undefined);
    if (target) facts.target = target;
  }

  return [facts];
}

/** `pull_request_review` — submitted / dismissed. `edited` is inert. */
function fromReview(delivery: WebhookDelivery): WorkflowEventFacts[] {
  const { action, payload, repoFullName } = delivery;
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const review = payload.review as Record<string, unknown> | undefined;
  if (!pr || typeof pr.number !== 'number' || !review) return [];

  let event: WorkflowTriggerEvent | undefined;
  if (action === 'submitted') event = 'pr_review_submitted';
  else if (action === 'dismissed') event = 'pr_review_dismissed';
  if (!event) return [];

  const base = pr.base as { ref?: unknown } | undefined;
  const head = pr.head as { ref?: unknown } | undefined;
  const author = actorOf(pr.user) ?? NOBODY;
  const reviewer = actorOf(review.user);

  const facts: WorkflowEventFacts = {
    event,
    repoFullName,
    number: pr.number,
    title: str(pr.title),
    url: str(pr.html_url),
    author,
    // The REVIEWER, not the sender. On `dismissed` the sender is whoever
    // dismissed it and the review's user is who wrote it; a rule that says
    // "changes requested by a human" means the person who requested them.
    actor: reviewer ?? actorOf(payload.sender) ?? author,
    baseBranch: str(base?.ref),
    defaultBranch: defaultBranchOf(payload),
    headBranch: str(head?.ref),
    draft: pr.draft === true,
    labels: labelNames(pr.labels),
    body: str(review.body),
  };

  const state = str(review.state).toLowerCase();
  const mapped = REVIEW_STATES[state];
  if (mapped) facts.reviewState = mapped;

  return [facts];
}

/** `pull_request_review_comment` — an inline comment on the diff. */
function fromReviewComment(delivery: WebhookDelivery): WorkflowEventFacts[] {
  const { action, payload, repoFullName } = delivery;
  if (action !== 'created') return [];
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const comment = payload.comment as Record<string, unknown> | undefined;
  if (!pr || typeof pr.number !== 'number' || !comment) return [];

  const base = pr.base as { ref?: unknown } | undefined;
  const head = pr.head as { ref?: unknown } | undefined;
  const author = actorOf(pr.user) ?? NOBODY;

  return [
    {
      event: 'pr_review_comment',
      repoFullName,
      number: pr.number,
      title: str(pr.title),
      url: str(pr.html_url),
      author,
      actor: actorOf(comment.user) ?? actorOf(payload.sender) ?? author,
      baseBranch: str(base?.ref),
      defaultBranch: defaultBranchOf(payload),
      headBranch: str(head?.ref),
      draft: pr.draft === true,
      labels: labelNames(pr.labels),
      body: str(comment.body),
    },
  ];
}

/**
 * `issue_comment` — a comment on the PR conversation.
 *
 * The payload describes an ISSUE. It carries the number, title, author, labels
 * and URL, but there is no base branch, no head branch and no draft flag on an
 * issue. Those are declared unknown rather than defaulted, so a rule that tests
 * them fails instead of matching everything; the engine enriches them from the
 * tracked PR row when it can.
 */
function fromIssueComment(delivery: WebhookDelivery): WorkflowEventFacts[] {
  const { action, payload, repoFullName } = delivery;
  if (action !== 'created') return [];
  const issue = payload.issue as Record<string, unknown> | undefined;
  const comment = payload.comment as Record<string, unknown> | undefined;
  // Not a PR — a plain issue. The worker draws the same line.
  if (!issue?.pull_request || typeof issue.number !== 'number' || !comment) return [];

  const author = actorOf(issue.user) ?? NOBODY;
  const unknownFields: WorkflowFactField[] = ['baseBranch', 'headBranch', 'draft'];

  return [
    {
      event: 'pr_comment',
      repoFullName,
      number: issue.number,
      title: str(issue.title),
      url: str(issue.html_url),
      author,
      actor: actorOf(comment.user) ?? actorOf(payload.sender) ?? author,
      baseBranch: '',
      defaultBranch: defaultBranchOf(payload),
      headBranch: '',
      draft: false,
      labels: labelNames(issue.labels),
      body: str(comment.body),
      unknownFields,
    },
  ];
}

/**
 * `check_suite completed` — "the checks finished", once per suite.
 *
 * Deliberately this and not `check_run`: a CI suite fires dozens of check_runs
 * per commit, and a single run's conclusion is not the PR's verdict. A suite is
 * still not the whole story on a repo with several CI providers — each provider
 * has its own suite — so `checkConclusions: ['failure']` means "a suite
 * failed", which is the honest reading of what the payload says.
 *
 * The embedded PRs are `{number, base, head}` and nothing else, so almost
 * everything is unknown here. That costs little in practice: this event only
 * reaches the worker for PRs Talyn already tracks (the receiver drops a suite
 * whose head_sha is not a tracked head), so the engine's enrichment nearly
 * always succeeds.
 */
function fromCheckSuite(delivery: WebhookDelivery): WorkflowEventFacts[] {
  const { action, payload, repoFullName } = delivery;
  if (action !== 'completed') return [];
  const suite = payload.check_suite as Record<string, unknown> | undefined;
  if (!suite) return [];

  const conclusion = str(suite.conclusion).toLowerCase();
  // Only the two outcomes a user can act on. `neutral`, `skipped`, `cancelled`,
  // `stale` and `action_required` are not "passed" or "failed", and guessing
  // which side they fall on is how a rule ends up merging on a cancelled suite.
  let mapped: WorkflowCheckConclusion | undefined;
  if (conclusion === 'success') mapped = 'success';
  else if (conclusion === 'failure' || conclusion === 'timed_out') mapped = 'failure';
  if (!mapped) return [];

  const prs = Array.isArray(suite.pull_requests) ? suite.pull_requests : [];
  const out: WorkflowEventFacts[] = [];
  for (const raw of prs) {
    const pr = raw as Record<string, unknown> | null;
    if (!pr || typeof pr.number !== 'number') continue;
    const base = pr.base as { ref?: unknown } | undefined;
    const head = pr.head as { ref?: unknown } | undefined;
    out.push({
      event: 'pr_checks_completed',
      repoFullName,
      number: pr.number,
      title: '',
      url: '',
      // Nobody performed this — CI did. `actor` is empty rather than the App
      // that owns the suite, so an `actor: bot` rule does not accidentally
      // become "on every CI completion".
      author: NOBODY,
      actor: NOBODY,
      baseBranch: str(base?.ref),
      defaultBranch: defaultBranchOf(payload),
      headBranch: str(head?.ref),
      draft: false,
      labels: [],
      checkConclusion: mapped,
      unknownFields: ['title', 'url', 'author', 'draft', 'labels'],
    });
  }
  return out;
}
