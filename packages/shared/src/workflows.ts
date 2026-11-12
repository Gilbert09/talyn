import { isCodeReviewPreset, type CodeReviewPreset } from './codeReview.js';
// Workflows — the user's own automations over PR lifecycle events and, since
// rules became per integration, over Slack channel messages.
//
// A rule belongs to ONE integration (`integration`, absent ⇒ `github`), and its
// events, conditions and actions must all belong to that integration. The
// validator refuses a mix with a message that says what to change.
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
// Integrations
// ============================================================================

/** The integrations a rule can belong to. */
export const WORKFLOW_INTEGRATIONS = ['github', 'slack', 'webhook', 'linear', 'github_issues'] as const;

export type WorkflowIntegration = (typeof WORKFLOW_INTEGRATIONS)[number];

/** How each integration reads in a message or a picker. */
export const WORKFLOW_INTEGRATION_LABELS: Record<WorkflowIntegration, string> = {
  github: 'GitHub',
  slack: 'Slack',
  webhook: 'Webhook',
  linear: 'Linear',
  github_issues: 'GitHub Issues',
};

/** The integrations whose rules act on an issue in a tracker. */
export const ISSUE_WORKFLOW_INTEGRATIONS = ['linear', 'github_issues'] as const;

export type IssueWorkflowIntegration = (typeof ISSUE_WORKFLOW_INTEGRATIONS)[number];

export function isIssueWorkflowIntegration(value: unknown): value is IssueWorkflowIntegration {
  return typeof value === 'string' && (ISSUE_WORKFLOW_INTEGRATIONS as readonly string[]).includes(value);
}

export function isWorkflowIntegration(value: unknown): value is WorkflowIntegration {
  return typeof value === 'string' && (WORKFLOW_INTEGRATIONS as readonly string[]).includes(value);
}

/**
 * The integration a stored rule, an input or a run belongs to.
 *
 * Absent means `github`: every rule written before integrations existed is a
 * GitHub rule, and an old client sends no field at all.
 */
export function workflowIntegrationOf(
  value: { integration?: WorkflowIntegration | null } | null | undefined
): WorkflowIntegration {
  return isWorkflowIntegration(value?.integration) ? value.integration : 'github';
}

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
/**
 * Order is the order the editors offer them in, so the CI pair leads: "when my
 * PR goes green" is the rule people come to this screen to write, and it used
 * to be the last option on a scrolling list.
 */
export const GITHUB_WORKFLOW_EVENTS = [
  'pr_checks_passed',
  'pr_checks_completed',
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
] as const;

export type GithubWorkflowEvent = (typeof GITHUB_WORKFLOW_EVENTS)[number];

/**
 * The GitHub PR events, under the name the editors and the MCP schema have
 * always read. It does NOT include the Slack events: the GitHub editor offers
 * this list, and a Slack event there could only be refused on save.
 */
export const WORKFLOW_TRIGGER_EVENTS = GITHUB_WORKFLOW_EVENTS;

/**
 * The Slack events a rule can trigger on.
 *
 * `slack_message` is a new message in a watched channel, from a person or from
 * another app or bot (an alerting app is the usual reason to watch a channel).
 * Edits and Talyn's own messages are dropped before matching, by the Slack
 * source adapter.
 */
export const SLACK_WORKFLOW_EVENTS = ['slack_message'] as const;

export type SlackWorkflowEvent = (typeof SLACK_WORKFLOW_EVENTS)[number];

/**
 * The webhook events a rule can trigger on: one request to the rule's own URL.
 * A webhook rule has its own URL, so the event needs no other name.
 */
export const WEBHOOK_WORKFLOW_EVENTS = ['webhook_received'] as const;

export type WebhookWorkflowEvent = (typeof WEBHOOK_WORKFLOW_EVENTS)[number];

/**
 * The issue events a Linear or GitHub Issues rule can trigger on. One vendor
 * update can yield several of them (a label and an assignee changed at once).
 */
export const ISSUE_WORKFLOW_EVENTS = [
  'issue_created',
  'issue_labeled',
  'issue_assigned',
  'issue_status_changed',
  'issue_commented',
  'issue_updated',
] as const;

/**
 * The event of a merge write-back run: the pull request that a rule's work
 * opened merged. Talyn records it on the rule's history. A rule cannot
 * trigger on it, so it is not in {@link ISSUE_WORKFLOW_EVENTS}.
 */
export const ISSUE_MERGE_EVENT = 'issue_pr_merged' as const;

export type IssueWorkflowEvent = (typeof ISSUE_WORKFLOW_EVENTS)[number] | typeof ISSUE_MERGE_EVENT;

/** Every event any rule can trigger on. */
export type WorkflowTriggerEvent =
  | GithubWorkflowEvent
  | SlackWorkflowEvent
  | WebhookWorkflowEvent
  | IssueWorkflowEvent;

/** Every event, of every integration. */
export const ALL_WORKFLOW_TRIGGER_EVENTS: readonly WorkflowTriggerEvent[] = [
  ...GITHUB_WORKFLOW_EVENTS,
  ...SLACK_WORKFLOW_EVENTS,
  ...WEBHOOK_WORKFLOW_EVENTS,
  ...ISSUE_WORKFLOW_EVENTS,
];

/** The events that belong to one integration. */
export function workflowEventsFor(integration: WorkflowIntegration): readonly WorkflowTriggerEvent[] {
  switch (integration) {
    case 'slack':
      return SLACK_WORKFLOW_EVENTS;
    case 'webhook':
      return WEBHOOK_WORKFLOW_EVENTS;
    case 'linear':
    case 'github_issues':
      return ISSUE_WORKFLOW_EVENTS;
    default:
      return GITHUB_WORKFLOW_EVENTS;
  }
}

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
  pr_checks_completed: 'A check suite finished',
  pr_checks_passed: 'All checks passed',
  slack_message: 'New message in a channel',
  webhook_received: 'Webhook received',
  issue_created: 'Issue created',
  issue_labeled: 'Label added to the issue',
  issue_assigned: 'Issue assigned',
  issue_status_changed: 'Issue status changed',
  issue_commented: 'Comment on the issue',
  issue_updated: 'Issue title or description changed',
  issue_pr_merged: 'Pull request merged',
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
  // Stronger than the receiver's filter for this one: `pr_checks_passed` is
  // derived from Talyn's OWN recomputed check counts for the PR row, so an
  // untracked PR has no counts to go green.
  'pr_checks_passed',
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
/**
 * Events that carry a check conclusion.
 *
 * `pr_checks_passed` is deliberately NOT here: passing is what the event
 * already means, so offering "…and the conclusion was failure" next to it
 * composes a rule that can never fire. The validator refuses the condition on
 * it for the same reason.
 */
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

  // ---- Slack rules only -------------------------------------------------

  /** The Slack team (workspace) the rule watches. Required on a Slack rule. */
  slackTeamId?: string;
  /** Slack channel ids. Matches a message in ANY of them. Required on a Slack rule. */
  channels?: string[];
  /** Case-insensitive substring of the Slack message text. */
  textContains?: string;
  /** Who may trigger the rule. Absent means `any`. */
  slackAuthors?: WorkflowSlackAuthorMatch;
  /** Whether a reply inside a thread triggers the rule. Absent means no. */
  includeThreadReplies?: boolean;

  // ---- Webhook rules only -----------------------------------------------

  /** Tests on the JSON body of the request. All must pass. Absent means every request. */
  payloadMatches?: WebhookPayloadCondition[];

  // ---- Issue rules (Linear, GitHub Issues) ------------------------------
  //
  // An issue rule also reads `repos` (GitHub Issues), `labelsAny`,
  // `labelsAll`, `labelsNone`, `labelName`, `titleContains` and
  // `bodyContains`, with the same meaning as on a pull request.

  /** Linear only: the Linear connection (one organization) the rule watches. Required. */
  connectionId?: string;
  /** Linear team keys, like `ENG`. Matches ANY. */
  teams?: string[];
  /** Linear project names. Matches ANY. */
  projects?: string[];
  /** Status names: a Linear workflow state, or `open` / `closed` on GitHub. Matches ANY. */
  statuses?: string[];
  /** Linear priority names (`Urgent`, `High`, `Medium`, `Low`, `No priority`). Matches ANY. */
  priorities?: string[];
  /** Who the issue is assigned to. */
  issueAssignee?: IssueAssigneeMatch;
  /** GitHub Issues only: who opened the issue, by login. Matches ANY. */
  issueAuthors?: string[];
}

/**
 * Who an issue is assigned to.
 *
 * - `talyn`: Linear only. The issue is assigned or delegated to Talyn's app
 *   user (the connection must have the `app:assignable` scope).
 * - `me`: GitHub Issues only. The workspace's connected GitHub user.
 * - `unassigned`: nobody.
 * - `people`: any of these logins, names or ids (case-insensitive).
 */
export type IssueAssigneeMatch =
  | { kind: 'talyn' }
  | { kind: 'me' }
  | { kind: 'unassigned' }
  | { kind: 'people'; people: string[] };

export const ISSUE_ASSIGNEE_KINDS = ['talyn', 'me', 'unassigned', 'people'] as const;

export const ISSUE_ASSIGNEE_KIND_LABELS: Record<(typeof ISSUE_ASSIGNEE_KINDS)[number], string> = {
  talyn: 'Talyn',
  me: 'Me',
  unassigned: 'Nobody',
  people: 'Specific people',
};

/**
 * One test on a webhook's JSON body.
 *
 * `path` is a dot path with array indices: `issue.labels[0].name` or
 * `issue.labels.0.name`. A path that does not resolve fails every test.
 *
 * - `equals`: the value at the path, as text, is exactly `value`.
 * - `contains`: for text, `value` appears in it (case-insensitive). For an
 *   array, one item, as text, is `value` (case-insensitive).
 * - `exists`: the path resolves to a value that is not null.
 *
 * No expression language on purpose: a short list of these is legible in the
 * editor, and a rule that needs OR is two rules.
 */
export interface WebhookPayloadCondition {
  path: string;
  op: WebhookPayloadOp;
  /** Required for `equals` and `contains`. Absent for `exists`. */
  value?: string;
}

