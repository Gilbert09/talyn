// The "run this skill against this PR" prompt handed to a cloud run.
//
// Neither provider accepts skills natively, so the SKILL.md content is
// inlined verbatim (never truncated — see SKILL_MAX_BYTES in skills.ts).
// Like prMergeable.ts, the builder is provider-aware: the skill and PR
// context are identical across providers, only the git/publishing rules
// block changes (shared helpers so the two prompt families can't drift).

import type { CloudProviderType } from './index.js';
import { claudeCodeGitRules, postHogCodeGitRules } from './prMergeable.js';
import type { SkillSource } from './skills.js';

export interface SkillPromptInput {
  owner: string;
  repo: string;
  number: number;
  pr: {
    url: string;
    title: string;
    headBranch: string;
    baseBranch: string;
  };
  skill: {
    name: string;
    description: string;
    /** Full SKILL.md text (frontmatter included is fine). */
    content: string;
    source: SkillSource;
    /** repo skills — path of SKILL.md inside the repo checkout. */
    repoPath?: string;
  };
  provider: CloudProviderType;
}

/**
 * Fence the skill content with a run of `~` longer than any tilde/backtick
 * fence the skill itself contains, so a skill full of code blocks can't
 * break out of its container.
 */
function fenceSkill(content: string): string {
  const longestFence = content.match(/^[~`]{4,}/gm)?.reduce((a, b) => (b.length > a.length ? b : a), '') ?? '';
  const fence = '~'.repeat(Math.max(4, longestFence.length + 1));
  return `${fence}\n${content.trimEnd()}\n${fence}`;
}

/**
 * Build the skill-run prompt for a cloud provider. Unknown/deferred
 * providers get the PostHog variant (same convention as buildMergeablePrompt).
 */
export function buildSkillPrompt(input: SkillPromptInput): string {
  const { owner, repo, number, pr, skill, provider } = input;
  const ref = `${owner}/${repo}#${number}`;
  const isClaude = provider === 'claude_code';
  const gitRules = isClaude
    ? claudeCodeGitRules(pr.baseBranch)
    : postHogCodeGitRules(pr.baseBranch);
  const checksHint = isClaude
    ? "the `github` MCP server's tools"
    : '`gh` (or the GitHub API)';

  const repoPathNote = skill.repoPath
    ? `\nThis skill also lives in your checkout at \`${skill.repoPath}\`; any supporting files the skill references are siblings of that file — read them from the checkout as needed.`
    : '';

  return `You are running an agent skill against a specific pull request.

Pull request: ${pr.url}
Repository: ${owner}/${repo}
PR number: #${number}
PR title: ${pr.title}
Branch: ${pr.headBranch} (base: ${pr.baseBranch})

${gitRules}

## Skill: ${skill.name}
${skill.description ? `\n${skill.description}\n` : ''}
The full skill definition follows. Treat it as your operating instructions for this task:

${fenceSkill(skill.content)}
${repoPathNote}

## Your job

Apply this skill to ${ref} specifically:

1. Check out / inspect the PR branch (${pr.headBranch}) and fetch the PR's current state (diff, description, review threads, CI) via ${checksHint} so the skill operates on what's actually there.
2. Follow the skill's instructions faithfully. Where the skill's instructions and these surrounding instructions conflict on git/publishing mechanics, the NON-NEGOTIABLE rules above win; on everything else, the skill wins.
3. Publish the skill's output:
   - If the skill produces findings, feedback, or a report: post it as a SINGLE PR review or comment on ${ref} — well-formatted markdown, no placeholder text. Do not open a new PR for commentary.
   - If the skill produces code changes: publish them to the PR branch (${pr.headBranch}) per the git rules above. Keep the changes scoped to what the skill calls for — do not touch unrelated files.
   - If the skill produces both, do both.
4. If the skill cannot be applied to this PR (missing context, prerequisites absent, nothing to do), post one concise PR comment explaining why, then stop.

Be decisive: gather what you need in one pass, do the work, publish once, and stop. Do not idle waiting on CI unless the skill explicitly requires it.`;
}
