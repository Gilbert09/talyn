// Workflows — the user's own automations over PR lifecycle events.
//
// A workflow is a named, workspace-scoped rule of the shape "on these events,
// matching these conditions, do these actions". It is evaluated on the GitHub
// webhook PAYLOAD, not on a `pull_requests` row, which is what lets it fire on
// every PR in a watched repo — including PRs Talyn does not track and PRs
// somebody else opened. That is also the only reading under which the
// human/bot author test and the `watch_pr` action mean anything: both are
// about PRs that are NOT already on your list.
//
// The matcher and the validator live here, not in either front end. The
// desktop and the web app are deliberate forks of each other, and two copies
// of the predicate would let the same workflow claim different matches on each
// client — the same argument prFilters.ts makes, with higher stakes, because a
// workflow does not just filter a list, it comments and merges.
//
// Conditions within a workflow AND together. There is no OR: a rule that needs
// one is two rules, and two rules are legible in a list where a boolean tree
// is not.

import type { SkillKey } from './skills.js';

// ============================================================================
// Triggers
// ============================================================================

/**
 * The PR lifecycle events a workflow can trigger on.
 *
 * Every one of these is derived from a webhook delivery Talyn already
 * receives; see `services/workflows/facts.ts` for the
 * `(eventType, action)` → event mapping.
 *
 * `pr_closed` and `pr_merged` are deliberately separate. GitHub sends one
 * `pull_request/closed` for both, and "when a PR is abandoned" and "when a PR
 * ships" are opposite intentions — collapsing them would make the common rule
 * ("comment when it merges") fire on the case the user least wants.
 */
export const WORKFLOW_TRIGGER_EVENTS = [
  'pr_opened',
  'pr_reopened',
  'pr_closed',
  'pr_merged',
  'pr_edited',
  'pr_synchronized',
  'pr_ready_for_review',
  'pr_converted_to_draft',
  'pr_labeled',
  'pr_unlabeled',
  'pr_assigned',
  'pr_unassigned',
  'pr_review_requested',
  'pr_review_request_removed',
  'pr_review_submitted',
  'pr_review_dismissed',
  'pr_review_comment',
  'pr_comment',
  'pr_checks_completed',
] as const;

export type WorkflowTriggerEvent = (typeof WORKFLOW_TRIGGER_EVENTS)[number];

/**
 * Display strings for the trigger list, so the two editors cannot disagree
 * about what `pr_synchronized` is called.
 */
export const WORKFLOW_EVENT_LABELS: Record<WorkflowTriggerEvent, string> = {
  pr_opened: 'PR opened',
  pr_reopened: 'PR reopened',
  pr_closed: 'PR closed without merging',
  pr_merged: 'PR merged',
  pr_edited: 'PR title, body or base changed',
  pr_synchronized: 'New commits pushed',
  pr_ready_for_review: 'Marked ready for review',
  pr_converted_to_draft: 'Converted to draft',
  pr_labeled: 'Label added',
  pr_unlabeled: 'Label removed',
  pr_assigned: 'Someone assigned',
  pr_unassigned: 'Someone unassigned',
  pr_review_requested: 'Review requested',
  pr_review_request_removed: 'Review request removed',
  pr_review_submitted: 'Review submitted',
  pr_review_dismissed: 'Review dismissed',
  pr_review_comment: 'Comment on the diff',
  pr_comment: 'Comment on the PR',
  pr_checks_completed: 'Checks finished',
};

/**
 * Events that only fire on PRs Talyn ALREADY tracks.
 *
 * The webhook receiver drops a `check_run`/`check_suite` whose `head_sha` is
 * not a tracked open PR head (`shouldDropByHeadSha`) — that filter is what
 * keeps the check firehose affordable, and widening it for workflows would
 * multiply the busiest event class we receive. Everything else in the taxonomy
 * arrives for every PR in a watched repo.
 *
 * Exported so the editors can SAY so on the option, rather than letting a rule
 * look armed and never fire.
 */
export const WORKFLOW_EVENTS_REQUIRING_TRACKED_PR: readonly WorkflowTriggerEvent[] = [
  'pr_checks_completed',
];

/** Events that carry a review, so `reviewStates` means something. */
const REVIEW_STATE_EVENTS: readonly WorkflowTriggerEvent[] = ['pr_review_submitted'];
/** Events that carry the one label that changed. */
const LABEL_NAME_EVENTS: readonly WorkflowTriggerEvent[] = ['pr_labeled', 'pr_unlabeled'];
/** Events that name a person other than the actor, so "…and it's me" applies. */
const TARGET_EVENTS: readonly WorkflowTriggerEvent[] = [
  'pr_review_requested',
  'pr_review_request_removed',
  'pr_assigned',
  'pr_unassigned',
];
/** Events that carry prose a workflow can match on. */
const BODY_EVENTS: readonly WorkflowTriggerEvent[] = [
  'pr_comment',
  'pr_review_comment',
  'pr_review_submitted',
];
/** Events that carry a check conclusion. */
const CHECK_EVENTS: readonly WorkflowTriggerEvent[] = ['pr_checks_completed'];

// ============================================================================
// Conditions
// ============================================================================

/**
 * How a workflow identifies a person: by exact login, or by class.
 *
 * The class test is the thing a login list cannot express — "any bot" has to
 * keep working when a repo installs a bot nobody has heard of yet, and "any
 * human" has to keep working when Dependabot is joined by Renovate. That is
 * the whole reason this is a discriminated union rather than a string array
 * with magic values in it.
 */
export type WorkflowActorMatch =
  | { kind: 'any' }
  /** The workspace's own connected GitHub user — "me". */
  | { kind: 'viewer' }
  | { kind: 'human' }
  | { kind: 'bot' }
  | { kind: 'logins'; logins: string[]; teams?: string[] };

export const WORKFLOW_ACTOR_KINDS = ['any', 'viewer', 'human', 'bot', 'logins'] as const;

/** How each actor kind reads in a picker. */
export const WORKFLOW_ACTOR_KIND_LABELS: Record<
  (typeof WORKFLOW_ACTOR_KINDS)[number],
  string
> = {
  any: 'Anyone',
  viewer: 'Me',
  human: 'Any person',
  bot: 'Any bot',
  logins: 'Specific accounts',
};

export type WorkflowReviewState = 'approved' | 'changes_requested' | 'commented';
export type WorkflowCheckConclusion = 'success' | 'failure';

