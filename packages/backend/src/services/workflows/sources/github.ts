import { and, eq, sql } from 'drizzle-orm';
import type {
  GithubEventFacts,
  GithubWorkflowEvent,
  WorkflowCheckConclusion,
  WorkflowDefinition,
  WorkflowFactField,
  WorkflowReviewState,
} from '@talyn/shared';
import { loginLooksLikeBot } from '@talyn/shared';
import { getDbClient } from '../../../db/client.js';
import {
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
} from '../../../db/schema.js';
import { debugBus } from '../../debugBus.js';
import { githubService } from '../../github.js';
import { githubRateGate } from '../../githubRateGate.js';
import { classifyAutoMergeActor } from '../../githubAutoMerge.js';
import type { WatchTarget } from '../../webhookIndex.js';
import { terminalOutcomeFromPayload, type WebhookDelivery } from '../../webhookPayload.js';
import type { WorkflowSourceAdapter } from '../source.js';

/**
 * The GitHub source adapter: webhook deliveries in, PR facts out.
 *
 * Holds everything about workflows that is specific to GitHub: the
 * `(eventType, action)` → event mapping, the enrichment from the tracked PR
 * row, the self-echo guard and the watched-repository targets. The engine core
 * in `../engine.ts` does the rest.
 */

/** One delivery and the workspaces that watch its repository. */
export interface GithubWorkflowInput {
  delivery: WebhookDelivery;
  targets: WatchTarget[];
}

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
const PR_ACTION_EVENTS: Record<string, GithubWorkflowEvent> = {
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

export function workflowFactsFromDelivery(delivery: WebhookDelivery): GithubEventFacts[] {
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
    case CHECKS_GREEN_EVENT:
      return fromChecksGreen(delivery);
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
function fromPullRequest(delivery: WebhookDelivery): GithubEventFacts[] {
  const { action, payload, repoFullName } = delivery;
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  if (!pr || typeof pr.number !== 'number') return [];

  let event: GithubWorkflowEvent | undefined;
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

  const facts: GithubEventFacts = {
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
function fromReview(delivery: WebhookDelivery): GithubEventFacts[] {
  const { action, payload, repoFullName } = delivery;
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const review = payload.review as Record<string, unknown> | undefined;
  if (!pr || typeof pr.number !== 'number' || !review) return [];

  let event: GithubWorkflowEvent | undefined;
  if (action === 'submitted') event = 'pr_review_submitted';
  else if (action === 'dismissed') event = 'pr_review_dismissed';
  if (!event) return [];

  const base = pr.base as { ref?: unknown } | undefined;
  const head = pr.head as { ref?: unknown } | undefined;
  const author = actorOf(pr.user) ?? NOBODY;
  const reviewer = actorOf(review.user);

  const facts: GithubEventFacts = {
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
function fromReviewComment(delivery: WebhookDelivery): GithubEventFacts[] {
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
function fromIssueComment(delivery: WebhookDelivery): GithubEventFacts[] {
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
function fromCheckSuite(delivery: WebhookDelivery): GithubEventFacts[] {
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
  const out: GithubEventFacts[] = [];
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


/**
 * The synthetic event type for "every check on this PR is now green".
 *
 * Namespaced so it can never collide with a GitHub event name. There is no
 * such webhook: GitHub tells you a *suite* finished, and on a repo with
 * several CI providers that is one suite of several. The only place the whole
 * picture exists is Talyn's own recomputed check counts, so the trigger is
 * raised from there — see services/workflows/checksGreen.ts.
 */
export const CHECKS_GREEN_EVENT = 'talyn:checks_green';

/**
 * `pr_checks_passed` — the PR's whole check set is green, once per commit.
 *
 * Stays PURE like every other handler here: the caller has already done the
 * database work and packed the answer into the payload, so this only reads
 * what it was given. That is what keeps this module unit-testable without a
 * database.
 *
 * Almost everything about the PR is unknown, exactly as for a check suite —
 * the emitter knows the number and nothing else about the pull request — and
 * the engine's enrichment fills it from the tracked row before matching.
 */
function fromChecksGreen(delivery: WebhookDelivery): GithubEventFacts[] {
  const { payload, repoFullName } = delivery;
  const prs = Array.isArray(payload.prs) ? payload.prs : [];

  return prs.flatMap((raw): GithubEventFacts[] => {
    const pr = raw as { number?: unknown };
    if (typeof pr.number !== 'number') return [];
    return [
      {
        event: 'pr_checks_passed',
        repoFullName,
        number: pr.number,
        title: '',
        url: '',
        // CI did this, not a person. Empty rather than the App that owns the
        // suite, so an `actor: bot` rule does not quietly become "on every
        // green build" — the same reasoning as fromCheckSuite.
        author: NOBODY,
        actor: NOBODY,
        baseBranch: '',
        defaultBranch: str((payload.repository as { default_branch?: unknown } | undefined)?.default_branch),
        headBranch: '',
        draft: false,
        labels: [],
        unknownFields: [
          'title',
          'url',
          'author',
          'baseBranch',
          'headBranch',
          'draft',
          'labels',
        ],
      },
    ];
  });
}

// ---- Self-echo ------------------------------------------------------------

/**
 * Events one of Talyn's own actions can produce, and which could therefore feed
 * back into a workflow that triggers on them.
 *
 * This set is the loop guard's whole scope, and what it EXCLUDES is the point:
 * `pr_merged` is not here, even though Talyn's merge queue merges PRs, because
 * "comment when it merges" is a rule people actually want and a merge cannot
 * re-trigger a merge — the PR is closed. Only the genuinely self-feeding
 * actions are suppressed.
 */
const SELF_ECHO_EVENTS: ReadonlySet<GithubWorkflowEvent> = new Set([
  'pr_labeled',
  'pr_unlabeled',
  'pr_assigned',
  'pr_unassigned',
  'pr_review_requested',
  'pr_review_request_removed',
  'pr_comment',
  'pr_review_submitted',
  'pr_ready_for_review',
]);

/**
 * Whether this delivery is Talyn hearing its own action back.
 *
 * An `add_labels` action produces a `pull_request/labeled` delivery, which is
 * itself a trigger event — a workflow on `pr_labeled` that adds a label would
 * loop until GitHub's rate limit stopped it. This is the direct fix, and it is
 * the same shape as the `event.type !== 'debug:event'` guard in `websocket.ts`.
 *
 * Scoped to the App bot only, never the connected user: a person labelling their
 * own PR is a completely legitimate trigger, and suppressing it would break the
 * most obvious rule anybody writes.
 */
export function isSelfEcho(facts: GithubEventFacts): boolean {
  if (!SELF_ECHO_EVENTS.has(facts.event)) return false;
  return classifyAutoMergeActor(facts.actor.login) === 'talyn';
}

// ---- Enrichment -----------------------------------------------------------

/** Whether any workflow in the list constrains a fact this payload lacks. */
function needsEnrichment(workflows: WorkflowDefinition[], facts: GithubEventFacts): boolean {
  const missing = facts.unknownFields;
  if (!missing || missing.length === 0) return false;
  const wants = (f: WorkflowFactField): boolean => {
    if (!missing.includes(f)) return false;
    return workflows.some((w) => {
      const c = w.conditions;
      switch (f) {
        case 'baseBranch':
          return (c.baseBranches?.length ?? 0) > 0 || c.baseIsDefault !== undefined;
        case 'defaultBranch':
          return c.baseIsDefault !== undefined;
        case 'title':
          return !!c.titleContains;
        case 'draft':
          return c.draft !== undefined;
        case 'labels':
          return (
            (c.labelsAny?.length ?? 0) > 0 ||
            (c.labelsAll?.length ?? 0) > 0 ||
            (c.labelsNone?.length ?? 0) > 0
          );
        case 'author':
          return !!c.author && c.author.kind !== 'any';
        default:
          return false;
      }
    });
  };
  return (
    ['baseBranch', 'defaultBranch', 'title', 'draft', 'labels', 'author'] as WorkflowFactField[]
  ).some(wants);
}

/**
 * Fill in what the payload could not say, from the tracked PR row.
 *
 * Projected out of the `last_summary` jsonb with SQL expressions rather than by
 * selecting the blob: this runs on the webhook worker's path and the summary
 * carries the whole check breakdown, the stack and the unresolved-thread
 * counts, none of which a workflow condition reads. (DB egress rules — the same
 * reasoning as `prMonitor.fastPollWorkspace`.)
 *
 * Returns the facts unchanged when there is no row: honest, and the matcher then
 * fails any condition on a still-unknown fact rather than guessing.
 *
 * The query is exported so a test can assert on its SQL: every mention of
 * `last_summary` must be an accessor (`->`/`->>`), never the bare column. That
 * assertion is the regression guard — the projection is easy to "simplify" into
 * a plain select, and the cost would only show up as a bill.
 */
export function enrichmentQuery(target: WatchTarget, number: number) {
  return getDbClient()
    .select({
      title: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'title'`,
      author: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'author'`,
      baseBranch: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'baseBranch'`,
      headBranch: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'headBranch'`,
      url: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'url'`,
      // Not from the summary: the repository row is where the default branch
      // lives, and it is the cheaper read of the two.
      defaultBranch: repositoriesTable.defaultBranch,
      draft: sql<boolean | null>`(${pullRequestsTable.lastSummary} ->> 'draft')::boolean`,
      labels: sql<string[] | null>`${pullRequestsTable.lastSummary} -> 'labels'`,
    })
    .from(pullRequestsTable)
    .innerJoin(repositoriesTable, eq(repositoriesTable.id, pullRequestsTable.repositoryId))
    .where(
      and(
        eq(pullRequestsTable.workspaceId, target.workspaceId),
        eq(pullRequestsTable.repositoryId, target.repositoryId),
        eq(pullRequestsTable.number, number)
      )
    )
    .limit(1);
}

async function enrich(facts: GithubEventFacts, target: WatchTarget): Promise<GithubEventFacts> {
  const rows = await enrichmentQuery(target, facts.number);
  const row = rows[0];
  if (!row) return facts;

  const filled = new Set(facts.unknownFields ?? []);
  const next: GithubEventFacts = { ...facts };

  const take = (field: WorkflowFactField, apply: () => boolean): void => {
    if (!filled.has(field)) return;
    if (apply()) filled.delete(field);
  };

  take('title', () => {
    if (!row.title) return false;
    next.title = row.title;
    return true;
  });
  take('url', () => {
    if (!row.url) return false;
    next.url = row.url;
    return true;
  });
  take('author', () => {
    if (!row.author) return false;
    // The summary stores a login, not a user object, so bot-ness has to be read
    // off the login shape alone. That is exactly what `[bot]` suffixes are for.
    next.author = { login: row.author, isBot: row.author.toLowerCase().endsWith('[bot]') };
    return true;
  });
  take('baseBranch', () => {
    if (!row.baseBranch) return false;
    next.baseBranch = row.baseBranch;
    return true;
  });
  take('defaultBranch', () => {
    if (!row.defaultBranch) return false;
    next.defaultBranch = row.defaultBranch;
    return true;
  });
  take('headBranch', () => {
    if (!row.headBranch) return false;
    next.headBranch = row.headBranch;
    return true;
  });
  take('draft', () => {
    if (row.draft === null || row.draft === undefined) return false;
    next.draft = row.draft;
    return true;
  });
  take('labels', () => {
    if (!Array.isArray(row.labels)) return false;
    next.labels = row.labels.filter((l): l is string => typeof l === 'string');
    return true;
  });

  next.unknownFields = [...filled];
  return next;
}

// ---- The adapter ----------------------------------------------------------

export const githubWorkflowSource: WorkflowSourceAdapter<
  GithubWorkflowInput,
  WatchTarget,
  GithubEventFacts
> = {
  integration: 'github',

  facts: (input) => workflowFactsFromDelivery(input.delivery),

  deliveryId: (input) => input.delivery.deliveryId,

  // The webhook worker has already resolved which workspaces watch this
  // repository; the engine takes its word for it.
  targets: async (input) => input.targets,

  async prepare(target, factsList, workflows) {
    // Any `viewer` actor match needs to know who "I" am — on the author, the
    // actor, or the person the event named. Only resolved when a workflow
    // actually asks. Cached inside githubService, so a repeat costs nothing.
    const needsViewer = workflows.some((w) =>
      [w.conditions.author, w.conditions.actor, w.conditions.target].some(
        (m) => m?.kind === 'viewer'
      )
    );
    const viewerLogin = needsViewer
      ? await githubService.getViewerLogin(target.workspaceId).catch(() => null)
      : null;

    const out: GithubEventFacts[] = [];
    for (const raw of factsList) {
      if (isSelfEcho(raw)) {
        debugBus.recordEvent({
          service: 'workflows',
          action: 'self-echo',
          summary: `${raw.repoFullName}#${raw.number} ${raw.event} was Talyn's own action — skipped`,
          workspaceId: target.workspaceId,
        });
        continue;
      }
      out.push(
        needsEnrichment(workflows, raw) ? await enrich(raw, target).catch(() => raw) : raw
      );
    }
    return { facts: out, viewerLogin };
  },

  actionContext: (target, facts, base) => ({
    ...base,
    integration: 'github',
    repositoryId: target.repositoryId,
    owner: target.owner,
    repo: target.repo,
    facts,
  }),

  blockedUntilMs: (target) =>
    githubRateGate.blockedUntil(githubService.accountKeyFor(target.workspaceId), 'rest'),

  describe: ({ delivery }) =>
    `${delivery.eventType}/${delivery.action ?? '-'} ${delivery.repoFullName}`,
};
