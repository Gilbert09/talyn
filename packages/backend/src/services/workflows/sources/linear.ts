import type { IssueEventFacts, IssueWorkflowEvent } from '@talyn/shared';
import { MAX_ISSUE_FACT_TEXT } from '@talyn/shared';
import { debugBus } from '../../debugBus.js';
import type { InboundConnectionRef, InboundWorkflowInput, StoredInboundDelivery } from '../../inbound/adapter.js';
import { isOurComment } from '../../inbound/issueLinks.js';
import { linearBlockedUntil } from '../../linear/api.js';
import { fetchLinearIssue } from '../../linear/issues.js';
import { linearAppUserId } from '../../linear/store.js';
import { workspaceMayUseIssueRules } from '../../workflowsAccess.js';
import type { WorkflowSourceAdapter, WorkflowSourceTarget } from '../source.js';

/**
 * The Linear source adapter: one stored Linear webhook delivery in, issue
 * facts out.
 *
 * The delivery was stored per connection (one Linear organization in one
 * workspace), so the only target is that connection's workspace, and the
 * matcher refuses a rule that names another connection.
 *
 * Linear sends `Issue` create and update, and `Comment` create. An update
 * yields one fact per thing that changed (labels added, assignee or delegate
 * set, state, title or description), from `updatedFrom`. A comment's payload
 * describes the comment, so the issue is read from Linear in `prepare`.
 */

export interface LinearWorkflowTarget extends WorkflowSourceTarget {
  repositoryId: null;
  connectionId: string;
}

interface LinearUserRef {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
}

interface LinearIssueData {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  url?: unknown;
  priorityLabel?: unknown;
  teamId?: unknown;
  team?: { id?: unknown; key?: unknown } | null;
  state?: { name?: unknown } | null;
  project?: { name?: unknown } | null;
  assigneeId?: unknown;
  assignee?: LinearUserRef | null;
  delegateId?: unknown;
  labelIds?: unknown;
  labels?: unknown;
}

