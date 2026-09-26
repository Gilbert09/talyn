// The "fix these review findings" prompt handed to a cloud run.
//
// Built the same way `skillPrompt.ts` builds its own, and for the same reason: the
// provider-specific publishing rules are VARIABLES rather than prose, so one
// workspace override serves both providers and the two families cannot drift on
// how a commit is supposed to reach GitHub.

import type { CloudProviderType } from './index.js';
import {
  fleetGitRules,
  githubToolsHint,
  postHogCodeGitRules,
  talynTaglineRule,
} from './prMergeable.js';
import { DEFAULT_REVIEW_FIX_TEMPLATE, renderPromptTemplate } from './promptTemplates.js';
import { CODE_REVIEW_SEVERITY_LABELS, type CodeReviewSeverity } from './codeReview.js';

export interface ReviewFixFinding {
  severity: CodeReviewSeverity;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  title: string;
  body: string;
  suggestion: string | null;
}

export interface ReviewFixPromptInput {
  owner: string;
  repo: string;
  number: number;
  pr: {
    url: string;
    title: string;
    headBranch: string;
    baseBranch: string;
  };
  findings: ReviewFixFinding[];
  /** Whether the workspace wants one summary comment after the push. */
  summaryComment: boolean;
  provider: CloudProviderType;
  /** A workspace override (Settings → Instructions); else the shipped default. */
  template?: string;
}

/**
 * The findings, rendered for an agent to work from.
 *
 * Numbered, because the agent is asked to report back on each one and a list it
 * can refer to by number is one the user can reconcile. The file and line come
 * first on each item so the agent can open the right place before reading the
 * argument.
 */
function renderFindings(findings: ReviewFixFinding[]): string {
  return findings
    .map((f, i) => {
      const lines = f.lineStart
        ? `:${f.lineStart}${f.lineEnd && f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ''}`
        : '';
      return [
        `### ${i + 1}. ${f.title}`,
        `${CODE_REVIEW_SEVERITY_LABELS[f.severity]} · \`${f.filePath}${lines}\``,
        '',
        f.body,
        ...(f.suggestion ? ['', `Suggested change: ${f.suggestion}`] : []),
      ].join('\n');
    })
    .join('\n\n');
}

/**
 * Whether to comment, and what the comment may contain.
 *
 * Empty when the workspace has it switched off, which is the default — the
 * product's whole differentiator is that it does not write on your pull request,
 * and a fix already announces itself as a commit. When it IS on, the rule is "one
 * comment, saying what changed and what did not", because a fix that pushed to a
 * shared branch and explained nothing is worse than either alternative.
 */
function commentRule(enabled: boolean): string {
  if (!enabled) {
    return [
      '## Do not comment on the pull request',
      '',
      'Do not post a comment, a review, or a reply. The person who asked for this',
      'fix is watching it in Talyn and will see what you did there. Your commit is',
      'the only thing that should appear on the pull request.',
    ].join('\n');
  }
  return [
    '## Post one summary comment',
    '',
    'After your commit has landed, post exactly ONE top-level comment on the pull',
    'request. It should say, briefly: what you fixed, and anything on the list you',
    'did not fix and why. Keep it short — a few lines, not a report — and do not',
    'quote the findings back in full. Other people read this pull request and they',
    'deserve to know the branch moved and why.',
    '',
    'One comment, not one per finding. Do not open a review, and do not reply to',
    'existing threads.',
  ].join('\n');
}

export function reviewFixPromptVariables(input: ReviewFixPromptInput): Record<string, string> {
  const { owner, repo, number, pr, findings, provider } = input;
  // The same publishing-dialect switch `mergeablePromptVariables` makes, and for
  // the reason recorded there: the fleet cannot inherit PostHog's signed-git tool
  // names, because it has different ones.
  const fleet = provider === 'selfhosted';
  return {
    'pr.url': pr.url,
    'pr.number': String(number),
    'pr.ref': `${owner}/${repo}#${number}`,
    'pr.title': pr.title,
    'pr.headBranch': pr.headBranch,
    'pr.baseBranch': pr.baseBranch,
    repo: `${owner}/${repo}`,
    'review.findings': renderFindings(findings),
    'review.count': String(findings.length),
    'review.commentRule': commentRule(input.summaryComment),
    gitRules: fleet ? fleetGitRules(pr.baseBranch) : postHogCodeGitRules(pr.baseBranch),
    githubTools: githubToolsHint(provider),
    taglineRule: talynTaglineRule(),
  };
}

export function buildReviewFixPrompt(input: ReviewFixPromptInput): string {
  return renderPromptTemplate(
    input.template ?? DEFAULT_REVIEW_FIX_TEMPLATE,
    reviewFixPromptVariables(input)
  );
}