/**
 * What a workflow tests beyond the event itself. Every field is optional and
 * an absent field places no constraint — a workflow with no conditions is
 * legal and means "every PR in this workspace's watched repos".
 *
 * That is deliberately different from a saved PR filter, which is refused when
 * empty: an empty filter is a view that filters nothing (useless), whereas an
 * empty workflow condition set is "on every PR" (exactly what "label every new
 * PR" wants).
 */
export interface WorkflowConditions {
  /**
   * Repositories, as `owner/repo` full names. Matches if the PR is in ANY of
   * them. Full names rather than repository row ids, because a row id is
   * re-minted when a repo is removed from the workspace and re-added — the
   * same reason `PRFilterCriteria.repos` stores full names.
   */
  repos?: string[];
  /** Base branches the PR must target. Matches ANY. */
  baseBranches?: string[];
  /**
   * Whether the PR targets the repository's DEFAULT branch.
   *
   * `false` is the interesting one: a PR whose base is not `main` is, in
   * practice, a PR stacked on another PR — which is the population worth
   * treating differently, because the usual rules (queue it, ask for a review,
   * label it ready) mostly apply to the bottom of a stack rather than the middle.
   *
   * Separate from {@link baseBranches} rather than a magic value inside it,
   * because the two answer different questions and compose: "not the default
   * branch, and not one of these long-lived release branches either".
   */
  baseIsDefault?: boolean;
  /** Case-insensitive substring of the PR title. */
  titleContains?: string;
  /** `true` = drafts only, `false` = non-drafts only, absent = either. */
  draft?: boolean;
  /** The PR must carry at least one of these labels. */
  labelsAny?: string[];
  /** The PR must carry all of these labels. */
  labelsAll?: string[];
  /** Carrying any one of these fails the workflow. */
  labelsNone?: string[];
  /** Who opened the PR. */
  author?: WorkflowActorMatch;
  /** Who performed THIS event (the commenter, the reviewer, the labeller). */
  actor?: WorkflowActorMatch;
  /** `pr_review_submitted` only: which verdicts count. */
  reviewStates?: WorkflowReviewState[];
  /** `pr_labeled` / `pr_unlabeled` only: the label that changed. */
  labelName?: string;
  /**
   * `pr_review_requested` / `pr_assigned` (and their removals) only: WHO the
   * event names — the reviewer who was asked, or the person assigned.
   *
   * A full actor match rather than the boolean "is it me?" this started as,
   * because "is it me" is only the most common question, not the only one: a
   * team's workflow wants "a review was requested from anyone on the frontend
   * team", and a triage workflow wants "Dependabot was assigned". `kind:
   * 'viewer'` is how "me" is expressed now.
   */
  target?: WorkflowActorMatch;
  /** `pr_checks_completed` only. */
  checkConclusions?: WorkflowCheckConclusion[];
  /** Case-insensitive substring of the comment / review body. */
  bodyContains?: string;
}

// ============================================================================
// Actions
// ============================================================================

export const WORKFLOW_ACTION_TYPES = [
  'add_labels',
  'remove_labels',
  'request_reviewers',
  'assign',
  'comment',
  'run_skill',
  'run_prompt',
  'watch_pr',
  'enqueue_merge_queue',
] as const;

export type WorkflowActionType = (typeof WORKFLOW_ACTION_TYPES)[number];

export type WorkflowMergeMethod = 'squash' | 'merge' | 'rebase';

/**
 * What a workflow does when it matches.
 *
 * Note what is NOT here: a direct "merge now". Talyn's merge queue already
 * handles everything a raw merge gets wrong — a base branch governed by an
 * external merge system (posthog/posthog's `master`, where our merge 405s),
 * trunk submission, commit signing, stacks, and GitHub auto-merge arming — and
 * it counts against the plan's merge-queue allowance. `enqueue_merge_queue` is
 * the merge action.
 */
export type WorkflowAction =
  | { type: 'add_labels'; labels: string[] }
  | { type: 'remove_labels'; labels: string[] }
  | { type: 'request_reviewers'; users?: string[]; teams?: string[] }
  | { type: 'assign'; users: string[] }
  | { type: 'comment'; body: string }
  | { type: 'run_skill'; skillKey: SkillKey; model?: string }
  | { type: 'run_prompt'; prompt: string; model?: string }
  | { type: 'watch_pr' }
  | { type: 'enqueue_merge_queue'; method?: WorkflowMergeMethod };

export const WORKFLOW_ACTION_LABELS: Record<WorkflowActionType, string> = {
  add_labels: 'Add labels',
  remove_labels: 'Remove labels',
  request_reviewers: 'Request reviewers',
  assign: 'Assign people',
  comment: 'Post a comment',
  run_skill: 'Run a skill',
  run_prompt: 'Run a prompt',
  watch_pr: 'Add to My PRs',
  enqueue_merge_queue: 'Add to the merge queue',
};

/** Actions that start a cloud task, and so consume a plan task slot. */
export function workflowActionStartsTask(action: WorkflowAction): boolean {
  return action.type === 'run_skill' || action.type === 'run_prompt';
}

// ============================================================================
// The definition
// ============================================================================

/**
 * How many times one workflow may run on ONE PR within an hour.
 *
 * This is a loop breaker, not a quota. An `add_labels` action produces a
 * `pull_request/labeled` delivery, which is itself a trigger event — a
 * workflow triggered on `pr_labeled` that adds a label is an infinite loop
 * bounded only by GitHub's rate limit. Self-echo suppression (the engine skips
 * a delivery whose actor is Talyn itself) is the real fix; this is the
 * backstop for the echo it cannot see, where a third party relabels in
 * response to our label.
 *
 * 5, because a real PR generates a handful of DISTINCT lifecycle events in an
 * hour, so no legitimate rule reaches it — and it makes a loop cost 5 API
 * calls instead of 5,000. Editable per workflow for the case that proves this
 * estimate wrong.
 */
export const DEFAULT_WORKFLOW_RUNS_PER_PR_PER_HOUR = 5;

export const MAX_WORKFLOW_NAME_LENGTH = 80;

/** A workflow as stored and as both front ends render it. */
export interface WorkflowDefinition {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  events: WorkflowTriggerEvent[];
  conditions: WorkflowConditions;
  actions: WorkflowAction[];
  maxRunsPerPrPerHour: number;
  createdAt: string;
  updatedAt: string;
}

/** What a create/update call sends. */
export interface WorkflowInput {
  name: string;
  enabled?: boolean;
  events: WorkflowTriggerEvent[];
  conditions?: WorkflowConditions;
  actions: WorkflowAction[];
  maxRunsPerPrPerHour?: number;
}