export const WEBHOOK_PAYLOAD_OPS = ['equals', 'contains', 'exists'] as const;

export type WebhookPayloadOp = (typeof WEBHOOK_PAYLOAD_OPS)[number];

export const WEBHOOK_PAYLOAD_OP_LABELS: Record<WebhookPayloadOp, string> = {
  equals: 'equals',
  contains: 'contains',
  exists: 'is present',
};

/**
 * Who may trigger a Slack rule.
 *
 * `any` is the default: anyone who posts in a watched channel, apps and bots
 * included. `linked` narrows
 * a rule to Slack users who linked their Slack account to Talyn in that Slack
 * team. The editors do not offer it, but MCP can set it.
 */
export type WorkflowSlackAuthorMatch =
  | { kind: 'linked' }
  | { kind: 'any' }
  | { kind: 'users'; userIds: string[] };

export const WORKFLOW_SLACK_AUTHOR_KINDS = ['linked', 'any', 'users'] as const;

export const WORKFLOW_SLACK_AUTHOR_KIND_LABELS: Record<
  (typeof WORKFLOW_SLACK_AUTHOR_KINDS)[number],
  string
> = {
  linked: 'People linked to Talyn',
  any: 'Anyone in the channel',
  users: 'Specific people',
};

/** The condition keys a GitHub rule may carry. */
export const GITHUB_WORKFLOW_CONDITION_KEYS = [
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
  'checkConclusions',
  'bodyContains',
] as const satisfies ReadonlyArray<keyof WorkflowConditions>;

/** The condition keys a Slack rule may carry. */
export const SLACK_WORKFLOW_CONDITION_KEYS = [
  'slackTeamId',
  'channels',
  'textContains',
  'slackAuthors',
  'includeThreadReplies',
] as const satisfies ReadonlyArray<keyof WorkflowConditions>;

/** The condition keys a webhook rule may carry. */
export const WEBHOOK_WORKFLOW_CONDITION_KEYS = ['payloadMatches'] as const satisfies ReadonlyArray<
  keyof WorkflowConditions
>;

/** The condition keys a GitHub Issues rule may carry. */
export const GITHUB_ISSUES_WORKFLOW_CONDITION_KEYS = [
  'repos',
  'labelsAny',
  'labelsAll',
  'labelsNone',
  'labelName',
  'issueAssignee',
  'issueAuthors',
  'statuses',
  'titleContains',
  'bodyContains',
] as const satisfies ReadonlyArray<keyof WorkflowConditions>;

/** The condition keys a Linear rule may carry. */
export const LINEAR_WORKFLOW_CONDITION_KEYS = [
  'connectionId',
  'teams',
  'projects',
  'statuses',
  'priorities',
  'labelsAny',
  'labelsAll',
  'labelsNone',
  'labelName',
  'issueAssignee',
  'titleContains',
  'bodyContains',
] as const satisfies ReadonlyArray<keyof WorkflowConditions>;

/** The condition keys each integration's rules may carry. */
export function workflowConditionKeysFor(integration: WorkflowIntegration): readonly string[] {
  switch (integration) {
    case 'slack':
      return SLACK_WORKFLOW_CONDITION_KEYS;
    case 'webhook':
      return WEBHOOK_WORKFLOW_CONDITION_KEYS;
    case 'linear':
      return LINEAR_WORKFLOW_CONDITION_KEYS;
    case 'github_issues':
      return GITHUB_ISSUES_WORKFLOW_CONDITION_KEYS;
    default:
      return GITHUB_WORKFLOW_CONDITION_KEYS;
  }
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
  'run_code_review',
] as const;

/**
 * The PR actions, under the name the GitHub editor and the MCP schema have
 * always read. It does not include `start_session` or the Slack actions; see
 * {@link ALL_WORKFLOW_ACTION_TYPES} and {@link workflowActionsFor}.
 */
export type GithubPrWorkflowActionType = (typeof WORKFLOW_ACTION_TYPES)[number];

/** Start a session. Every integration's rules can use it. */
export const SHARED_WORKFLOW_ACTION_TYPES = ['start_session'] as const;

/** Act on the Slack message that triggered the rule. Slack rules only. */
export const SLACK_WORKFLOW_ACTION_TYPES = ['slack_reply', 'slack_react'] as const;

/**
 * Start a cloud task on a named repository. Inbound rules only (webhooks
 * today): a GitHub rule has `run_prompt`, which runs on the pull request.
 */
export const INBOUND_WORKFLOW_ACTION_TYPES = ['start_task'] as const;

/**
 * Write back to the issue that triggered the rule. Issue rules only. Talyn
 * writes with the connection's credential; the agent never holds it.
 */
export const ISSUE_WORKFLOW_ACTION_TYPES = ['issue_comment', 'issue_set_status'] as const;

/** Every action type, of every integration. */
export const ALL_WORKFLOW_ACTION_TYPES = [
  ...WORKFLOW_ACTION_TYPES,
  ...SHARED_WORKFLOW_ACTION_TYPES,
  ...SLACK_WORKFLOW_ACTION_TYPES,
  ...INBOUND_WORKFLOW_ACTION_TYPES,
  ...ISSUE_WORKFLOW_ACTION_TYPES,
] as const;

export type WorkflowActionType = (typeof ALL_WORKFLOW_ACTION_TYPES)[number];

/** The action types one integration's rules may use. */
export function workflowActionsFor(integration: WorkflowIntegration): readonly WorkflowActionType[] {
  switch (integration) {
    case 'slack':
      return [...SHARED_WORKFLOW_ACTION_TYPES, ...SLACK_WORKFLOW_ACTION_TYPES];
    case 'webhook':
      return [...SHARED_WORKFLOW_ACTION_TYPES, ...INBOUND_WORKFLOW_ACTION_TYPES];
    case 'linear':
    case 'github_issues':
      return [...SHARED_WORKFLOW_ACTION_TYPES, ...INBOUND_WORKFLOW_ACTION_TYPES, ...ISSUE_WORKFLOW_ACTION_TYPES];
    default:
      return [...WORKFLOW_ACTION_TYPES, ...SHARED_WORKFLOW_ACTION_TYPES];
  }
}

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
  | { type: 'enqueue_merge_queue'; method?: WorkflowMergeMethod }
  /**
   * Start a code review on the pull request.
   *
   * `preset` is optional and falls back to the workspace's own default, so a
   * workflow written before a team settled on a depth keeps following that
   * setting rather than pinning whatever was current the day it was saved.
   *
   * It does NOT count as a task action below: a review's units are not `tasks`
   * rows — they cannot be, because `activePrTaskId` would refuse the second one
   * and `withTaskLimitGate` would eat the plan's allowance — so it is metered by
   * the review cycle gate instead.
   */
  | { type: 'run_code_review'; preset?: CodeReviewPreset }
  /**
   * Start a session with the rule's prompt.
   *
   * `repositoryId: null` means "let Talyn choose", which only a Slack rule can
   * do: Talyn picks the repository from the message. A GitHub rule runs on the
   * pull request's own repository. A webhook rule must name one.
   *
   * On a GitHub Issues rule, `null` means the issue's own repository. A
   * Linear rule must name one.
   */
  | ({
      type: 'start_session';
      repositoryId: string | null;
      prompt: string;
      model?: string;
      internetAccess?: boolean;
    } & IssueWriteBackSettings)
  /** Reply in the thread of the Slack message that triggered the rule. */
  | { type: 'slack_reply'; text: string }
  /** React to the Slack message that triggered the rule. `emoji` has no colons. */
  | { type: 'slack_react'; emoji: string }
  /**
   * Start a cloud task (`code_writing`) on the named repository with the
   * rule's prompt. The alternative to `start_session` for inbound rules.
   * `null` is allowed on a GitHub Issues rule only: the issue's repository.
   */
  | ({
      type: 'start_task';
      repositoryId: string | null;
      prompt: string;
      model?: string;
      internetAccess?: boolean;
    } & IssueWriteBackSettings)
  /**
   * Comment on the issue that triggered the rule. `afterStart` marks the
   * comment Talyn adds after a start action ("Talyn started: <link>"); the
   * validator never stores it.
   */
  | { type: 'issue_comment'; body: string; afterStart?: true }
  /**
   * Move the issue to a status. `done` is the team's first completed state on
   * Linear and "closed as completed" on GitHub. Any other value is a Linear
   * state name, or `open` / `closed` on GitHub.
   */
  | { type: 'issue_set_status'; status: string };

/**
 * The write-back an issue rule's start action does. Both default to ON, so
 * only `false` is stored. Refused on rules that are not issue rules.
 */
export interface IssueWriteBackSettings {
  /** Comment on the issue when the work starts: "Talyn started: <link>". */
  issueStartComment?: boolean;
  /** When the work's pull request merges, move the issue to done as well as comment. */
  issueDoneOnMerge?: boolean;
}

/** The comment Talyn adds when an issue rule's session starts. */
export const ISSUE_START_COMMENT_SESSION = 'Talyn started working on this: {{session.url}}';
/** The comment Talyn adds when an issue rule's task starts. */
export const ISSUE_START_COMMENT_TASK = 'Talyn started working on this: {{task.url}}';
/** The comment Talyn adds when the work's pull request merges. */
export const ISSUE_MERGE_COMMENT = 'Talyn merged a fix for this: {{pr.url}}';

/**
 * The actions a run of this rule takes, in order: the rule's own actions,
 * plus the start comment after a start action on an issue rule. The engine
 * and the retry sweep both run this list, so the outcomes of a run line up
 * with it.
 */
export function effectiveWorkflowActions(
  workflow: Pick<WorkflowDefinition, 'actions'> & { integration?: WorkflowIntegration }
): WorkflowAction[] {
  if (!isIssueWorkflowIntegration(workflowIntegrationOf(workflow))) return workflow.actions;
  const out: WorkflowAction[] = [];
  for (const action of workflow.actions) {
    out.push(action);
    if ((action.type === 'start_session' || action.type === 'start_task') && action.issueStartComment !== false) {
      out.push({
        type: 'issue_comment',
        body: action.type === 'start_session' ? ISSUE_START_COMMENT_SESSION : ISSUE_START_COMMENT_TASK,
        afterStart: true,
      });
    }
  }
  return out;
}