interface LinearPayload {
  action?: unknown;
  type?: unknown;
  actor?: LinearUserRef | null;
  data?: Record<string, unknown> | null;
  updatedFrom?: Record<string, unknown> | null;
  url?: unknown;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function idOf(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function cut(text: string): string {
  return text.length > MAX_ISSUE_FACT_TEXT ? text.slice(0, MAX_ISSUE_FACT_TEXT) : text;
}

function nameOf(user: LinearUserRef | null | undefined): string | null {
  return str(user?.displayName) || str(user?.name) || null;
}

function stringIds(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function labelsOf(data: LinearIssueData): Array<{ id: string; name: string }> {
  if (!Array.isArray(data.labels)) return [];
  return data.labels
    .map((l) => l as { id?: unknown; name?: unknown })
    .filter((l) => typeof l.name === 'string')
    .map((l) => ({ id: str(l.id), name: str(l.name) }));
}

/** The facts an `Issue` payload's data carries, before the event is chosen. */
function issueBase(data: LinearIssueData, connection: InboundConnectionRef, actor: LinearUserRef | null | undefined) {
  const labels = labelsOf(data);
  return {
    integration: 'linear' as const,
    connectionId: connection.id,
    externalId: str(data.id),
    identifier: str(data.identifier),
    title: str(data.title),
    body: cut(str(data.description)),
    url: str(data.url),
    labels: labels.map((l) => l.name),
    assignee: nameOf(data.assignee),
    assigneeId: idOf(data.assigneeId) ?? idOf(data.assignee?.id),
    delegateId: idOf(data.delegateId),
    team: str(data.team?.key) || null,
    teamId: idOf(data.teamId) ?? idOf(data.team?.id),
    project: str(data.project?.name) || null,
    status: str(data.state?.name),
    priority: str(data.priorityLabel) || null,
    actor: nameOf(actor),
    actorId: idOf(actor?.id),
  };
}

/** PURE: the facts one stored Linear delivery yields. `[]` for anything a rule cannot act on. */
export function linearFactsFromPayload(payload: unknown, connection: InboundConnectionRef): IssueEventFacts[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as LinearPayload;
  const type = str(p.type);
  const action = str(p.action);
  const data = (p.data ?? {}) as Record<string, unknown>;

  if (type === 'Issue') {
    const base = issueBase(data as LinearIssueData, connection, p.actor);
    if (!base.externalId) return [];
    if (action === 'create') return [{ ...base, event: 'issue_created' }];
    if (action !== 'update') return [];
    const from = p.updatedFrom ?? {};
    const out: IssueEventFacts[] = [];
    const push = (event: IssueWorkflowEvent, extra: Partial<IssueEventFacts> = {}) => out.push({ ...base, event, ...extra });

    if ('labelIds' in from) {
      const before = new Set(stringIds(from.labelIds));
      const labels = labelsOf(data as LinearIssueData);
      const added = stringIds(data.labelIds).filter((id) => !before.has(id));
      for (const id of added) {
        const name = labels.find((l) => l.id === id)?.name;
        if (name) push('issue_labeled', { labelName: name });
      }
    }
    const assigned =
      ('assigneeId' in from && idOf(data.assigneeId) !== null) || ('delegateId' in from && idOf(data.delegateId) !== null);
    if (assigned) push('issue_assigned');
    if ('stateId' in from) push('issue_status_changed');
    if ('title' in from || 'description' in from) push('issue_updated');
    return out;
  }

  if (type === 'Comment' && action === 'create') {
    const issue = (data.issue ?? {}) as LinearIssueData;
    const issueId = idOf(data.issueId) ?? idOf(issue.id);
    const commentId = idOf(data.id);
    if (!issueId || !commentId) return [];
    const author = (data.user ?? null) as LinearUserRef | null;
    return [
      {
        integration: 'linear',
        event: 'issue_commented',
        connectionId: connection.id,
        externalId: issueId,
        identifier: str(issue.identifier),
        title: str(issue.title),
        body: '',
        url: str(issue.url),
        labels: [],
        assignee: null,
        team: str(issue.team?.key) || null,
        teamId: idOf(issue.teamId) ?? idOf(issue.team?.id),
        project: null,
        status: '',
        priority: null,
        actor: nameOf(p.actor) ?? nameOf(author),
        actorId: idOf(p.actor?.id) ?? idOf(data.userId),
        comment: { id: commentId, body: cut(str(data.body)), author: nameOf(author) },
        // A comment's payload describes the comment. `prepare` reads the issue.
        unknownFields: ['labels', 'assignee', 'team', 'project', 'status', 'priority', 'body'],
      },
    ];
  }
  return [];
}

/** Fill a comment's facts from the issue itself. Leaves them as they are when Linear cannot be read. */
async function withIssue(facts: IssueEventFacts): Promise<IssueEventFacts> {
  if (!facts.unknownFields?.length || !facts.connectionId) return facts;
  try {
    const issue = await fetchLinearIssue(facts.connectionId, facts.externalId);
    if (!issue) return facts;
    return {
      ...facts,
      identifier: issue.identifier || facts.identifier,
      title: issue.title,
      body: cut(issue.description),
      url: issue.url || facts.url,
      labels: issue.labels,
      assignee: issue.assignee,
      assigneeId: issue.assigneeId,
      delegateId: issue.delegateId,
      team: issue.teamKey,
      teamId: issue.teamId,
      project: issue.project,
      status: issue.state ?? '',
      priority: issue.priority,
      unknownFields: [],
    };
  } catch (err) {
    debugBus.recordEvent({
      service: 'workflows',
      action: 'linear_issue_unreadable',
      summary: `${facts.externalId}`,
      ok: false,
      error: err,
    });
    return facts;
  }
}

export const linearWorkflowSource: WorkflowSourceAdapter<
  InboundWorkflowInput<IssueEventFacts>,
  LinearWorkflowTarget,
  IssueEventFacts
> = {
  integration: 'linear',

  facts: (input) => input.facts,

  deliveryId: (input) => `inbound:${input.connection.id}:${input.delivery.deliveryId}`,

  targets: async (input) => [
    { workspaceId: input.connection.workspaceId, repositoryId: null, connectionId: input.connection.id },
  ],

  workspaceAllowed: workspaceMayUseIssueRules,

  async prepare(target, factsList) {
    const appUserId = await linearAppUserId(target.connectionId);
    const out: IssueEventFacts[] = [];
    for (const raw of factsList) {
      // Talyn's own write-back: our app user did it, or the comment is one we wrote.
      const ours =
        (!!appUserId && raw.actorId === appUserId) ||
        (!!raw.comment && (await isOurComment('linear', raw.externalId, raw.comment.id)));
      if (ours) {
        debugBus.recordEvent({
          service: 'workflows',
          action: 'self-echo',
          summary: `${raw.identifier || raw.externalId} ${raw.event} was Talyn's own write-back — skipped`,
          workspaceId: target.workspaceId,
        });
        continue;
      }
      const facts = await withIssue(raw);
      out.push({
        ...facts,
        assignedToApp: !!appUserId && (facts.assigneeId === appUserId || facts.delegateId === appUserId),
      });
    }
    return { facts: out };
  },

  actionContext: (_target, facts, base) => ({
    ...base,
    integration: 'linear',
    repositoryId: null,
    facts,
  }),

  blockedUntilMs: (target) => linearBlockedUntil(target.connectionId),

  describe: (input) => `linear ${input.connection.id} (${input.delivery.deliveryId})`,
};

/** For the adapter: the stored delivery's facts. */
export function linearToFacts(delivery: StoredInboundDelivery, connection: InboundConnectionRef): IssueEventFacts[] {
  if (connection.kind !== 'linear') return [];
  return linearFactsFromPayload(delivery.payload, connection);
}