/** The validated, normalised core of a workflow — what the DB columns hold. */
export interface NormalizedWorkflow {
  name: string;
  enabled: boolean;
  events: WorkflowTriggerEvent[];
  conditions: WorkflowConditions;
  actions: WorkflowAction[];
  maxRunsPerPrPerHour: number;
}

// ============================================================================
// Editor suggestions
// ============================================================================

/**
 * The autocomplete options the editor offers, from `GET /workflows/suggestions`.
 *
 * Merged across every repository the workspace watches, because the editor's
 * fields are workflow-wide: a workflow can name three repositories and a label,
 * and the label has to be offered if any of them has it.
 *
 * Every list may be EMPTY and that is not an error. A picker with no suggestions
 * is still a working text field — GitHub only has to know the label, not us —
 * which is what lets the whole thing degrade rather than break when a permission
 * is missing or the account is inside a rate-limit backoff.
 */
export interface WorkflowSuggestions {
  /** `owner/repo` full names of the workspace's watched repositories. */
  repos: string[];
  labels: string[];
  branches: string[];
  /** Collaborators who can be asked to review or be assigned. */
  people: Array<{ login: string; isBot: boolean }>;
  /** Org team slugs. Usually empty — listing teams needs `members: read`. */
  teams: string[];
  /**
   * True when something could not be fetched, so the editor can say "type it in"
   * rather than implying the label does not exist.
   */
  partial: boolean;
}

// ============================================================================
// Run history + stats
// ============================================================================

/**
 * Where one run got to.
 *
 * `running` is what a claimed-but-unfinished run looks like. It is a real
 * state, not a placeholder: the run row is inserted BEFORE the actions execute
 * (that insert is the idempotency claim — see the unique index on
 * `(workflow_id, delivery_id)`), so a process that dies mid-run leaves a
 * `running` row. Showing that is better than hiding it.
 *
 * `skipped` is a run that deliberately did nothing — it hit the per-PR rate cap,
 * or a guard stood it down. It is recorded so a user can SEE the refusal, and it
 * is excluded from the run counts because it is not a time the workflow fired.
 */
export type WorkflowRunStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'skipped';

/**
 * Why one action inside a run did not happen. A machine code rather than only
 * prose, so the history UI can style a refusal (rate cap, plan limit) apart
 * from a genuine error, and so a test can assert on it.
 */
export type WorkflowActionFailureCode =
  | 'rate_capped'
  | 'task_limit_reached'
  | 'rate_gated'
  | 'no_cloud_provider'
  | 'task_already_running'
  | 'skill_unavailable'
  | 'pr_not_tracked'
  | 'not_open'
  | 'github_error'
  | 'merge_queue_limit_reached'
  | 'error';

/** One action's outcome inside one run. */
export interface WorkflowActionOutcome {
  type: WorkflowActionType;
  ok: boolean;
  /** Human-readable detail on success ("added 2 labels"). */
  detail?: string;
  code?: WorkflowActionFailureCode;
  error?: string;
}

/**
 * One evaluation of one workflow against one PR.
 *
 * The PR is DENORMALISED onto the row (`repoFullName`, `prNumber`, `prTitle`,
 * `prUrl`, `prAuthor`) rather than only referenced. A workflow fires on PRs
 * with no `pull_requests` row at all, and un-watching a PR deletes the row it
 * did have — the record of what a workflow did has to outlive both, the same
 * reasoning that makes `tasks.pull_request_id` `ON DELETE set null`.
 */
export interface WorkflowRun {
  id: string;
  workflowId: string;
  workspaceId: string;
  repositoryId: string | null;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  prAuthor: string;
  pullRequestId: string | null;
  taskId: string | null;
  event: WorkflowTriggerEvent;
  status: WorkflowRunStatus;
  actions: WorkflowActionOutcome[];
  error: string | null;
  createdAt: string;
}

/**
 * Derived counters shown next to a workflow. Aggregated on read, never stored —
 * a counter column drifts the first time a write path forgets to bump it.
 *
 * The run counts EXCLUDE `skipped` rows: a refusal is not a time the workflow
 * fired, and counting it would make a rule that is looping look busy rather
 * than stuck.
 */
export interface WorkflowStats {
  runsTotal: number;
  runs24h: number;
  runs7d: number;
  /** `failed` + `partial` in the last 7 days. */
  failures7d: number;
  tasksStarted: number;
  lastRunAt: string | null;
  lastStatus: WorkflowRunStatus | null;
}

export interface WorkflowWithStats extends WorkflowDefinition {
  stats: WorkflowStats;
}

// ============================================================================
// The matcher
// ============================================================================

/** A person — or a team — as a webhook payload describes them. */
export interface WorkflowActor {
  login: string;
  isBot: boolean;
  /**
   * Team slugs this actor stands for. Only ever set for a TEAM review request,
   * where GitHub names a team and no user at all — the slug goes here and
   * `login` carries the slug too, so a rule can say "a review was requested
   * from the frontend team".
   */
  teamSlugs?: string[];
}

/**
 * The flat facts one delivery yields, and the only thing the matcher reads.
 *
 * Derived entirely from the webhook payload — no GitHub call, no DB row — so
 * the whole taxonomy is unit-testable against verbatim GitHub bodies, and so a
 * workflow can act on a PR Talyn has never heard of.
 */
export interface WorkflowEventFacts {
  event: WorkflowTriggerEvent;
  repoFullName: string;
  number: number;
  title: string;
  url: string;
  author: WorkflowActor;
  /** Who did the thing. Falls back to the author when the payload has no sender. */
  actor: WorkflowActor;
  baseBranch: string;
  /**
   * The repository's default branch, for {@link WorkflowConditions.baseIsDefault}.
   * GitHub puts `repository.default_branch` on every repo-scoped delivery, so
   * this is nearly always known — but it is in `unknownFields` when it is not,
   * and a condition on it then fails rather than guessing "main".
   */
  defaultBranch: string;
  headBranch: string;
  draft: boolean;
  labels: string[];
  /** The person a `review_requested` / `assigned` event names. */
  target?: WorkflowActor;
  reviewState?: WorkflowReviewState;
  labelName?: string;
  body?: string;
  checkConclusion?: WorkflowCheckConclusion;
  /**
   * Fields this delivery's payload could not supply.
   *
   * Not every GitHub payload carries a full pull request. An `issue_comment`
   * describes an *issue* — it has the number, title, author and labels, but no
   * base branch, no head branch and no draft flag. A `check_suite` carries even
   * less: its embedded PRs are `{number, base, head}` and nothing else.
   *
   * Naming the gap beats defaulting it. A condition that tests a field listed
   * here FAILS rather than passing, so a rule is never silently wider than the
   * user wrote it — and the engine can enrich these from the tracked PR row
   * before matching, which clears them. Empty/absent means the payload said
   * everything.
   */
  unknownFields?: ReadonlyArray<WorkflowFactField>;
}