/** The start action of an issue rule, or null. The validator allows at most one. */
export function issueStartAction(
  workflow: Pick<WorkflowDefinition, 'actions'>
): Extract<WorkflowAction, { type: 'start_session' | 'start_task' }> | null {
  for (const action of workflow.actions) {
    if (action.type === 'start_session' || action.type === 'start_task') return action;
  }
  return null;
}

/**
 * The actions of a merge write-back run: a comment with the pull request's
 * link, then the move to done unless the rule turned it off.
 */
export function issueMergeActions(workflow: Pick<WorkflowDefinition, 'actions'>): WorkflowAction[] {
  const start = issueStartAction(workflow);
  const actions: WorkflowAction[] = [{ type: 'issue_comment', body: ISSUE_MERGE_COMMENT }];
  if (start?.issueDoneOnMerge !== false) actions.push({ type: 'issue_set_status', status: 'done' });
  return actions;
}

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
  run_code_review: 'Run a code review',
  start_session: 'Start a session',
  slack_reply: 'Reply in the thread',
  slack_react: 'Add a reaction',
  start_task: 'Start a task',
  issue_comment: 'Comment on the issue',
  issue_set_status: 'Change the issue status',
};

/** Actions that start a cloud task, and so consume a plan task slot. */
export function workflowActionStartsTask(action: WorkflowAction): boolean {
  return action.type === 'run_skill' || action.type === 'run_prompt' || action.type === 'start_task';
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
  /**
   * The integration the rule belongs to. Absent on rules from servers older
   * than integrations, and absent means `github` — read it through
   * {@link workflowIntegrationOf}.
   */
  integration?: WorkflowIntegration;
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
  /** Absent means `github`, so an old client keeps creating GitHub rules. */
  integration?: WorkflowIntegration;
  name: string;
  enabled?: boolean;
  events: WorkflowTriggerEvent[];
  conditions?: WorkflowConditions;
  actions: WorkflowAction[];
  maxRunsPerPrPerHour?: number;
}

