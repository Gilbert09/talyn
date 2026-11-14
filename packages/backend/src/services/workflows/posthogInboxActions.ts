import type { PostHogInboxFacts } from '@talyn/shared';
import { buildInboundPrompt } from '../inbound/prompt.js';
import type { PostHogInboxActionContext } from './actions.js';

/**
 * The prompt a PostHog Inbox rule's session gets.
 *
 * The rule's own prompt comes first, as the instruction. Talyn's standing
 * instruction follows it: check the report's diagnosis against the code
 * before changing anything, and stop without a change when it is wrong. The
 * report itself (title, priority, summary) is quoted in a fence and marked
 * UNTRUSTED (`buildInboundPrompt`): PostHog wrote it from product data that
 * anybody can influence, for example an error message or a survey answer.
 */
export const POSTHOG_INBOX_VERIFY_INSTRUCTION =
  "PostHog's report is a diagnosis, not a verified fact. Before you change any code, check the diagnosis " +
  'against the code in this repository. If the diagnosis is wrong, the problem is already fixed, or the fix ' +
  'is not in this repository, stop: do not change any files and do not open a pull request. Say in one short ' +
  'message what you found. If the diagnosis is right, fix the problem and open a pull request that links the ' +
  'report.';

/** The report as the prompt quotes it. */
export function reportText(facts: PostHogInboxFacts): string {
  const lines = [`Title: ${facts.title || '(none)'}`];
  if (facts.priority) lines.push(`Priority: ${facts.priority}`);
  if (facts.repository) lines.push(`Repository: ${facts.repository}`);
  if (facts.sourceProducts.length > 0) lines.push(`Source products: ${facts.sourceProducts.join(', ')}`);
  if (facts.signalCount > 0) lines.push(`Signals: ${facts.signalCount}`);
  lines.push('', 'Summary:', facts.summary.trim() || '(none)');
  return lines.join('\n');
}

export function posthogInboxRulePrompt(instruction: string, ctx: PostHogInboxActionContext, repoName: string): string {
  const { facts } = ctx;
  return buildInboundPrompt({
    instruction: `${instruction.trim()}\n\n${POSTHOG_INBOX_VERIFY_INSTRUCTION}`,
    sourceLabel: ctx.workflowName
      ? `a PostHog Inbox report that the automation "${ctx.workflowName}" watches`
      : 'a PostHog Inbox report',
    identifiers: {
      repo: repoName,
      'report.id': facts.reportId,
      'report.url': facts.url,
      'report.title': facts.title,
    },
    fields: { 'report.summary': facts.summary },
    payload: reportText(facts),
    bodyLabel: 'report',
    sourceUrl: facts.url,
  });
}