/** A fact a payload may not carry. See {@link WorkflowEventFacts.unknownFields}. */
export type WorkflowFactField =
  | 'title'
  | 'author'
  | 'baseBranch'
  | 'defaultBranch'
  | 'headBranch'
  | 'draft'
  | 'labels'
  | 'url';

/** Trim, drop empties, de-duplicate, lowercase — how every list is compared. */
function normalizeList(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const out: string[] = [];
  for (const v of values) {
    const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Whether a login belongs to a bot.
 *
 * Two tests, because neither is sufficient. GitHub's `user.type === 'Bot'` is
 * authoritative on webhook payloads but absent from some derived shapes, and
 * the `[bot]` login suffix is what GitHub Apps carry — a login like
 * `dependabot[bot]` is a bot whatever `type` says. Anything that looks like
 * either is treated as one; the failure mode of the reverse (a bot slipping
 * through a "humans only" rule) is the one worth avoiding, because that rule
 * exists precisely to stop responding to machines.
 */
export function loginLooksLikeBot(login: string, type?: string | null): boolean {
  if (typeof type === 'string' && type.toLowerCase() === 'bot') return true;
  const l = login.trim().toLowerCase();
  return l.endsWith('[bot]');
}

/**
 * Whether one person satisfies one actor condition.
 *
 * `viewerLogin` is the workspace's connected GitHub user. It is REQUIRED for a
 * `viewer` match and absent means unknown, which FAILS — "when I am asked to
 * review" must not widen into "when anyone is asked" because we could not work
 * out who "I" is.
 *
 * Teams are matched by the slugs the event carries on the actor, when it carries
 * any. A team review request names a team and no user, so a `logins` match that
 * lists only people cannot be satisfied by one — which is the honest answer.
 */
export function actorMatches(
  match: WorkflowActorMatch | undefined,
  actor: WorkflowActor | undefined,
  viewerLogin?: string | null
): boolean {
  if (!match || match.kind === 'any') return true;
  // A condition that names a class, a login or a team cannot be satisfied by
  // nobody. An event with no identifiable person fails it rather than passing.
  if (!actor) return false;
  const login = actor.login.trim().toLowerCase();
  switch (match.kind) {
    case 'viewer': {
      const viewer = (viewerLogin ?? '').trim().toLowerCase();
      return viewer.length > 0 && viewer === login;
    }
    case 'human':
      return !actor.isBot;
    case 'bot':
      return actor.isBot;
    case 'logins': {
      if (normalizeList(match.logins).includes(login)) return true;
      const teams = normalizeList(match.teams);
      if (teams.length === 0) return false;
      return normalizeList(actor.teamSlugs).some((slug) => teams.includes(slug));
    }
  }
}

/**
 * Whether one delivery's facts satisfy one workflow.
 *
 * Tests the event membership first, then every condition, AND-ed. A condition
 * that does not apply to this event (a `reviewStates` on a `pr_opened`) is
 * refused at validation time, so it cannot silently pass here.
 */
export function workflowMatches(
  workflow: Pick<WorkflowDefinition, 'events' | 'conditions'>,
  facts: WorkflowEventFacts,
  /**
   * The workspace's connected GitHub login, for any `viewer` actor match.
   * Absent means unknown, which FAILS the condition — "when I am asked to
   * review" must not turn into "when anyone is asked to review" because we
   * could not resolve who "I" is.
   */
  viewerLogin?: string | null
): boolean {
  if (!workflow.events.includes(facts.event)) return false;
  const c = workflow.conditions ?? {};
  // A condition on a fact the payload never carried cannot be satisfied. See
  // WorkflowEventFacts.unknownFields — the engine enriches what it can first.
  const unknown = (f: WorkflowFactField): boolean => !!facts.unknownFields?.includes(f);

  const repos = normalizeList(c.repos);
  if (repos.length > 0 && !repos.includes(facts.repoFullName.trim().toLowerCase())) return false;

  const bases = normalizeList(c.baseBranches);
  if (bases.length > 0) {
    if (unknown('baseBranch')) return false;
    if (!bases.includes(facts.baseBranch.trim().toLowerCase())) return false;
  }

  if (c.baseIsDefault !== undefined) {
    if (unknown('baseBranch') || unknown('defaultBranch')) return false;
    const base = facts.baseBranch.trim().toLowerCase();
    const def = facts.defaultBranch.trim().toLowerCase();
    // Neither can be blank: comparing '' to '' would answer "yes, it targets the
    // default branch" for a delivery that said nothing about either.
    if (!base || !def) return false;
    if ((base === def) !== c.baseIsDefault) return false;
  }

  const title = (c.titleContains ?? '').trim().toLowerCase();
  if (title) {
    if (unknown('title')) return false;
    if (!facts.title.toLowerCase().includes(title)) return false;
  }

  if (c.draft !== undefined) {
    if (unknown('draft')) return false;
    if (c.draft !== facts.draft) return false;
  }

  const none = normalizeList(c.labelsNone);
  const any = normalizeList(c.labelsAny);
  const all = normalizeList(c.labelsAll);
  if (none.length > 0 || any.length > 0 || all.length > 0) {
    if (unknown('labels')) return false;
    const have = normalizeList(facts.labels);
    if (none.some((l) => have.includes(l))) return false;
    if (any.length > 0 && !any.some((l) => have.includes(l))) return false;
    if (all.length > 0 && !all.every((l) => have.includes(l))) return false;
  }

  if (c.author && c.author.kind !== 'any' && unknown('author')) return false;
  if (!actorMatches(c.author, facts.author, viewerLogin)) return false;
  if (!actorMatches(c.actor, facts.actor, viewerLogin)) return false;
  if (!actorMatches(c.target, facts.target, viewerLogin)) return false;

  if (c.reviewStates && c.reviewStates.length > 0) {
    if (!facts.reviewState || !c.reviewStates.includes(facts.reviewState)) return false;
  }

  const labelName = (c.labelName ?? '').trim().toLowerCase();
  if (labelName) {
    if ((facts.labelName ?? '').trim().toLowerCase() !== labelName) return false;
  }

  if (c.checkConclusions && c.checkConclusions.length > 0) {
    if (!facts.checkConclusion || !c.checkConclusions.includes(facts.checkConclusion)) return false;
  }

  const body = (c.bodyContains ?? '').trim().toLowerCase();
  if (body && !(facts.body ?? '').toLowerCase().includes(body)) return false;

  return true;
}

// ============================================================================
// Comment templating
// ============================================================================

/**
 * Interpolate `{{pr.number}}`-style placeholders in a comment body.
 *
 * A deliberately tiny vocabulary — enough for a useful comment, and nothing
 * that reaches outside the facts we already hold. An unknown placeholder is
 * left VERBATIM rather than blanked: a comment that posts `{{pr.reviewer}}`
 * tells the user their template is wrong, where an empty string hides it.
 */
export function renderWorkflowComment(body: string, facts: WorkflowEventFacts): string {
  const vars: Record<string, string> = {
    'pr.number': String(facts.number),
    'pr.title': facts.title,
    'pr.url': facts.url,
    'pr.author': facts.author.login,
    'pr.baseBranch': facts.baseBranch,
    'pr.headBranch': facts.headBranch,
    'repo': facts.repoFullName,
    'actor': facts.actor.login,
    'event': WORKFLOW_EVENT_LABELS[facts.event],
  };
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) =>
    key in vars ? vars[key]! : whole
  );
}