/** The validated, normalised core of a workflow — what the DB columns hold. */
export interface NormalizedWorkflow {
  integration: WorkflowIntegration;
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
 *
 * `pending_retry` is a run whose action GitHub rate-limited: the work is owed,
 * not abandoned. It is parked with the instant the gate clears and a sweep
 * re-runs only the actions that have not succeeded. Waiting inline is what this
 * replaced — these run in the webhook worker's six-wide slow lane, and the gate
 * is per ACCOUNT, so a burst of PRs would block most of the lane on one wait.
 */
export type WorkflowRunStatus =
  | 'running'
  | 'pending_retry'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'skipped';

/**
 * Why one action inside a run did not happen. A machine code rather than only
 * prose, so the history UI can style a refusal (rate cap, plan limit) apart
 * from a genuine error, and so a test can assert on it.
 */
export type WorkflowActionFailureCode =
  | 'rate_capped'
  /** Old rows only: the active-task cap that the concurrent-box cap replaced. */
  | 'task_limit_reached'
  /** Parked (`pending_retry`): no box-hours or credits left this period. */
  | 'usage_exhausted'
  /** Parked (`pending_retry`): the plan's concurrent boxes are all in use. */
  | 'box_limit_reached'
  /** The plan cannot start the run's box size. Not retried. */
  | 'size_requires_pro'
  | 'rate_gated'
  | 'no_cloud_provider'
  | 'task_already_running'
  /** A live session is working this PR, so no run is started beside it. */
  | 'session_active'
  | 'skill_unavailable'
  | 'pr_not_tracked'
  | 'not_open'
  | 'github_error'
  /** Old rows only: the merge-queue PR cap, removed with usage billing. */
  | 'merge_queue_limit_reached'
  /** Old rows only: the review-cycle cap, removed with usage billing. */
  | 'review_limit_reached'
  /** Code review cannot run here: no reviewer covers this repository. */
  | 'code_review_unavailable'
  /**
   * The Slack install has no `chat:write` scope, so Talyn cannot reply. Not
   * retried: it clears only when somebody installs the Slack app again.
   */
  | 'slack_scope_missing'
  /** Slack refused a call (not a rate limit, not a missing scope). */
  | 'slack_error'
  /**
   * A Slack rule left the repository to Talyn, and the message did not name
   * one clearly. Not retried, and no pending request is made: nobody is
   * waiting to pick one. Set a repository on the rule.
   */
  | 'repository_unresolved'
  /** The session could not start (agent not connected, sessions not allowed). */
  | 'session_unavailable'
  /**
   * Work that an earlier event started on this issue is still running, so no
   * second session or task is started for it.
   */
  | 'issue_already_running'
  /** The issue tracker refused a write-back (not a rate limit). */
  | 'issue_error'
  /** The tracker connection is gone or needs a new sign-in, so Talyn cannot write back. */
  | 'issue_unavailable'
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
  /** Absent on servers older than integrations, and absent means `github`. */
  integration?: WorkflowIntegration;
  /**
   * What the run acted on, as a stable key: `pr:<owner/repo>#<number>` or
   * `slack:<team>:<channel>`. The per-hour rate cap counts runs per key.
   */
  subjectKey?: string | null;
  /** The subject as a person reads it: `owner/repo#12` or `#eng-bugs`. */
  subjectLabel?: string | null;
  /** The session a `start_session` action started, if any. */
  workbenchId?: string | null;
  repositoryId: string | null;
  /** Empty on a Slack run. */
  repoFullName: string;
  /** 0 on a Slack run. */
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
  /** When a `pending_retry` run becomes due. Null for every other status. */
  retryAfter: string | null;
  /** How many times the actions have been attempted. Starts at 1. */
  attempts: number;
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

/**
 * How many workflows a workspace has, for the nav badge.
 *
 * Its own endpoint rather than a `list().length`, because the badge is fetched
 * on every boot for every user and `listWorkflows` is the expensive read: it
 * ships each rule's `events`/`conditions`/`actions` jsonb AND aggregates the
 * whole run history for the per-workflow stats. The badge needs one integer.
 */
export interface WorkflowCounts {
  /** Enabled workflows only — a disabled rule is not automation that is running. */
  enabled: number;
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
export interface GithubEventFacts {
  /**
   * The integration tag of the facts union. Optional on this side: facts stored
   * on runs written before integrations existed carry no tag, and absent means
   * GitHub.
   */
  integration?: 'github';
  event: GithubWorkflowEvent;
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

/**
 * The GitHub facts, under the name every GitHub caller has always used. A
 * caller that can also see Slack facts takes {@link WorkflowFacts}.
 */
export type WorkflowEventFacts = GithubEventFacts;

/**
 * The facts one Slack message yields.
 *
 * Built by the Slack source adapter from a Slack `message` event. The adapter
 * drops edits and Talyn's own messages before this exists, and
 * it fills `authorLinked` from `slack_user_links`, because the matcher is pure
 * and cannot read the database.
 */
export interface SlackEventFacts {
  integration: 'slack';
  event: SlackWorkflowEvent;
  teamId: string;
  channelId: string;
  /** Without the `#`. Absent when the adapter could not resolve it. */
  channelName?: string;
  /**
   * The Slack user who wrote the message. For an app, its bot user, or its
   * `B…` bot id when Slack sends no user (a legacy integration or webhook).
   */
  userId: string;
  /** The message's words, with an app's blocks and attachments read in. */
  text: string;
  /** The message's own timestamp, which is also its id in the channel. */
  ts: string;
  /**
   * The thread the message is in, or null for a message at the top of the
   * channel. A thread's first message has `threadTs === ts`; only a REPLY has a
   * different one.
   */
  threadTs: string | null;
  permalink?: string;
  /** Whether `userId` is linked to a Talyn account in this Slack team. */
  authorLinked: boolean;
}

/**
 * The facts one webhook request yields.
 *
 * Built by the webhook source adapter from a stored inbound delivery. A
 * webhook rule owns its URL, so `ruleId` names the one rule the request is
 * for, and the matcher refuses every other rule.
 *
 * `payload` is the parsed JSON body (or the body as text when it is not
 * JSON). A run's stored facts drop it to keep `workflow_runs` small, and a
 * retry reads it again from `inbound_deliveries` by `deliveryRowId`.
 */
export interface WebhookEventFacts {
  integration: 'webhook';
  event: WebhookWorkflowEvent;
  ruleId: string;
  connectionId: string;
  /** `inbound_deliveries.id` of the stored request. */
  deliveryRowId: string;
  /** The sender's delivery id (`X-Talyn-Delivery`), or a hash of the body. */
  deliveryId: string;
  receivedAt: string;
  payload: unknown;
  /** The request headers Talyn keeps: never a credential or a signature. */
  headers: Record<string, string>;
}

/**
 * The facts one issue event yields, from Linear or GitHub Issues.
 *
 * Built by the vendor's source adapter. Text fields are cut to
 * {@link MAX_ISSUE_FACT_TEXT} so a run row stays small; the prompt quotes no
 * more than that anyway.
 */
export interface IssueEventFacts {
  integration: IssueWorkflowIntegration;
  event: IssueWorkflowEvent;
  /** Linear: `inbound_connections.id`. GitHub Issues: null (the GitHub App connection). */
  connectionId: string | null;
  /** The vendor's stable id: the Linear issue id, or the GitHub issue's numeric id. */
  externalId: string;
  /** What a person calls the issue: `ENG-123`, or `owner/repo#12`. */
  identifier: string;
  title: string;
  /** The issue description. */
  body: string;
  url: string;
  labels: string[];
  /** The assignee's login or name, or null. */
  assignee: string | null;
  /** The assignee's vendor id, when the payload has it. */
  assigneeId?: string | null;
  /** Linear: the agent the issue is delegated to (an app user), when the payload has it. */
  delegateId?: string | null;
  /** Linear: whether the issue is assigned or delegated to Talyn's app user. Set by the adapter. */
  assignedToApp?: boolean;
  /** Linear team key. Null on GitHub. */
  team: string | null;
  /** Linear team id, for write-back. */
  teamId?: string | null;
  /** Linear project name. Null on GitHub. */
  project: string | null;
  /** Linear state name, or `open` / `closed` on GitHub. */
  status: string;
  /** Linear priority name. Null on GitHub. */
  priority: string | null;
  /** Who did this event, by login or name. Null when the payload does not say. */
  actor: string | null;
  /** The actor's vendor id. */
  actorId?: string | null;
  /** GitHub: who opened the issue. */
  author?: string | null;
  /** GitHub Issues: the repository, `owner/repo`. */
  repoFullName?: string;
  /** GitHub Issues: the issue number. */
  number?: number;
  /** `issue_labeled`: the label that was added. */
  labelName?: string;
  /** `issue_commented`: the new comment. */
  comment?: { id: string; body: string; author: string | null };
  /** A merge write-back run only: the pull request that merged. */
  mergedPrUrl?: string;
  /**
   * Fields this event's payload could not supply. A condition on one fails,
   * as on a pull request (see {@link GithubEventFacts.unknownFields}).
   */
  unknownFields?: ReadonlyArray<IssueFactField>;
}

/** An issue fact a payload may not carry. */
export type IssueFactField = 'labels' | 'assignee' | 'team' | 'project' | 'status' | 'priority' | 'body';

/**
 * The longest issue text a fact keeps (the body, a comment). 16 KB is what
 * the prompt quotes of a request body, and a run row stores its facts.
 */
export const MAX_ISSUE_FACT_TEXT = 16 * 1024;

/** The facts any rule can match on, tagged by integration. */
export type WorkflowFacts = GithubEventFacts | SlackEventFacts | WebhookEventFacts | IssueEventFacts;

export function isIssueFacts(facts: WorkflowFacts): facts is IssueEventFacts {
  return facts.integration === 'linear' || facts.integration === 'github_issues';
}

export function isSlackFacts(facts: WorkflowFacts): facts is SlackEventFacts {
  return facts.integration === 'slack';
}

export function isWebhookFacts(facts: WorkflowFacts): facts is WebhookEventFacts {
  return facts.integration === 'webhook';
}

export function isGithubFacts(facts: WorkflowFacts): facts is GithubEventFacts {
  return facts.integration === undefined || facts.integration === 'github';
}

/** The integration a set of facts came from. Untagged facts are GitHub's. */
export function factsIntegration(facts: WorkflowFacts): WorkflowIntegration {
  return facts.integration ?? 'github';
}

/** Whether a Slack message is a reply inside a thread, not a top-level message. */
export function isSlackThreadReply(facts: Pick<SlackEventFacts, 'ts' | 'threadTs'>): boolean {
  return !!facts.threadTs && facts.threadTs !== facts.ts;
}

/**
 * What a run acted on: a stable key and a label a person reads.
 *
 * The key is what the per-hour rate cap counts by. A GitHub rule is capped per
 * pull request (`pr:<owner/repo>#<number>`), a Slack rule per channel
 * (`slack:<team>:<channel>`), a webhook rule per rule (`webhook:<ruleId>`),
 * because the rule's URL is the only subject a webhook has.
 */
export function workflowSubjectOf(facts: WorkflowFacts): { key: string; label: string } {
  if (isIssueFacts(facts)) {
    return { key: `issue:${facts.integration}:${facts.externalId}`, label: facts.identifier };
  }
  if (isWebhookFacts(facts)) {
    return { key: `webhook:${facts.ruleId}`, label: 'Webhook' };
  }
  if (isSlackFacts(facts)) {
    return {
      key: `slack:${facts.teamId}:${facts.channelId}`,
      label: facts.channelName ? `#${facts.channelName}` : facts.channelId,
    };
  }
  return {
    key: `pr:${facts.repoFullName}#${facts.number}`,
    label: `${facts.repoFullName}#${facts.number}`,
  };
}

/** A fact a payload may not carry. See {@link GithubEventFacts.unknownFields}. */
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
  workflow: Pick<WorkflowDefinition, 'events' | 'conditions'> & {
    integration?: WorkflowIntegration;
    /** Required to match webhook facts: a webhook names its one rule. */
    id?: string;
  },
  facts: WorkflowFacts,
  /**
   * The workspace's connected GitHub login, for any `viewer` actor match.
   * Absent means unknown, which FAILS the condition — "when I am asked to
   * review" must not turn into "when anyone is asked to review" because we
   * could not resolve who "I" is.
   */
  viewerLogin?: string | null
): boolean {
  // A rule only ever matches facts from its own integration. The event sets do
  // not overlap, so this is also implied by the event test below; it is said
  // here so a rule with no events stored cannot fall through to the other side.
  const integration = workflowIntegrationOf(workflow);
  if (integration !== factsIntegration(facts)) return false;
  if (!workflow.events.includes(facts.event)) return false;
  const conditions = workflow.conditions ?? {};
  if (isWebhookFacts(facts)) {
    // A webhook's URL belongs to one rule. Without the id, no match: a rule
    // must never act on a request sent to another rule's URL.
    if (!workflow.id || workflow.id !== facts.ruleId) return false;
    return webhookConditionsMatch(conditions, facts);
  }
  if (isIssueFacts(facts)) return issueConditionsMatch(conditions, facts, viewerLogin);
  return isSlackFacts(facts)
    ? slackConditionsMatch(conditions, facts)
    : githubConditionsMatch(conditions, facts, viewerLogin);
}

/** The GitHub half of {@link workflowMatches}. */
function githubConditionsMatch(
  c: WorkflowConditions,
  facts: GithubEventFacts,
  viewerLogin: string | null | undefined
): boolean {
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

/** Whether one Slack message's author passes a rule's `slackAuthors`. */
export function slackAuthorMatches(
  match: WorkflowSlackAuthorMatch | undefined,
  facts: Pick<SlackEventFacts, 'userId' | 'authorLinked'>
): boolean {
  const kind = match?.kind ?? 'any';
  switch (kind) {
    case 'any':
      return true;
    case 'linked':
      return facts.authorLinked;
    case 'users': {
      const ids = normalizeList((match as { userIds?: string[] }).userIds);
      return ids.includes(facts.userId.trim().toLowerCase());
    }
  }
}

/**
 * The Slack half of {@link workflowMatches}.
 *
 * The team and the channel list are REQUIRED. A rule that lost either (a
 * hand-edited row, a bad migration) matches nothing, because "every channel in
 * every Slack team" is never what somebody wrote.
 */
function slackConditionsMatch(c: WorkflowConditions, facts: SlackEventFacts): boolean {
  const team = (c.slackTeamId ?? '').trim();
  if (!team || team !== facts.teamId) return false;

  const channels = normalizeList(c.channels);
  if (channels.length === 0 || !channels.includes(facts.channelId.trim().toLowerCase())) {
    return false;
  }

  if (isSlackThreadReply(facts) && c.includeThreadReplies !== true) return false;

  if (!slackAuthorMatches(c.slackAuthors, facts)) return false;

  const text = (c.textContains ?? '').trim().toLowerCase();
  if (text && !facts.text.toLowerCase().includes(text)) return false;

  return true;
}

/** Whether an issue's assignee passes a rule's `issueAssignee`. */
export function issueAssigneeMatches(
  match: IssueAssigneeMatch | undefined,
  facts: Pick<IssueEventFacts, 'assignee' | 'assigneeId' | 'assignedToApp' | 'unknownFields'>,
  viewerLogin?: string | null
): boolean {
  if (!match) return true;
  if (facts.unknownFields?.includes('assignee')) return false;
  const assignee = (facts.assignee ?? '').trim().toLowerCase();
  switch (match.kind) {
    case 'talyn':
      return facts.assignedToApp === true;
    case 'me': {
      const viewer = (viewerLogin ?? '').trim().toLowerCase();
      return viewer.length > 0 && viewer === assignee;
    }
    case 'unassigned':
      return !assignee && !facts.assigneeId && facts.assignedToApp !== true;
    case 'people': {
      const people = normalizeList(match.people);
      const id = (facts.assigneeId ?? '').trim().toLowerCase();
      return people.some((p) => (assignee && p === assignee) || (id && p === id));
    }
    default:
      return false;
  }
}

/**
 * The issue half of {@link workflowMatches}. Every list matches ANY of its
 * values, case-insensitive. A condition on a fact the payload lacked fails.
 *
 * A Linear rule must name its connection: a rule with none matches nothing,
 * because one workspace can connect several Linear organizations.
 */
export function issueConditionsMatch(
  c: WorkflowConditions,
  facts: IssueEventFacts,
  viewerLogin?: string | null
): boolean {
  const unknown = (f: IssueFactField): boolean => !!facts.unknownFields?.includes(f);
  const inList = (list: string[] | undefined, value: string | null | undefined, field?: IssueFactField): boolean => {
    const wanted = normalizeList(list);
    if (wanted.length === 0) return true;
    if (field && unknown(field)) return false;
    return !!value && wanted.includes(value.trim().toLowerCase());
  };

  if (facts.integration === 'linear') {
    const connection = (c.connectionId ?? '').trim();
    if (!connection || connection !== facts.connectionId) return false;
  }

  if (!inList(c.repos, facts.repoFullName)) return false;
  if (!inList(c.teams, facts.team, 'team')) return false;
  if (!inList(c.projects, facts.project, 'project')) return false;
  if (!inList(c.statuses, facts.status, 'status')) return false;
  if (!inList(c.priorities, facts.priority, 'priority')) return false;
  if (!inList(c.issueAuthors, facts.author)) return false;

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

  const labelName = (c.labelName ?? '').trim().toLowerCase();
  if (labelName && (facts.labelName ?? '').trim().toLowerCase() !== labelName) return false;

  if (!issueAssigneeMatches(c.issueAssignee, facts, viewerLogin)) return false;

  const title = (c.titleContains ?? '').trim().toLowerCase();
  if (title && !facts.title.toLowerCase().includes(title)) return false;

  // The issue description, and on `issue_commented` the new comment as well.
  const body = (c.bodyContains ?? '').trim().toLowerCase();
  if (body) {
    const inComment = !!facts.comment && facts.comment.body.toLowerCase().includes(body);
    const inBody = !unknown('body') && facts.body.toLowerCase().includes(body);
    if (!inComment && !inBody) return false;
  }

  return true;
}

// ============================================================================
// Webhook payload paths
// ============================================================================

/** One step of a payload path: an object key or an array index. */
export type WebhookPathStep = string | number;

/**
 * Parse a payload path (`a.b[0].c` or `a.b.0.c`) into steps, or null when it
 * is not a path. A key is letters, digits, `_`, `-` or `$`. A step that is all
 * digits is an index into an array and a key into an object.
 */
export function parseWebhookPath(path: string): WebhookPathStep[] | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const steps: WebhookPathStep[] = [];
  for (const segment of trimmed.split('.')) {
    const m = /^([A-Za-z0-9_$-]*)((?:\[\d+\])*)$/.exec(segment);
    if (!m) return null;
    const [, key, indices] = m;
    if (!key && !indices) return null;
    if (key) steps.push(/^\d+$/.test(key) ? Number(key) : key);
    for (const idx of indices.matchAll(/\[(\d+)\]/g)) steps.push(Number(idx[1]));
  }
  return steps;
}

/** The value at `path` in `payload`, or `undefined` when the path does not resolve. */
export function webhookValueAt(payload: unknown, path: string): unknown {
  const steps = parseWebhookPath(path);
  if (!steps) return undefined;
  let current: unknown = payload;
  for (const step of steps) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      const index = typeof step === 'number' ? step : /^\d+$/.test(step) ? Number(step) : NaN;
      if (!Number.isInteger(index) || index >= current.length) return undefined;
      current = current[index];
    } else {
      const key = String(step);
      if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
      current = (current as Record<string, unknown>)[key];
    }
  }
  return current;
}

