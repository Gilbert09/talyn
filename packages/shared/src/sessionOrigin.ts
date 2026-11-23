import {
  WORKFLOW_EVENT_LABELS,
  isIssueFacts,
  isPostHogInboxFacts,
  isSlackFacts,
  isWebhookFacts,
  type WorkflowFacts,
  type WorkflowTriggerEvent,
} from './workflows.js';

/** One label and value row in the automation popover. */
export interface SessionOriginFact {
  label: string;
  value: string;
}

/**
 * The automation that started a session, with the event it acted on.
 * `GET /workbenches/:id/origin` returns it. The header chip shows it on click.
 */
export interface SessionOrigin {
  type: 'workflow' | 'loop';
  /** The rule id or the loop id. */
  automationId: string;
  /** The automation's name now. Null when somebody deleted it. */
  automationName: string | null;
  runId: string;
  /** When the run started. Null when the run row is gone. */
  startedAt: string | null;
  /** `event` (a rule fired), `manual` (somebody ran it) or `schedule` (a loop fired). */
  trigger: 'event' | 'manual' | 'schedule' | null;
  /** A manual run: the name or email of the person who started it. */
  triggeredBy: string | null;
  /** What happened, as a person reads it: "Report ready for work". Null for a loop. */
  event: string | null;
  /** The thing the run acted on: a report, an issue, a pull request or a channel. */
  subject: { label: string; url: string | null } | null;
  /** More facts about the subject, in display order. */
  facts: SessionOriginFact[];
  /** A short quote: the report summary, the Slack message or the issue text. */
  excerpt: string | null;
}

/** The longest excerpt the popover shows. */
export const SESSION_ORIGIN_EXCERPT_MAX = 280;

function clip(text: string | null | undefined, max = SESSION_ORIGIN_EXCERPT_MAX): string | null {
  const t = text?.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function push(facts: SessionOriginFact[], label: string, value: string | null | undefined): void {
  const v = value?.trim();
  if (v) facts.push({ label, value: v });
}

const ACTIONABILITY: Record<string, string> = {
  immediately_actionable: 'Immediately actionable',
  requires_human_input: 'Needs human input',
  not_actionable: 'Not actionable',
};

/** A label for a rule's trigger event. Falls back to the raw event name. */
export function sessionOriginEventLabel(event: string | null | undefined): string | null {
  if (!event) return null;
  return WORKFLOW_EVENT_LABELS[event as WorkflowTriggerEvent] ?? event;
}

/**
 * The subject, facts and excerpt of a rule's run, from the facts the run
 * stored. `fallback` is the run's own subject columns, for runs with no facts.
 */
export function workflowOriginDetails(
  facts: WorkflowFacts | null | undefined,
  fallback: { label: string | null; url: string | null } = { label: null, url: null }
): Pick<SessionOrigin, 'subject' | 'facts' | 'excerpt'> {
  const out: SessionOriginFact[] = [];
  const fallbackSubject = fallback.label ? { label: fallback.label, url: fallback.url || null } : null;
  if (!facts) return { subject: fallbackSubject, facts: out, excerpt: null };

  if (isPostHogInboxFacts(facts)) {
    push(out, 'Priority', facts.priority);
    push(out, 'Actionability', facts.actionability ? (ACTIONABILITY[facts.actionability] ?? facts.actionability) : null);
    push(out, 'Repository', facts.repository);
    if (facts.signalCount > 0) push(out, 'Signals', String(facts.signalCount));
    push(out, 'Scout', facts.scout);
    if (facts.sourceProducts.length > 0) push(out, 'Products', facts.sourceProducts.join(', '));
    return {
      subject: { label: facts.title.trim() || `Report ${facts.reportId}`, url: facts.url || null },
      facts: out,
      excerpt: clip(facts.summary),
    };
  }

  if (isIssueFacts(facts)) {
    push(out, 'Status', facts.status);
    push(out, 'Priority', facts.priority);
    push(out, 'Assignee', facts.assignee);
    push(out, 'Team', facts.team);
    push(out, 'Project', facts.project);
    if (facts.labels.length > 0) push(out, 'Labels', facts.labels.join(', '));
    push(out, 'By', facts.actor);
    const title = facts.title.trim();
    return {
      subject: { label: title ? `${facts.identifier} ${title}` : facts.identifier, url: facts.url || null },
      facts: out,
      excerpt: clip(facts.comment?.body) ?? clip(facts.body),
    };
  }

  if (isSlackFacts(facts)) {
    push(out, 'Channel', facts.channelName ? `#${facts.channelName}` : facts.channelId);
    return {
      subject: { label: 'Slack message', url: facts.permalink || null },
      facts: out,
      excerpt: clip(facts.text),
    };
  }

  if (isWebhookFacts(facts)) {
    push(out, 'Delivery', facts.deliveryId);
    return { subject: { label: 'Webhook request', url: null }, facts: out, excerpt: null };
  }

  push(out, 'Repository', facts.repoFullName);
  push(out, 'Author', facts.author?.login);
  if (facts.actor?.login && facts.actor.login !== facts.author?.login) push(out, 'By', facts.actor.login);
  push(out, 'Branch', facts.headBranch && facts.baseBranch ? `${facts.headBranch} → ${facts.baseBranch}` : null);
  if (facts.labelName) push(out, 'Label', facts.labelName);
  const title = facts.title?.trim();
  return {
    subject: { label: title ? `#${facts.number} ${title}` : `${facts.repoFullName}#${facts.number}`, url: facts.url || null },
    facts: out,
    excerpt: clip(facts.body),
  };
}