// ============================================================================
// Validation
// ============================================================================

function fail(message: string): never {
  throw new Error(message);
}

function stringList(raw: unknown, at: string): string[] {
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
    fail(`${at} must be an array of strings`);
  }
  const cleaned = (raw as string[]).map((s) => s.trim()).filter(Boolean);
  return [...new Set(cleaned)];
}

function optionalStringList(raw: unknown, at: string): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = stringList(raw, at);
  return list.length > 0 ? list : undefined;
}

function validateActorMatch(raw: unknown, at: string): WorkflowActorMatch | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${at} must be an object`);
  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !(WORKFLOW_ACTOR_KINDS as readonly string[]).includes(kind)) {
    fail(`${at}.kind must be one of ${WORKFLOW_ACTOR_KINDS.join(', ')}`);
  }
  if (kind === 'logins') {
    const logins = optionalStringList((raw as { logins?: unknown }).logins, `${at}.logins`) ?? [];
    const teams = optionalStringList((raw as { teams?: unknown }).teams, `${at}.teams`);
    if (logins.length === 0 && !teams) {
      fail(`${at} names no accounts or teams, so it can never match`);
    }
    return { kind: 'logins', logins, ...(teams ? { teams } : {}) };
  }
  // 'any' is the absence of a constraint — drop it so the stored jsonb holds
  // only what actually constrains, and the matcher's fast path is honest.
  if (kind === 'any') return undefined;
  return { kind: kind as 'viewer' | 'human' | 'bot' };
}

/**
 * Validate + normalise one untrusted workflow. Throws with a user-facing
 * message, which the route returns verbatim in a 400 — the `validatePRFilters`
 * contract.
 *
 * Normalising here rather than only checking means what lands in the DB is
 * already trimmed and de-duplicated, so the matcher's own normalisation is a
 * no-op on anything that came through this door.
 */
export function validateWorkflow(raw: unknown): NormalizedWorkflow {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('workflow must be an object');
  const w = raw as Record<string, unknown>;

  const name = typeof w.name === 'string' ? w.name.trim() : '';
  if (!name) fail('name must be a non-empty string');
  if (name.length > MAX_WORKFLOW_NAME_LENGTH) {
    fail(`name must be ${MAX_WORKFLOW_NAME_LENGTH} characters or fewer`);
  }

  if (w.enabled !== undefined && typeof w.enabled !== 'boolean') {
    fail('enabled must be a boolean');
  }

  const events = stringList(w.events, 'events') as WorkflowTriggerEvent[];
  if (events.length === 0) fail('a workflow needs at least one trigger event');
  for (const e of events) {
    if (!(WORKFLOW_TRIGGER_EVENTS as readonly string[]).includes(e)) {
      fail(`"${e}" is not a PR event Talyn can trigger on`);
    }
  }

  const conditions = validateConditions(w.conditions, events);
  const actions = validateActions(w.actions);

  let maxRuns = DEFAULT_WORKFLOW_RUNS_PER_PR_PER_HOUR;
  if (w.maxRunsPerPrPerHour !== undefined) {
    const n = w.maxRunsPerPrPerHour;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      fail('maxRunsPerPrPerHour must be a whole number of 1 or more');
    }
    maxRuns = n;
  }

  return {
    name,
    enabled: w.enabled === undefined ? true : (w.enabled as boolean),
    events,
    conditions,
    actions,
    maxRunsPerPrPerHour: maxRuns,
  };
}

/**
 * A condition that cannot apply to any of the workflow's events is REFUSED,
 * not ignored. Storing it would leave a rule whose editor shows a constraint
 * the engine never tests — the shape of bug where a user believes a workflow
 * is narrower than it is, and finds out when it comments on the wrong PR.
 */
function validateConditions(
  raw: unknown,
  events: WorkflowTriggerEvent[]
): WorkflowConditions {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('conditions must be an object');
  const c = raw as Record<string, unknown>;

  const known = [
    'repos',
    'baseBranches',
    'baseIsDefault',
    'titleContains',
    'draft',
    'labelsAny',
    'labelsAll',
    'labelsNone',
    'author',
    'actor',
    'reviewStates',
    'labelName',
    'target',
    // Accepted, never written: workflows saved before the target became a full
    // actor match carry the boolean. Normalised below.
    'targetIsViewer',
    'checkConclusions',
    'bodyContains',
  ];
  const unknown = Object.keys(c).filter((k) => !known.includes(k));
  if (unknown.length > 0) fail(`Unknown condition "${unknown[0]}"`);

  const appliesTo = (allowed: readonly WorkflowTriggerEvent[], field: string): void => {
    if (!events.some((e) => allowed.includes(e))) {
      const names = allowed.map((e) => WORKFLOW_EVENT_LABELS[e]).join(', ');
      fail(`"${field}" only applies to ${names}, which this workflow does not trigger on`);
    }
  };

  const out: WorkflowConditions = {};
  out.repos = optionalStringList(c.repos, 'conditions.repos');
  out.baseBranches = optionalStringList(c.baseBranches, 'conditions.baseBranches');
  out.labelsAny = optionalStringList(c.labelsAny, 'conditions.labelsAny');
  out.labelsAll = optionalStringList(c.labelsAll, 'conditions.labelsAll');
  out.labelsNone = optionalStringList(c.labelsNone, 'conditions.labelsNone');

  if (c.titleContains !== undefined) {
    if (typeof c.titleContains !== 'string') fail('conditions.titleContains must be a string');
    out.titleContains = c.titleContains.trim() || undefined;
  }
  if (c.draft !== undefined) {
    if (typeof c.draft !== 'boolean') fail('conditions.draft must be a boolean');
    out.draft = c.draft;
  }
  if (c.baseIsDefault !== undefined) {
    if (typeof c.baseIsDefault !== 'boolean') fail('conditions.baseIsDefault must be a boolean');
    out.baseIsDefault = c.baseIsDefault;
  }

  out.author = validateActorMatch(c.author, 'conditions.author');
  out.actor = validateActorMatch(c.actor, 'conditions.actor');

  if (c.reviewStates !== undefined) {
    const states = stringList(c.reviewStates, 'conditions.reviewStates');
    const legal: WorkflowReviewState[] = ['approved', 'changes_requested', 'commented'];
    for (const s of states) {
      if (!legal.includes(s as WorkflowReviewState)) fail(`"${s}" is not a review state`);
    }
    if (states.length > 0) {
      appliesTo(REVIEW_STATE_EVENTS, 'reviewStates');
      out.reviewStates = states as WorkflowReviewState[];
    }
  }

  if (c.labelName !== undefined) {
    if (typeof c.labelName !== 'string') fail('conditions.labelName must be a string');
    const trimmed = c.labelName.trim();
    if (trimmed) {
      appliesTo(LABEL_NAME_EVENTS, 'labelName');
      out.labelName = trimmed;
    }
  }

  // `target` is the current shape; `targetIsViewer: true` is what workflows saved
  // before it existed carry, and it means exactly `{ kind: 'viewer' }`. Read the
  // legacy field only when the current one is absent, so a client that sends
  // both cannot have the old one win.
  const target =
    validateActorMatch(c.target, 'conditions.target') ??
    (c.targetIsViewer === true ? ({ kind: 'viewer' } as WorkflowActorMatch) : undefined);
  if (target) {
    appliesTo(TARGET_EVENTS, 'target');
    out.target = target;
  } else if (c.targetIsViewer !== undefined && typeof c.targetIsViewer !== 'boolean') {
    fail('conditions.targetIsViewer must be a boolean');
  }

  if (c.checkConclusions !== undefined) {
    const list = stringList(c.checkConclusions, 'conditions.checkConclusions');
    for (const v of list) {
      if (v !== 'success' && v !== 'failure') fail(`"${v}" is not a check conclusion`);
    }
    if (list.length > 0) {
      appliesTo(CHECK_EVENTS, 'checkConclusions');
      out.checkConclusions = list as WorkflowCheckConclusion[];
    }
  }

  if (c.bodyContains !== undefined) {
    if (typeof c.bodyContains !== 'string') fail('conditions.bodyContains must be a string');
    const trimmed = c.bodyContains.trim();
    if (trimmed) {
      appliesTo(BODY_EVENTS, 'bodyContains');
      out.bodyContains = trimmed;
    }
  }

  for (const k of Object.keys(out) as Array<keyof WorkflowConditions>) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

function validateActions(raw: unknown): WorkflowAction[] {
  if (!Array.isArray(raw)) fail('actions must be an array');
  if (raw.length === 0) fail('a workflow needs at least one action');
  return raw.map((entry, i) => validateAction(entry, `actions[${i}]`));
}

function validateAction(raw: unknown, at: string): WorkflowAction {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${at} must be an object`);
  const a = raw as Record<string, unknown>;
  const type = a.type;
  if (typeof type !== 'string' || !(WORKFLOW_ACTION_TYPES as readonly string[]).includes(type)) {
    fail(`${at}.type is not an action Talyn can take on a PR`);
  }

  switch (type as WorkflowActionType) {
    case 'add_labels':
    case 'remove_labels': {
      const labels = stringList(a.labels, `${at}.labels`);
      if (labels.length === 0) fail(`${at} names no labels, so it would do nothing`);
      return { type: type as 'add_labels' | 'remove_labels', labels };
    }
    case 'request_reviewers': {
      const users = optionalStringList(a.users, `${at}.users`);
      const teams = optionalStringList(a.teams, `${at}.teams`);
      if (!users && !teams) fail(`${at} names no reviewers, so it would do nothing`);
      return { type: 'request_reviewers', ...(users ? { users } : {}), ...(teams ? { teams } : {}) };
    }
    case 'assign': {
      const users = stringList(a.users, `${at}.users`);
      if (users.length === 0) fail(`${at} names nobody to assign`);
      return { type: 'assign', users };
    }
    case 'comment': {
      if (typeof a.body !== 'string' || !a.body.trim()) {
        fail(`${at}.body must be a non-empty string`);
      }
      return { type: 'comment', body: a.body.trim() };
    }
    case 'run_skill': {
      if (typeof a.skillKey !== 'string' || !a.skillKey.trim()) {
        fail(`${at}.skillKey must be a non-empty string`);
      }
      const skillKey = a.skillKey.trim();
      // A `local:` skill lives in the user's ~/.claude/skills and is read by
      // the desktop's main process over IPC. The backend cannot see it, so a
      // workflow that names one could never run — refuse it here rather than
      // storing a rule that silently fails every time it matches.
      if (skillKey.startsWith('local:')) {
        fail(
          'A workflow cannot run a local skill — those live on your machine and Talyn runs ' +
            'workflows on the server. Use a repo skill or one saved to the workspace.'
        );
      }
      const model = typeof a.model === 'string' && a.model.trim() ? a.model.trim() : undefined;
      return { type: 'run_skill', skillKey, ...(model ? { model } : {}) };
    }
    case 'run_prompt': {
      if (typeof a.prompt !== 'string' || !a.prompt.trim()) {
        fail(`${at}.prompt must be a non-empty string`);
      }
      const model = typeof a.model === 'string' && a.model.trim() ? a.model.trim() : undefined;
      return { type: 'run_prompt', prompt: a.prompt.trim(), ...(model ? { model } : {}) };
    }
    case 'watch_pr':
      return { type: 'watch_pr' };
    case 'enqueue_merge_queue': {
      const m = a.method;
      if (m !== undefined && m !== 'squash' && m !== 'merge' && m !== 'rebase') {
        fail(`${at}.method must be squash, merge or rebase`);
      }
      return { type: 'enqueue_merge_queue', ...(m ? { method: m as WorkflowMergeMethod } : {}) };
    }
  }
}