/** A payload value as text, for `equals` and `contains`. Objects are JSON. */
function webhookValueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

/** Whether one payload condition passes. A path that does not resolve fails. */
export function webhookConditionPasses(payload: unknown, c: WebhookPayloadCondition): boolean {
  const value = webhookValueAt(payload, c.path);
  if (value === undefined) return false;
  switch (c.op) {
    case 'exists':
      return value !== null;
    case 'equals':
      if (value === null || c.value === undefined) return false;
      return webhookValueText(value) === c.value;
    case 'contains': {
      if (value === null || c.value === undefined) return false;
      const needle = c.value.toLowerCase();
      if (Array.isArray(value)) {
        return value.some(
          (item) => item !== null && typeof item !== 'object' && webhookValueText(item).toLowerCase() === needle
        );
      }
      if (typeof value === 'object') return false;
      return webhookValueText(value).toLowerCase().includes(needle);
    }
    default:
      return false;
  }
}

/** The webhook half of {@link workflowMatches}. Every payload condition must pass. */
export function webhookConditionsMatch(c: WorkflowConditions, facts: WebhookEventFacts): boolean {
  return (c.payloadMatches ?? []).every((condition) => webhookConditionPasses(facts.payload, condition));
}

// ============================================================================
// Comment templating
// ============================================================================

/** Values a template can use that do not come from the facts. */
export interface WorkflowTemplateExtras {
  /** The session a `start_session` action in the same run started. */
  sessionUrl?: string | null;
  /** The task a `start_task` action in the same run started. */
  taskUrl?: string | null;
  /** The pull request a merge write-back is about. */
  prUrl?: string | null;
}

/**
 * Interpolate `{{pr.number}}`-style placeholders in a comment or a reply.
 *
 * A deliberately tiny vocabulary — enough for a useful comment, and nothing
 * that reaches outside the facts we already hold. An unknown placeholder is
 * left VERBATIM rather than blanked: a comment that posts `{{pr.reviewer}}`
 * tells the user their template is wrong, where an empty string hides it. A
 * known placeholder with no value here (no permalink, no session yet) is left
 * verbatim for the same reason.
 *
 * GitHub facts: `pr.number`, `pr.title`, `pr.url`, `pr.author`,
 * `pr.baseBranch`, `pr.headBranch`, `repo`, `actor`, `event`.
 * Slack facts: `message.text`, `message.permalink`, `channel`, `event`.
 * Both: `session.url`, when a session was started.
 */
export function renderWorkflowTemplate(
  body: string,
  facts: WorkflowFacts,
  extras: WorkflowTemplateExtras = {}
): string {
  // A webhook's payload is never rendered here: a template's output is posted
  // where people read it, and only the prompt fence may carry sender text.
  const vars: Record<string, string> = isWebhookFacts(facts)
    ? { event: WORKFLOW_EVENT_LABELS[facts.event] }
    : isIssueFacts(facts)
    ? {
        // Identifiers only: a template's output is posted on the issue, and
        // the issue's own text has no place in Talyn's comment.
        'issue.identifier': facts.identifier,
        'issue.url': facts.url,
        'issue.title': facts.title,
        ...(facts.mergedPrUrl ? { 'pr.url': facts.mergedPrUrl } : {}),
        event: WORKFLOW_EVENT_LABELS[facts.event],
      }
    : isSlackFacts(facts)
    ? {
        'message.text': facts.text,
        ...(facts.permalink ? { 'message.permalink': facts.permalink } : {}),
        // Slack draws `<#C123>` as a link to the channel, so a reply reads
        // right even when the adapter could not resolve the name.
        channel: facts.channelName ? `#${facts.channelName}` : `<#${facts.channelId}>`,
        event: WORKFLOW_EVENT_LABELS[facts.event],
      }
    : {
        'pr.number': String(facts.number),
        'pr.title': facts.title,
        'pr.url': facts.url,
        'pr.author': facts.author.login,
        'pr.baseBranch': facts.baseBranch,
        'pr.headBranch': facts.headBranch,
        repo: facts.repoFullName,
        actor: facts.actor.login,
        event: WORKFLOW_EVENT_LABELS[facts.event],
      };
  if (extras.sessionUrl) vars['session.url'] = extras.sessionUrl;
  if (extras.taskUrl) vars['task.url'] = extras.taskUrl;
  if (extras.prUrl) vars['pr.url'] = extras.prUrl;
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) =>
    key in vars ? vars[key]! : whole
  );
}

/** The comment renderer under its old name. See {@link renderWorkflowTemplate}. */
export const renderWorkflowComment = renderWorkflowTemplate;

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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('automation must be an object');
  const w = raw as Record<string, unknown>;

  const name = typeof w.name === 'string' ? w.name.trim() : '';
  if (!name) fail('name must be a non-empty string');
  if (name.length > MAX_WORKFLOW_NAME_LENGTH) {
    fail(`name must be ${MAX_WORKFLOW_NAME_LENGTH} characters or fewer`);
  }

  if (w.enabled !== undefined && typeof w.enabled !== 'boolean') {
    fail('enabled must be a boolean');
  }

  if (w.integration !== undefined && w.integration !== null && !isWorkflowIntegration(w.integration)) {
    fail(`integration must be one of ${WORKFLOW_INTEGRATIONS.join(', ')}`);
  }
  const integration = workflowIntegrationOf(w as { integration?: WorkflowIntegration | null });

  const events = stringList(w.events, 'events') as WorkflowTriggerEvent[];
  if (events.length === 0) fail('an automation needs at least one trigger event');
  for (const e of events) validateEvent(e, integration);

  const conditions =
    integration === 'slack'
      ? validateSlackConditions(w.conditions)
      : integration === 'webhook'
        ? validateWebhookConditions(w.conditions)
        : isIssueWorkflowIntegration(integration)
          ? validateIssueConditions(w.conditions, integration, events)
          : validateConditions(w.conditions, events);
  const actions = validateActions(w.actions, integration);
  if (isIssueWorkflowIntegration(integration)) {
    const starts = actions.filter((a) => a.type === 'start_session' || a.type === 'start_task');
    // One issue gets one piece of work. A second start in the same run would
    // start a second session on the same issue.
    if (starts.length > 1) fail('An issue automation can start one session or one task, not more.');
  }

  let maxRuns = DEFAULT_WORKFLOW_RUNS_PER_PR_PER_HOUR;
  if (w.maxRunsPerPrPerHour !== undefined) {
    const n = w.maxRunsPerPrPerHour;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      fail('maxRunsPerPrPerHour must be a whole number of 1 or more');
    }
    maxRuns = n;
  }

  return {
    integration,
    name,
    enabled: w.enabled === undefined ? true : (w.enabled as boolean),
    events,
    conditions,
    actions,
    maxRunsPerPrPerHour: maxRuns,
  };
}

/** Refuse an event that is unknown, or that belongs to another integration. */
function validateEvent(event: string, integration: WorkflowIntegration): void {
  const own = workflowEventsFor(integration) as readonly string[];
  if (own.includes(event)) return;
  const other = WORKFLOW_INTEGRATIONS.find(
    (i) => i !== integration && (workflowEventsFor(i) as readonly string[]).includes(event)
  );
  if (other) {
    const otherLabel = WORKFLOW_INTEGRATION_LABELS[other];
    fail(
      `"${event}" is a ${otherLabel} event, and this is a ` +
        `${WORKFLOW_INTEGRATION_LABELS[integration]} automation. Make a ${otherLabel} automation for it instead.`
    );
  }
  fail(
    integration === 'github'
      ? `"${event}" is not a PR event Talyn can trigger on`
      : `"${event}" is not a ${WORKFLOW_INTEGRATION_LABELS[integration]} event Talyn can trigger on`
  );
}

/** Refuse a condition that belongs to another integration, with a message that names it. */
function refuseForeignConditions(
  c: Record<string, unknown>,
  integration: WorkflowIntegration
): void {
  // `targetIsViewer` is the legacy GitHub field that `target` replaced.
  const keysOf = (i: WorkflowIntegration): readonly string[] =>
    i === 'github' ? [...workflowConditionKeysFor(i), 'targetIsViewer'] : workflowConditionKeysFor(i);
  for (const key of Object.keys(c)) {
    if (keysOf(integration).includes(key)) continue;
    const other = WORKFLOW_INTEGRATIONS.find((i) => i !== integration && keysOf(i).includes(key));
    if (!other) continue;
    fail(
      `"${key}" is a ${WORKFLOW_INTEGRATION_LABELS[other]} condition, and this is a ` +
        `${WORKFLOW_INTEGRATION_LABELS[integration]} automation. Remove it.`
    );
  }
}

/**
 * A webhook rule's conditions: an optional list of payload tests. No
 * conditions is legal and means every request to the rule's URL.
 */
