import type { IssueEventFacts, IssueWorkflowEvent, WorkflowDefinition } from '@talyn/shared';
import { MAX_ISSUE_FACT_TEXT } from '@talyn/shared';
import { debugBus } from '../../debugBus.js';
import { githubService } from '../../github.js';
import { githubRateGate } from '../../githubRateGate.js';
import { classifyAutoMergeActor } from '../../githubAutoMerge.js';
import { isOurComment } from '../../inbound/issueLinks.js';
import type { WatchTarget } from '../../webhookIndex.js';
import type { WebhookDelivery } from '../../webhookPayload.js';
import { workspaceMayUseIssueRules } from '../../workflowsAccess.js';
import type { WorkflowSourceAdapter } from '../source.js';

/**
 * The GitHub Issues source adapter: `issues` and `issue_comment` deliveries in,
 * issue facts out.
 *
 * No new auth and no new route: the GitHub App already delivers both events
 * through `processWebhookDelivery`, which calls this beside the pull request
 * rules, with the workspaces that watch the repository. An `issue_comment` on
 * a pull request is a PR comment and belongs to the GitHub source, so it is
 * ignored here.
 */

export interface GithubIssuesWorkflowInput {
  delivery: WebhookDelivery;
  targets: WatchTarget[];
}

interface RawUser {
  login?: unknown;
  id?: unknown;
}

interface RawIssue {
  id?: unknown;
  number?: unknown;
  title?: unknown;
  body?: unknown;
  html_url?: unknown;
  state?: unknown;
  labels?: unknown;
  assignee?: RawUser | null;
  user?: RawUser | null;
  pull_request?: unknown;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function cut(text: string): string {
  return text.length > MAX_ISSUE_FACT_TEXT ? text.slice(0, MAX_ISSUE_FACT_TEXT) : text;
}

function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((l) => (l as { name?: unknown } | null)?.name).filter((n): n is string => typeof n === 'string');
}

const ISSUE_ACTION_EVENTS: Record<string, IssueWorkflowEvent> = {
  opened: 'issue_created',
  labeled: 'issue_labeled',
  assigned: 'issue_assigned',
  closed: 'issue_status_changed',
  reopened: 'issue_status_changed',
  edited: 'issue_updated',
};

/**
 * PURE: the facts one GitHub delivery yields. `[]` for anything that is not an
 * issue event a rule can trigger on, including every comment on a pull
 * request. Never throws.
 */
export function githubIssueFactsFromDelivery(delivery: WebhookDelivery): IssueEventFacts[] {
  const { eventType, action, payload, repoFullName } = delivery;
  if (!repoFullName) return [];
  const issue = payload.issue as RawIssue | undefined;
  if (!issue || issue.pull_request) return [];
  const number = typeof issue.number === 'number' ? issue.number : null;
  const id = typeof issue.id === 'number' || typeof issue.id === 'string' ? String(issue.id) : '';
  if (number === null || !id) return [];

  let event: IssueWorkflowEvent | undefined;
  let comment: IssueEventFacts['comment'];
  let labelName: string | undefined;
  if (eventType === 'issues') {
    event = action ? ISSUE_ACTION_EVENTS[action] : undefined;
    if (event === 'issue_labeled') labelName = str((payload.label as { name?: unknown } | undefined)?.name) || undefined;
  } else if (eventType === 'issue_comment' && action === 'created') {
    event = 'issue_commented';
    const raw = payload.comment as { id?: unknown; body?: unknown; user?: RawUser | null } | undefined;
    const commentId = typeof raw?.id === 'number' || typeof raw?.id === 'string' ? String(raw.id) : '';
    if (!commentId) return [];
    comment = { id: commentId, body: cut(str(raw?.body)), author: str(raw?.user?.login) || null };
  }
  if (!event) return [];

  const sender = payload.sender as RawUser | undefined;
  const assignee = issue.assignee ?? null;
  return [
    {
      integration: 'github_issues',
      event,
      connectionId: null,
      externalId: id,
      identifier: `${repoFullName}#${number}`,
      title: str(issue.title),
      body: cut(str(issue.body)),
      url: str(issue.html_url),
      labels: labelNames(issue.labels),
      assignee: str(assignee?.login) || null,
      assigneeId: assignee?.id !== undefined && assignee?.id !== null ? String(assignee.id) : null,
      team: null,
      project: null,
      status: str(issue.state) || 'open',
      priority: null,
      actor: str(sender?.login) || null,
      actorId: sender?.id !== undefined && sender?.id !== null ? String(sender.id) : null,
      author: str(issue.user?.login) || null,
      repoFullName,
      number,
      ...(labelName ? { labelName } : {}),
      ...(comment ? { comment } : {}),
    },
  ];
}

/**
 * Whether this is Talyn hearing its own write-back: the Talyn App did it (a
 * comment, a close), or the comment id is one Talyn recorded.
 */
async function isSelfEcho(facts: IssueEventFacts): Promise<boolean> {
  if (classifyAutoMergeActor(facts.actor) === 'talyn') return true;
  if (facts.comment && (await isOurComment('github_issues', facts.externalId, facts.comment.id))) return true;
  return false;
}

export const githubIssuesWorkflowSource: WorkflowSourceAdapter<
  GithubIssuesWorkflowInput,
  WatchTarget,
  IssueEventFacts
> = {
  integration: 'github_issues',

  facts: (input) => githubIssueFactsFromDelivery(input.delivery),

  // Prefixed, so a GitHub PR rule and an issue rule never share a claim key.
  deliveryId: (input) => `issues:${input.delivery.deliveryId}`,

  targets: async (input) => input.targets,

  workspaceAllowed: workspaceMayUseIssueRules,

  async prepare(target, factsList, workflows: WorkflowDefinition[]) {
    const needsViewer = workflows.some((w) => w.conditions.issueAssignee?.kind === 'me');
    const viewerLogin = needsViewer ? await githubService.getViewerLogin(target.workspaceId).catch(() => null) : null;
    const out: IssueEventFacts[] = [];
    for (const facts of factsList) {
      if (await isSelfEcho(facts)) {
        debugBus.recordEvent({
          service: 'workflows',
          action: 'self-echo',
          summary: `${facts.identifier} ${facts.event} was Talyn's own write-back — skipped`,
          workspaceId: target.workspaceId,
        });
        continue;
      }
      out.push(facts);
    }
    return { facts: out, viewerLogin };
  },

  actionContext: (target, facts, base) => ({
    ...base,
    integration: 'github_issues',
    repositoryId: target.repositoryId,
    facts,
  }),

  blockedUntilMs: (target) => githubRateGate.blockedUntil(githubService.accountKeyFor(target.workspaceId), 'rest'),

  describe: ({ delivery }) => `${delivery.eventType}/${delivery.action ?? '-'} ${delivery.repoFullName}`,
};