/** One-line human summary of a trigger, for the list row. */
export function describeWorkflowTrigger(workflow: Pick<WorkflowDefinition, 'events'>): string {
  const labels = workflow.events.map((e) => WORKFLOW_EVENT_LABELS[e] ?? e);
  if (labels.length <= 2) return labels.join(' or ');
  return `${labels[0]} + ${labels.length - 1} more`;
}

/** One-line human summary of the actions, for the list row. */
export function describeWorkflowActions(workflow: Pick<WorkflowDefinition, 'actions'>): string {
  const labels = workflow.actions.map((a) => WORKFLOW_ACTION_LABELS[a.type] ?? a.type);
  if (labels.length <= 2) return labels.join(', ');
  return `${labels[0]} + ${labels.length - 1} more`;
}

// ============================================================================
// Editor + history helpers
// ============================================================================
//
// Presentation logic both front ends need. It lives here for the same reason the
// matcher does: the desktop and the web app are forks, and a workflow that reads
// as "Label added" on one client and "pr_labeled" on the other is a support
// question.

/**
 * Whether the Workflows surface should be drawn at all.
 *
 * The three-state discipline `cloudProviderOffered` documents, and for the same
 * reason: `null` means the capability answer has not arrived yet, and treating
 * that as "off" flashes the nav item in on every launch. Both `null` and a
 * `false` flag render nothing, but only one of them is an answer.
 *
 * One definition, imported by the desktop and the web fork, so a page cannot be
 * reachable on one client and hidden on the other. It is NOT authorisation:
 * every workflow route and the engine itself gate independently, because a
 * hidden nav item is a decoration the CLI walks straight past.
 */