function validateWebhookConditions(raw: unknown): WorkflowConditions {
  const given = raw === undefined || raw === null ? {} : raw;
  if (typeof given !== 'object' || Array.isArray(given)) fail('conditions must be an object');
  const c = given as Record<string, unknown>;

  refuseForeignConditions(c, 'webhook');
  const unknown = Object.keys(c).filter(
    (k) => !(WEBHOOK_WORKFLOW_CONDITION_KEYS as readonly string[]).includes(k)
  );
  if (unknown.length > 0) fail(`Unknown condition "${unknown[0]}"`);

  if (c.payloadMatches === undefined) return {};
  if (!Array.isArray(c.payloadMatches)) fail('conditions.payloadMatches must be an array');
  const out: WebhookPayloadCondition[] = c.payloadMatches.map((entry, i) =>
    validatePayloadCondition(entry, `conditions.payloadMatches[${i}]`)
  );
  return out.length > 0 ? { payloadMatches: out } : {};
}

function validatePayloadCondition(raw: unknown, at: string): WebhookPayloadCondition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${at} must be an object`);
  const r = raw as Record<string, unknown>;
  const path = typeof r.path === 'string' ? r.path.trim() : '';
  if (!path) fail(`${at}.path must be a non-empty string, like "issue.title"`);
  if (!parseWebhookPath(path)) {
    fail(`${at}.path "${path}" is not a path. Use keys and indexes, like "issue.labels[0].name".`);
  }
  const op = r.op;
  if (typeof op !== 'string' || !(WEBHOOK_PAYLOAD_OPS as readonly string[]).includes(op)) {
    fail(`${at}.op must be one of ${WEBHOOK_PAYLOAD_OPS.join(', ')}`);
  }
  if (op === 'exists') return { path, op: 'exists' };
  if (typeof r.value !== 'string') fail(`${at}.value must be a string`);
  if (op === 'contains' && !r.value.trim()) fail(`${at}.value must not be empty`);
  return { path, op: op as WebhookPayloadOp, value: r.value };
}

/**
 * An issue rule's conditions. A Linear rule must name its connection. A
 * condition that belongs to the other tracker is refused with its name.
 */
function validateIssueConditions(
  raw: unknown,
  integration: IssueWorkflowIntegration,
  events: WorkflowTriggerEvent[]
): WorkflowConditions {
  const given = raw === undefined || raw === null ? {} : raw;
  if (typeof given !== 'object' || Array.isArray(given)) fail('conditions must be an object');
  const c = given as Record<string, unknown>;
  const label = WORKFLOW_INTEGRATION_LABELS[integration];

  const own = workflowConditionKeysFor(integration);
  const otherIssue = integration === 'linear' ? 'github_issues' : 'linear';
  for (const key of Object.keys(c)) {
    if (own.includes(key)) continue;
    if (workflowConditionKeysFor(otherIssue).includes(key)) {
      fail(`"${key}" is a ${WORKFLOW_INTEGRATION_LABELS[otherIssue]} condition, and this is a ${label} automation. Remove it.`);
    }
  }
  refuseForeignConditions(c, integration);
  const unknownKeys = Object.keys(c).filter((k) => !own.includes(k));
  if (unknownKeys.length > 0) fail(`Unknown condition "${unknownKeys[0]}"`);

  const out: WorkflowConditions = {};
  if (integration === 'linear') {
    const connection = typeof c.connectionId === 'string' ? c.connectionId.trim() : '';
    if (c.connectionId !== undefined && typeof c.connectionId !== 'string') {
      fail('conditions.connectionId must be a string');
    }
    if (!connection) fail('A Linear automation needs a Linear workspace. Pick the Linear workspace to watch.');
    out.connectionId = connection;
  }

  const lists = ['repos', 'teams', 'projects', 'statuses', 'priorities', 'labelsAny', 'labelsAll', 'labelsNone', 'issueAuthors'] as const;
  for (const key of lists) {
    if (!own.includes(key)) continue;
    const list = optionalStringList(c[key], `conditions.${key}`);
    if (list) out[key] = list;
  }

  for (const key of ['titleContains', 'bodyContains', 'labelName'] as const) {
    if (c[key] === undefined) continue;
    if (typeof c[key] !== 'string') fail(`conditions.${key} must be a string`);
    const trimmed = (c[key] as string).trim();
    if (!trimmed) continue;
    if (key === 'labelName' && !events.includes('issue_labeled')) {
      fail(`"labelName" only applies to ${WORKFLOW_EVENT_LABELS.issue_labeled}, which this automation does not trigger on`);
    }
    out[key] = trimmed;
  }

  if (c.issueAssignee !== undefined) {
    const match = validateIssueAssignee(c.issueAssignee, integration);
    if (match) out.issueAssignee = match;
  }
  return out;
}

function validateIssueAssignee(raw: unknown, integration: IssueWorkflowIntegration): IssueAssigneeMatch | undefined {
  const at = 'conditions.issueAssignee';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${at} must be an object`);
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === 'any') return undefined;
  if (typeof kind !== 'string' || !(ISSUE_ASSIGNEE_KINDS as readonly string[]).includes(kind)) {
    fail(`${at}.kind must be one of ${ISSUE_ASSIGNEE_KINDS.join(', ')}`);
  }
  if (kind === 'talyn' && integration !== 'linear') {
    fail('Only a Linear issue can be assigned to Talyn. On GitHub, choose "Me" or specific people.');
  }
  if (kind === 'me' && integration !== 'github_issues') {
    fail('"Me" works on GitHub Issues only. On Linear, choose Talyn or specific people.');
  }
  if (kind === 'people') {
    const people = stringList((raw as { people?: unknown }).people ?? [], `${at}.people`);
    if (people.length === 0) fail(`${at} names nobody, so it can never match`);
    return { kind: 'people', people };
  }
  return { kind: kind as 'talyn' | 'me' | 'unassigned' };
}

/** The write-back settings of an issue rule's start action. Only `false` is stored. */
function validateIssueWriteBack(
  a: Record<string, unknown>,
  at: string,
  integration: WorkflowIntegration
): IssueWriteBackSettings {
  const out: IssueWriteBackSettings = {};
  for (const key of ['issueStartComment', 'issueDoneOnMerge'] as const) {
    if (a[key] === undefined) continue;
    if (typeof a[key] !== 'boolean') fail(`${at}.${key} must be a boolean`);
    if (!isIssueWorkflowIntegration(integration)) {
      fail(`${at}.${key} is for issue automations (Linear, GitHub Issues)`);
    }
    if (a[key] === false) out[key] = false;
  }
  return out;
}

/**
 * A Slack rule's conditions. The team and at least one channel are REQUIRED:
 * a Slack rule that watches "every channel" is never what somebody meant, and
 * the Slack source finds a rule's workspace by its team.
 */
function validateSlackConditions(raw: unknown): WorkflowConditions {
  const given = raw === undefined || raw === null ? {} : raw;
  if (typeof given !== 'object' || Array.isArray(given)) fail('conditions must be an object');
  const c = given as Record<string, unknown>;

  refuseForeignConditions(c, 'slack');
  const unknown = Object.keys(c).filter(
    (k) => !(SLACK_WORKFLOW_CONDITION_KEYS as readonly string[]).includes(k)
  );
  if (unknown.length > 0) fail(`Unknown condition "${unknown[0]}"`);

  const out: WorkflowConditions = {};

  if (c.slackTeamId !== undefined && typeof c.slackTeamId !== 'string') {
    fail('conditions.slackTeamId must be a string');
  }
  const team = typeof c.slackTeamId === 'string' ? c.slackTeamId.trim() : '';
  if (!team) fail('A Slack automation needs a Slack workspace. Pick the Slack workspace to watch.');
  out.slackTeamId = team;

  const channels = c.channels === undefined ? [] : stringList(c.channels, 'conditions.channels');
  if (channels.length === 0) fail('A Slack automation needs at least one channel to watch.');
  out.channels = channels;

  if (c.textContains !== undefined) {
    if (typeof c.textContains !== 'string') fail('conditions.textContains must be a string');
    const trimmed = c.textContains.trim();
    if (trimmed) out.textContains = trimmed;
  }

  if (c.slackAuthors !== undefined) {
    const authors = validateSlackAuthors(c.slackAuthors);
    if (authors) out.slackAuthors = authors;
  }

  if (c.includeThreadReplies !== undefined) {
    if (typeof c.includeThreadReplies !== 'boolean') {
      fail('conditions.includeThreadReplies must be a boolean');
    }
    // Only `true` is stored: absent already means "top-level messages only".
    if (c.includeThreadReplies) out.includeThreadReplies = true;
  }

  return out;
}

