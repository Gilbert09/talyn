import type { GithubWorkflowEvent, IssueEventFacts, SlackEventFacts, WebhookEventFacts, WorkflowFacts } from '@talyn/shared';
import { loginLooksLikeBot } from '@talyn/shared';

/**
 * Rebuild the facts a parked run was acting on, so a retry is faithful.
 *
 * Prefers the `facts` column, written when the run was claimed — a `comment`
 * action interpolates the PR's branches, and the webhook payload is long gone by
 * the time a rate-limit gate clears. Both members of the facts union are read
 * back: a Slack run's facts carry `integration: 'slack'`, a GitHub run's carry
 * no tag or `'github'`.
 *
 * Falls back to the denormalised columns for GitHub rows written before that
 * column existed. Those carry the repo, number, title, URL and author and
 * nothing else, so everything they cannot supply is declared UNKNOWN rather
 * than defaulted: `renderWorkflowTemplate` leaves an unresolvable placeholder
 * verbatim, which tells the user their template did not fill in — where a blank
 * would quietly post a sentence with a hole in it.
 *
 * A Slack run always stores its facts. One without them (a row nobody should be
 * able to write) returns null, and the caller gives the run up rather than
 * acting on a message it cannot describe.
 */
export function workflowFactsFromRun(run: {
  integration?: string | null;
  repoFullName: string | null;
  prNumber: number | null;
  prTitle: string;
  prUrl: string;
  prAuthor: string;
  event: string;
  facts?: unknown;
}): WorkflowFacts | null {
  const stored = run.facts as Partial<WorkflowFacts> | null | undefined;
  if (stored && typeof stored === 'object') {
    if (stored.integration === 'linear' || stored.integration === 'github_issues') {
      const issue = stored as Partial<IssueEventFacts>;
      if (typeof issue.externalId === 'string' && issue.externalId) return stored as IssueEventFacts;
    } else if (stored.integration === 'webhook') {
      // The body is not stored on the run. The retry reads it again from
      // `inbound_deliveries` by `deliveryRowId`.
      const webhook = stored as Partial<WebhookEventFacts>;
      if (typeof webhook.ruleId === 'string' && typeof webhook.deliveryRowId === 'string') {
        return stored as WebhookEventFacts;
      }
    } else if (stored.integration === 'slack') {
      const slack = stored as Partial<SlackEventFacts>;
      if (typeof slack.teamId === 'string' && typeof slack.channelId === 'string') {
        return stored as SlackEventFacts;
      }
    } else if (typeof (stored as { number?: unknown }).number === 'number') {
      return stored as WorkflowFacts;
    }
  }

  if (run.integration && run.integration !== 'github') return null;
  if (!run.repoFullName || typeof run.prNumber !== 'number') return null;

  const author = { login: run.prAuthor, isBot: loginLooksLikeBot(run.prAuthor) };
  return {
    event: run.event as GithubWorkflowEvent,
    repoFullName: run.repoFullName,
    number: run.prNumber,
    title: run.prTitle,
    url: run.prUrl,
    author,
    actor: author,
    baseBranch: '',
    defaultBranch: '',
    headBranch: '',
    draft: false,
    labels: [],
    unknownFields: ['baseBranch', 'defaultBranch', 'headBranch', 'draft', 'labels'],
  };
}