export function workflowsOffered(features: { workflows?: boolean } | null | undefined): boolean {
  return features?.workflows === true;
}

/**
 * A blank workflow the editor opens on. Save stays refused until it has a name
 * and at least one action — see {@link workflowInputProblem}.
 */
export function emptyWorkflowInput(): WorkflowInput {
  return {
    name: '',
    enabled: true,
    // One trigger preselected, because a workflow with no trigger is not a draft
    // of anything — and this is the one almost everybody starts from.
    events: ['pr_opened'],
    // No conditions and no actions: both are built up a step at a time, and an
    // editor that opens with a half-filled action row reads as a form to correct
    // rather than a thing to compose.
    conditions: {},
    actions: [],
    maxRunsPerPrPerHour: DEFAULT_WORKFLOW_RUNS_PER_PR_PER_HOUR,
  };
}

/** Turn a stored definition back into what the editor edits. */
export function workflowToInput(workflow: WorkflowDefinition): WorkflowInput {
  return {
    name: workflow.name,
    enabled: workflow.enabled,
    events: [...workflow.events],
    conditions: { ...workflow.conditions },
    actions: workflow.actions.map((a) => ({ ...a })),
    maxRunsPerPrPerHour: workflow.maxRunsPerPrPerHour,
  };
}

/** A fresh action of the given type, with the fields its editor row needs. */
export function emptyWorkflowAction(type: WorkflowActionType): WorkflowAction {
  switch (type) {
    case 'add_labels':
      return { type: 'add_labels', labels: [] };
    case 'remove_labels':
      return { type: 'remove_labels', labels: [] };
    case 'request_reviewers':
      return { type: 'request_reviewers', users: [] };
    case 'assign':
      return { type: 'assign', users: [] };
    case 'comment':
      return { type: 'comment', body: '' };
    case 'run_skill':
      return { type: 'run_skill', skillKey: '' };
    case 'run_prompt':
      return { type: 'run_prompt', prompt: '' };
    case 'watch_pr':
      return { type: 'watch_pr' };
    case 'enqueue_merge_queue':
      return { type: 'enqueue_merge_queue' };
  }
}

/**
 * Every condition a workflow can carry, as data.
 *
 * The editor builds its "Add condition" menu from this list rather than
 * hard-coding a form, which is what makes adding a condition a one-entry change
 * instead of an edit in three files that drift. It also means the menu can only
 * ever offer what {@link validateWorkflow} will accept — `appliesTo` here and
 * the `appliesTo()` check in the validator read the same event sets.
 *
 * `input` names the widget, and the widget knows where its own suggestions come
 * from: `repos` from the workspace's watched repositories, `labels` and
 * `branches` from GitHub for the repositories in scope, `actor` from the
 * repositories' collaborators and the org's teams.
 */
export type WorkflowConditionInput =
  | 'repos'
  | 'branches'
  | 'labels'
  | 'label'
  | 'text'
  | 'actor'
  | 'draft'
  | 'baseIsDefault'
  | 'reviewStates'
  | 'checkConclusions';

export interface WorkflowConditionSpec {
  key: keyof WorkflowConditions;
  /** Menu entry and field label. */
  label: string;
  /** One line under the field. */
  hint: string;
  input: WorkflowConditionInput;
  /**
   * Events this condition can apply to, or `null` for "every event" — the
   * generic PR filters, which stay available whatever the trigger is.
   */
  appliesTo: readonly WorkflowTriggerEvent[] | null;
}