function validateSlackAuthors(raw: unknown): WorkflowSlackAuthorMatch | undefined {
  const at = 'conditions.slackAuthors';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${at} must be an object`);
  const kind = (raw as { kind?: unknown }).kind;
  if (
    typeof kind !== 'string' ||
    !(WORKFLOW_SLACK_AUTHOR_KINDS as readonly string[]).includes(kind)
  ) {
    fail(`${at}.kind must be one of ${WORKFLOW_SLACK_AUTHOR_KINDS.join(', ')}`);
  }
  if (kind === 'users') {
    const userIds = stringList((raw as { userIds?: unknown }).userIds ?? [], `${at}.userIds`);
    if (userIds.length === 0) fail(`${at} names no Slack users, so it can never match`);
    return { kind: 'users', userIds };
  }
  // `any` is the default, so it is dropped: the stored jsonb holds only what
  // differs from it. `linked` is kept, because it NARROWS the rule.
  if (kind === 'any') return undefined;
  return { kind: 'linked' };
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
  refuseForeignConditions(c, 'github');
  const unknown = Object.keys(c).filter((k) => !known.includes(k));
  if (unknown.length > 0) fail(`Unknown condition "${unknown[0]}"`);

  const appliesTo = (allowed: readonly WorkflowTriggerEvent[], field: string): void => {
    if (!events.some((e) => allowed.includes(e))) {
      const names = allowed.map((e) => WORKFLOW_EVENT_LABELS[e]).join(', ');
      fail(`"${field}" only applies to ${names}, which this automation does not trigger on`);
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

function validateActions(raw: unknown, integration: WorkflowIntegration): WorkflowAction[] {
  if (!Array.isArray(raw)) fail('actions must be an array');
  if (raw.length === 0) fail('an automation needs at least one action');
  return raw.map((entry, i) => validateAction(entry, `actions[${i}]`, integration));
}

function validateAction(
  raw: unknown,
  at: string,
  integration: WorkflowIntegration
): WorkflowAction {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${at} must be an object`);
  const a = raw as Record<string, unknown>;
  const type = a.type;
  if (typeof type !== 'string' || !(ALL_WORKFLOW_ACTION_TYPES as readonly string[]).includes(type)) {
    fail(
      integration === 'github'
        ? `${at}.type is not an action Talyn can take on a PR`
        : `${at}.type is not an action a ${WORKFLOW_INTEGRATION_LABELS[integration]} automation can take`
    );
  }
  if (!(workflowActionsFor(integration) as readonly string[]).includes(type)) {
    const label = WORKFLOW_ACTION_LABELS[type as WorkflowActionType];
    const allowed = workflowActionsFor(integration)
      .map((t) => `"${WORKFLOW_ACTION_LABELS[t]}"`)
      .join(', ');
    const reason = (SLACK_WORKFLOW_ACTION_TYPES as readonly string[]).includes(type)
      ? 'acts on a Slack message'
      : (INBOUND_WORKFLOW_ACTION_TYPES as readonly string[]).includes(type)
        ? 'is for webhook and issue automations'
        : (ISSUE_WORKFLOW_ACTION_TYPES as readonly string[]).includes(type)
          ? 'acts on an issue'
          : 'acts on a pull request';
    fail(
      `${at}: "${label}" ${reason}, so a ${WORKFLOW_INTEGRATION_LABELS[integration]} automation ` +
        `cannot use it. Use ${allowed}.`
    );
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
          'An automation cannot run a local skill. Local skills stay on your machine. Talyn runs ' +
            'automations on the server. Use a repository skill or one saved to the workspace.'
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
    case 'run_code_review': {
      const p = a.preset;
      // Absent is the normal case and means "whatever the workspace has chosen",
      // which is what keeps an old workflow following a team's current setting
      // rather than a depth frozen on the day it was saved.
      if (p !== undefined && !isCodeReviewPreset(p)) {
        fail(`${at}.preset must be quick, standard or deep`);
      }
      return {
        type: 'run_code_review',
        ...(p ? { preset: p as CodeReviewPreset } : {}),
      };
    }
    case 'start_session': {
      if (typeof a.prompt !== 'string' || !a.prompt.trim()) {
        fail(`${at}.prompt must be a non-empty string`);
      }
      let repositoryId: string | null = null;
      if (a.repositoryId !== undefined && a.repositoryId !== null) {
        if (typeof a.repositoryId !== 'string') fail(`${at}.repositoryId must be a string or null`);
        repositoryId = a.repositoryId.trim() || null;
      }
      // A Slack rule can leave the repository to Talyn: it reads the message
      // to choose one. A GitHub Issues rule defaults to the issue's own
      // repository. A webhook or a Linear issue has nothing to choose from.
      if ((integration === 'webhook' || integration === 'linear') && !repositoryId) {
        fail(`${at}: choose the repository the session works on`);
      }
      if (a.internetAccess !== undefined && typeof a.internetAccess !== 'boolean') {
        fail(`${at}.internetAccess must be a boolean`);
      }
      const model = typeof a.model === 'string' && a.model.trim() ? a.model.trim() : undefined;
      return {
        type: 'start_session',
        repositoryId,
        prompt: a.prompt.trim(),
        ...(model ? { model } : {}),
        ...(a.internetAccess === true ? { internetAccess: true } : {}),
        ...validateIssueWriteBack(a, at, integration),
      };
    }
    case 'slack_reply': {
      if (typeof a.text !== 'string' || !a.text.trim()) {
        fail(`${at}.text must be a non-empty string`);
      }
      return { type: 'slack_reply', text: a.text.trim() };
    }
    case 'slack_react': {
      if (typeof a.emoji !== 'string') fail(`${at}.emoji must be a string`);
      // People type `:eyes:` as often as `eyes`. Slack's API wants the bare name.
      const emoji = a.emoji.trim().replace(/^:+|:+$/g, '');
      if (!emoji || /\s/.test(emoji)) {
        fail(`${at}.emoji must be one emoji name, like "eyes" or ":white_check_mark:"`);
      }
      return { type: 'slack_react', emoji };
    }
    case 'start_task': {
      if (typeof a.prompt !== 'string' || !a.prompt.trim()) {
        fail(`${at}.prompt must be a non-empty string`);
      }
      if (a.repositoryId !== undefined && a.repositoryId !== null && typeof a.repositoryId !== 'string') {
        fail(`${at}.repositoryId must be a string or null`);
      }
      const repositoryId = typeof a.repositoryId === 'string' ? a.repositoryId.trim() : '';
      // Only a GitHub Issues rule may leave it out: the issue's own repository.
      if (!repositoryId && integration !== 'github_issues') fail(`${at}: choose the repository the task works on`);
      if (a.internetAccess !== undefined && typeof a.internetAccess !== 'boolean') {
        fail(`${at}.internetAccess must be a boolean`);
      }
      const model = typeof a.model === 'string' && a.model.trim() ? a.model.trim() : undefined;
      return {
        type: 'start_task',
        repositoryId: repositoryId || null,
        prompt: a.prompt.trim(),
        ...(model ? { model } : {}),
        ...(a.internetAccess === true ? { internetAccess: true } : {}),
        ...validateIssueWriteBack(a, at, integration),
      };
    }
    case 'issue_comment': {
      if (typeof a.body !== 'string' || !a.body.trim()) fail(`${at}.body must be a non-empty string`);
      // `afterStart` is Talyn's own marker and is never stored.
      return { type: 'issue_comment', body: a.body.trim() };
    }
    case 'issue_set_status': {
      if (typeof a.status !== 'string' || !a.status.trim()) {
        fail(`${at}.status must be a status name, or "done"`);
      }
      const status = a.status.trim();
      if (integration === 'github_issues' && !['done', 'open', 'closed'].includes(status.toLowerCase())) {
        fail(`${at}.status must be done, open or closed on GitHub Issues`);
      }
      return { type: 'issue_set_status', status: integration === 'github_issues' ? status.toLowerCase() : status };
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
 * Whether Slack rules should be drawn. The same three-state discipline as
 * {@link workflowsOffered}, and also not authorisation: the routes and the
 * engine gate on the `slackChannelRules` flag themselves.
 */
export function slackRulesOffered(
  features: { workflows?: boolean; slackChannelRules?: boolean } | null | undefined
): boolean {
  return workflowsOffered(features) && features?.slackChannelRules === true;
}

/**
 * Whether webhook rules should be drawn. The same three-state discipline as
 * {@link workflowsOffered}, and also not authorisation: the routes, the
 * receiver and the engine gate on the `webhookRules` flag themselves.
 */
export function webhookRulesOffered(
  features: { workflows?: boolean; webhookRules?: boolean } | null | undefined
): boolean {
  return workflowsOffered(features) && features?.webhookRules === true;
}

/**
 * Whether issue rules (Linear, GitHub Issues) should be drawn. The same
 * three-state discipline as {@link workflowsOffered}, and also not
 * authorisation: the routes and the engine gate on the `issueRules` flag.
 */
export function issueRulesOffered(
  features: { workflows?: boolean; issueRules?: boolean } | null | undefined
): boolean {
  return workflowsOffered(features) && features?.issueRules === true;
}

/**
 * A blank workflow the editor opens on. Save stays refused until it has a name
 * and at least one action — see {@link workflowInputProblem}. A Slack rule also
 * needs its Slack workspace and a channel.
 */
export function emptyWorkflowInput(integration: WorkflowIntegration = 'github'): WorkflowInput {
  if (isIssueWorkflowIntegration(integration)) {
    return {
      integration,
      name: '',
      enabled: true,
      events: ['issue_created'],
      conditions: {},
      actions: [],
      maxRunsPerPrPerHour: DEFAULT_WORKFLOW_RUNS_PER_PR_PER_HOUR,
    };
  }
  if (integration === 'webhook') {
    return {
      integration: 'webhook',
      name: '',
      enabled: true,
      events: ['webhook_received'],
      conditions: {},
      actions: [],
      maxRunsPerPrPerHour: DEFAULT_WORKFLOW_RUNS_PER_PR_PER_HOUR,
    };
  }
  if (integration === 'slack') {
    return {
      integration: 'slack',
      name: '',
      enabled: true,
      events: ['slack_message'],
      conditions: {},
      actions: [],
      maxRunsPerPrPerHour: DEFAULT_WORKFLOW_RUNS_PER_PR_PER_HOUR,
    };
  }
  return {
    integration: 'github',
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
    integration: workflowIntegrationOf(workflow),
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
    case 'run_code_review':
      // No preset, so a new row inherits the workspace default until somebody
      // deliberately pins one.
      return { type: 'run_code_review' };
    case 'start_session':
      return { type: 'start_session', repositoryId: null, prompt: '' };
    case 'slack_reply':
      return { type: 'slack_reply', text: '' };
    case 'slack_react':
      return { type: 'slack_react', emoji: 'eyes' };
    case 'start_task':
      return { type: 'start_task', repositoryId: '', prompt: '' };
    case 'issue_comment':
      return { type: 'issue_comment', body: '' };
    case 'issue_set_status':
      return { type: 'issue_set_status', status: 'done' };
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
    hint: 'Only these repositories. Leave an automation without this to cover every repository the workspace watches.',
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
    hint: 'Carrying any one of them stops the automation.',
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

/** The widget a Slack condition is edited with. */
export type SlackWorkflowConditionInput =
  | 'slackTeam'
  | 'channels'
  | 'text'
  | 'slackAuthors'
  | 'threadReplies';

export interface SlackWorkflowConditionSpec {
  key: (typeof SLACK_WORKFLOW_CONDITION_KEYS)[number];
  label: string;
  hint: string;
  input: SlackWorkflowConditionInput;
  /** The validator refuses a Slack rule without it. */
  required: boolean;
}

/**
 * Every condition a Slack rule can carry, as data — the Slack counterpart of
 * {@link WORKFLOW_CONDITION_SPECS}. Kept apart because the GitHub editor builds
 * its menu from that list, and a Slack field there could only be refused.
 */
export const SLACK_WORKFLOW_CONDITION_SPECS: readonly SlackWorkflowConditionSpec[] = [
  {
    key: 'slackTeamId',
    label: 'Slack workspace',
    hint: 'The Slack workspace to watch. Talyn must be installed there.',
    input: 'slackTeam',
    required: true,
  },
  {
    key: 'channels',
    label: 'Channels',
    hint: 'A message in any of these channels can trigger the automation. Invite Talyn to a channel first.',
    input: 'channels',
    required: true,
  },
  {
    key: 'slackAuthors',
    label: 'Who can trigger it',
    hint: 'By default, anyone in the channel, apps and bots included.',
    input: 'slackAuthors',
    required: false,
  },
  {
    key: 'textContains',
    label: 'Message contains',
    hint: 'Case-insensitive.',
    input: 'text',
    required: false,
  },
  {
    key: 'includeThreadReplies',
    label: 'Replies in threads',
    hint: 'By default, only new messages in the channel trigger the automation, not replies.',
    input: 'threadReplies',
    required: false,
  },
];

/** The widget a webhook condition is edited with. */
export type WebhookWorkflowConditionInput = 'payloadMatches';

export interface WebhookWorkflowConditionSpec {
  key: (typeof WEBHOOK_WORKFLOW_CONDITION_KEYS)[number];
  label: string;
  hint: string;
  input: WebhookWorkflowConditionInput;
  required: boolean;
}

/** Every condition a webhook rule can carry, as data. */
export const WEBHOOK_WORKFLOW_CONDITION_SPECS: readonly WebhookWorkflowConditionSpec[] = [
  {
    key: 'payloadMatches',
    label: 'Payload matches',
    hint:
      'Tests on the JSON body, like "action equals opened" or "issue.labels contains bug". ' +
      'Every test must pass. Without tests, every request starts the automation.',
    input: 'payloadMatches',
    required: false,
  },
];

/** The widget an issue condition is edited with. */
export type IssueWorkflowConditionInput =
  | 'connection'
  | 'repos'
  | 'teams'
  | 'projects'
  | 'statuses'
  | 'priorities'
  | 'labels'
  | 'label'
  | 'assignee'
  | 'people'
  | 'text';

export interface IssueWorkflowConditionSpec {
  key: (typeof LINEAR_WORKFLOW_CONDITION_KEYS)[number] | (typeof GITHUB_ISSUES_WORKFLOW_CONDITION_KEYS)[number];
  label: string;
  hint: string;
  input: IssueWorkflowConditionInput;
  required: boolean;
  /** The integrations that have this condition. */
  integrations: readonly IssueWorkflowIntegration[];
  /** Events it applies to, or null for every issue event. */
  appliesTo: readonly WorkflowTriggerEvent[] | null;
}

/** Every condition an issue rule can carry, as data. */
export const ISSUE_WORKFLOW_CONDITION_SPECS: readonly IssueWorkflowConditionSpec[] = [
  {
    key: 'connectionId',
    label: 'Linear workspace',
    hint: 'The Linear workspace to watch.',
    input: 'connection',
    required: true,
    integrations: ['linear'],
    appliesTo: null,
  },
  {
    key: 'repos',
    label: 'Repository',
    hint: 'Only issues in these repositories. Without this, every repository the workspace watches.',
    input: 'repos',
    required: false,
    integrations: ['github_issues'],
    appliesTo: null,
  },
  {
    key: 'teams',
    label: 'Team',
    hint: 'Only issues in these Linear teams.',
    input: 'teams',
    required: false,
    integrations: ['linear'],
    appliesTo: null,
  },
  {
    key: 'projects',
    label: 'Project',
    hint: 'Only issues in these Linear projects.',
    input: 'projects',
    required: false,
    integrations: ['linear'],
    appliesTo: null,
  },
  {
    key: 'statuses',
    label: 'Status',
    hint: 'Only issues in one of these statuses.',
    input: 'statuses',
    required: false,
    integrations: ['linear', 'github_issues'],
    appliesTo: null,
  },
  {
    key: 'priorities',
    label: 'Priority',
    hint: 'Only issues with one of these priorities.',
    input: 'priorities',
    required: false,
    integrations: ['linear'],
    appliesTo: null,
  },
  {
    key: 'labelsAny',
    label: 'Has any of these labels',
    hint: 'Matches when the issue has at least one.',
    input: 'labels',
    required: false,
    integrations: ['linear', 'github_issues'],
    appliesTo: null,
  },
  {
    key: 'labelsAll',
    label: 'Has all of these labels',
    hint: 'Matches only when the issue has every one.',
    input: 'labels',
    required: false,
    integrations: ['linear', 'github_issues'],
    appliesTo: null,
  },
  {
    key: 'labelsNone',
    label: 'Has none of these labels',
    hint: 'Any one of them stops the automation.',
    input: 'labels',
    required: false,
    integrations: ['linear', 'github_issues'],
    appliesTo: null,
  },
  {
    key: 'labelName',
    label: 'The label that was added',
    hint: 'Only when this exact label was added.',
    input: 'label',
    required: false,
    integrations: ['linear', 'github_issues'],
    appliesTo: ['issue_labeled'],
  },
  {
    key: 'issueAssignee',
    label: 'Assigned to',
    hint: 'Who the issue is assigned to.',
    input: 'assignee',
    required: false,
    integrations: ['linear', 'github_issues'],
    appliesTo: null,
  },
  {
    key: 'issueAuthors',
    label: 'Opened by',
    hint: 'GitHub logins of the people who opened the issue.',
    input: 'people',
    required: false,
    integrations: ['github_issues'],
    appliesTo: null,
  },
  {
    key: 'titleContains',
    label: 'Title contains',
    hint: 'Case-insensitive.',
    input: 'text',
    required: false,
    integrations: ['linear', 'github_issues'],
    appliesTo: null,
  },
  {
    key: 'bodyContains',
    label: 'Description or comment contains',
    hint: 'Case-insensitive. On a new comment, the comment counts too.',
    input: 'text',
    required: false,
    integrations: ['linear', 'github_issues'],
    appliesTo: null,
  },
];

/** The issue condition specs of one tracker. */
export function issueConditionSpecsFor(integration: IssueWorkflowIntegration): IssueWorkflowConditionSpec[] {
  return ISSUE_WORKFLOW_CONDITION_SPECS.filter((spec) => spec.integrations.includes(integration));
}

/** A fresh payload test for the editor. Empty, so it saves as nothing until filled in. */
export function emptyWebhookPayloadCondition(): WebhookPayloadCondition {
  return { path: '', op: 'equals', value: '' };
}

/** One condition as a vocabulary listing shows it. */
export interface WorkflowConditionSummary {
  key: keyof WorkflowConditions;
  label: string;
  hint: string;
  required: boolean;
  /** Events the condition applies to, or `null` for every event of the integration. */
  appliesTo: readonly WorkflowTriggerEvent[] | null;
}

/** What one integration's rules can trigger on, test and do. */
export interface WorkflowVocabulary {
  integration: WorkflowIntegration;
  events: ReadonlyArray<{ event: WorkflowTriggerEvent; label: string }>;
  conditions: readonly WorkflowConditionSummary[];
  actions: ReadonlyArray<{ type: WorkflowActionType; label: string }>;
}

/**
 * The events, conditions and actions of one integration.
 *
 * The same lists {@link validateWorkflow} accepts for a rule of that
 * integration, so a client or an agent that builds a rule from this listing
 * cannot compose one the API then refuses on vocabulary grounds.
 */
export function workflowVocabulary(integration: WorkflowIntegration): WorkflowVocabulary {
  const events = workflowEventsFor(integration).map((event) => ({
    event,
    label: WORKFLOW_EVENT_LABELS[event],
  }));
  const actions = workflowActionsFor(integration).map((type) => ({
    type,
    label: WORKFLOW_ACTION_LABELS[type],
  }));
  const conditions: WorkflowConditionSummary[] =
    isIssueWorkflowIntegration(integration)
      ? issueConditionSpecsFor(integration).map((spec) => ({
          key: spec.key,
          label: spec.label,
          hint: spec.hint,
          required: spec.required,
          appliesTo: spec.appliesTo,
        }))
      : integration === 'webhook'
      ? WEBHOOK_WORKFLOW_CONDITION_SPECS.map((spec) => ({
          key: spec.key,
          label: spec.label,
          hint: spec.hint,
          required: spec.required,
          appliesTo: null,
        }))
      : integration === 'slack'
      ? SLACK_WORKFLOW_CONDITION_SPECS.map((spec) => ({
          key: spec.key,
          label: spec.label,
          hint: spec.hint,
          required: spec.required,
          appliesTo: null,
        }))
      : WORKFLOW_CONDITION_SPECS.map((spec) => ({
          key: spec.key,
          label: spec.label,
          hint: spec.hint,
          required: false,
          appliesTo: spec.appliesTo,
        }));
  return { integration, events, conditions, actions };
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
    return err instanceof Error ? err.message : 'This automation is not valid';
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
    case 'run_code_review':
      return action.preset
        ? `Run a ${action.preset} code review`
        : 'Run a code review';
    case 'start_session':
      return 'Start a session';
    case 'slack_reply':
      return 'Reply in the thread';
    case 'slack_react':
      return `React with :${action.emoji}:`;
    case 'start_task':
      return 'Start a task';
    case 'issue_comment':
      return action.afterStart ? 'Comment that the work started' : 'Comment on the issue';
    case 'issue_set_status':
      return action.status === 'done' ? 'Move the issue to done' : `Move the issue to ${action.status}`;
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
  // Not "Failed": the work is owed, and saying so is the difference between
  // "Talyn dropped this" and "Talyn is waiting for GitHub".
  pending_retry: 'Waiting to retry',
  succeeded: 'Done',
  partial: 'Partly done',
  failed: 'Failed',
  skipped: 'Stood down',
};