export const WORKFLOW_CONDITION_SPECS: readonly WorkflowConditionSpec[] = [
  // ---- Generic PR filters: always offered, whatever the trigger ----------
  {
    key: 'repos',
    label: 'Repository',
    hint: 'Only these repositories. Leave a workflow without this to cover every repository the workspace watches.',
    input: 'repos',
    appliesTo: null,
  },
  {
    key: 'baseBranches',
    label: 'Base branch',
    hint: 'The branch the PR is targeting.',
    input: 'branches',
    appliesTo: null,
  },
  {
    key: 'baseIsDefault',
    label: 'Targets the default branch',
    hint: 'Choose "No" for PRs stacked on another PR — their base is the branch below them, not main.',
    input: 'baseIsDefault',
    appliesTo: null,
  },
  {
    key: 'author',
    label: 'Opened by',
    hint: 'Who opened the PR.',
    input: 'actor',
    appliesTo: null,
  },
  {
    key: 'titleContains',
    label: 'Title contains',
    hint: 'Case-insensitive. Handy for a convention like "fix:" or "[WIP]".',
    input: 'text',
    appliesTo: null,
  },
  {
    key: 'labelsAny',
    label: 'Has any of these labels',
    input: 'labels',
    hint: 'Matches when the PR carries at least one.',
    appliesTo: null,
  },
  {
    key: 'labelsAll',
    label: 'Has all of these labels',
    input: 'labels',
    hint: 'Matches only when the PR carries every one.',
    appliesTo: null,
  },
  {
    key: 'labelsNone',
    label: 'Has none of these labels',
    input: 'labels',
    hint: 'Carrying any one of them stops the workflow.',
    appliesTo: null,
  },
  {
    key: 'draft',
    label: 'Draft',
    hint: 'Restrict to drafts, or to PRs that are not drafts.',
    input: 'draft',
    appliesTo: null,
  },
  {
    key: 'actor',
    label: 'Done by',
    hint: 'Whoever performed the event: the commenter, the reviewer, the person who added the label.',
    input: 'actor',
    appliesTo: null,
  },

  // ---- Event-specific: offered only when the trigger carries the fact ----
  {
    key: 'target',
    label: 'The person named',
    hint: 'Who the event is about — the reviewer who was asked, or the person assigned.',
    input: 'actor',
    appliesTo: TARGET_EVENTS,
  },
  {
    key: 'reviewStates',
    label: 'Review verdict',
    hint: 'Which verdicts count.',
    input: 'reviewStates',
    appliesTo: REVIEW_STATE_EVENTS,
  },
  {
    key: 'labelName',
    label: 'The label that changed',
    hint: 'Only when this exact label was the one added or removed.',
    input: 'label',
    appliesTo: LABEL_NAME_EVENTS,
  },
  {
    key: 'checkConclusions',
    label: 'Checks passed or failed',
    hint: 'Which outcome to act on.',
    input: 'checkConclusions',
    appliesTo: CHECK_EVENTS,
  },
  {
    key: 'bodyContains',
    label: 'Comment contains',
    hint: 'Case-insensitive substring of the comment or review body.',
    input: 'text',
    appliesTo: BODY_EVENTS,
  },
];

/**
 * The value a freshly added condition starts at.
 *
 * Deliberately an EMPTY value rather than a plausible one: a condition the user
 * has just added constrains nothing until they fill it in, and `validateWorkflow`
 * drops an empty list — so a half-filled form saves as "no such condition"
 * instead of silently narrowing the workflow to something nobody typed.
 *
 * `draft` is the one exception, and unavoidably so: it is a boolean with no empty
 * value, so "present but unset" does not exist. Adding it therefore DOES
 * constrain immediately, and it starts at `false` ("not a draft") because that is
 * what somebody adding a draft condition almost always means — a workflow that
 * acts on drafts is the unusual one.
 */
export function emptyWorkflowConditionValue(
  spec: WorkflowConditionSpec
): WorkflowConditions[keyof WorkflowConditions] {
  switch (spec.input) {
    case 'repos':
    case 'branches':
    case 'labels':
      return [];
    case 'label':
    case 'text':
      return '';
    case 'actor':
      // `any` is the absence of a constraint, so the picker opens on it and the
      // validator drops it until the user narrows it.
      return { kind: 'any' } as WorkflowActorMatch;
    case 'draft':
      return false;
    case 'baseIsDefault':
      // `false` = "not the default branch", i.e. stacked — the reason anybody
      // reaches for this condition. Like `draft`, a boolean has no empty value,
      // so adding it constrains immediately.
      return false;
    case 'reviewStates':
      return [] as WorkflowReviewState[];
    case 'checkConclusions':
      return [] as WorkflowCheckConclusion[];
  }
}

/** The spec for one condition key. */
export function workflowConditionSpec(
  key: keyof WorkflowConditions
): WorkflowConditionSpec | undefined {
  return WORKFLOW_CONDITION_SPECS.find((spec) => spec.key === key);
}

/**
 * The conditions worth offering for a set of trigger events — the "Add
 * condition" menu, minus whatever the workflow already carries.
 *
 * Mirrors what {@link validateWorkflow} will ACCEPT, so the form cannot compose
 * a workflow the API then refuses.
 */
export function availableWorkflowConditions(
  events: WorkflowTriggerEvent[],
  already: WorkflowConditions = {}
): WorkflowConditionSpec[] {
  return WORKFLOW_CONDITION_SPECS.filter((spec) => {
    if (already[spec.key] !== undefined) return false;
    if (spec.appliesTo === null) return true;
    return events.some((e) => spec.appliesTo!.includes(e));
  });
}

/**
 * Strip conditions that no longer apply to the chosen events.
 *
 * Called when the trigger selection changes. Without it, unchecking
 * "Review submitted" would leave a stored `reviewStates` behind and the save
 * would 400 with a message about a condition the user can no longer see.
 */
export function pruneWorkflowConditions(
  conditions: WorkflowConditions,
  events: WorkflowTriggerEvent[]
): WorkflowConditions {
  const next = { ...conditions };
  for (const spec of WORKFLOW_CONDITION_SPECS) {
    if (spec.appliesTo === null) continue;
    if (!events.some((e) => spec.appliesTo!.includes(e))) delete next[spec.key];
  }
  return next;
}

/**
 * Why Save is disabled, or `null` when the workflow is savable.
 *
 * The same rules {@link validateWorkflow} enforces, reached before the request
 * so the editor can point at the field instead of surfacing a 400.
 */
export function workflowInputProblem(input: WorkflowInput): string | null {
  try {
    validateWorkflow(input);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'This workflow is not valid';
  }
}

/** Human label for one action, with its arguments — for a run's history row. */
export function describeWorkflowAction(action: WorkflowAction): string {
  switch (action.type) {
    case 'add_labels':
      return `Add ${action.labels.join(', ')}`;
    case 'remove_labels':
      return `Remove ${action.labels.join(', ')}`;
    case 'request_reviewers':
      return `Request ${[...(action.users ?? []), ...(action.teams ?? [])].join(', ')}`;
    case 'assign':
      return `Assign ${action.users.join(', ')}`;
    case 'comment':
      return 'Post a comment';
    case 'run_skill':
      return `Run skill ${action.skillKey.replace(/^(repo:[^:]+:|platform:)/, '')}`;
    case 'run_prompt':
      return 'Run a prompt';
    case 'watch_pr':
      return 'Add to My PRs';
    case 'enqueue_merge_queue':
      return action.method
        ? `Add to the merge queue (${action.method})`
        : 'Add to the merge queue';
  }
}

/**
 * How a run's status should read to a user.
 *
 * `skipped` deliberately does not say "skipped": every skip today is the rate
 * cap standing a workflow down, and "stood down" says that it was a decision
 * rather than a dropped event.
 */
export const WORKFLOW_RUN_STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  running: 'Running',
  succeeded: 'Done',
  partial: 'Partly done',
  failed: 'Failed',
  skipped: 'Stood down',
};
