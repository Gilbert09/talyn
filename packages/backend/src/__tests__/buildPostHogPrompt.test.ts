import { describe, it, expect } from 'vitest';
import { buildPostHogPrompt, type PRMergeableSummary } from '@fastowl/shared';

/**
 * The cloud "make this PR mergeable" prompt must keep its guard against
 * base-branch files leaking into the PR when the agent merges the base in —
 * a recurring real-world failure. We assert the intent (a before/after
 * file-set check), not the exact wording, so the prompt can still evolve.
 */

const summary: PRMergeableSummary = {
  url: 'https://github.com/acme/widgets/pull/7',
  headBranch: 'feature/x',
  baseBranch: 'main',
  mergeable: 'CONFLICTING',
  blockingReason: 'conflicts',
  reviewDecision: null,
  checks: { total: 0, failed: 0, inProgress: 0, passed: 0 },
} as unknown as PRMergeableSummary;

describe('buildPostHogPrompt — base-merge leak guard', () => {
  const prompt = buildPostHogPrompt({ owner: 'acme', repo: 'widgets', number: 7, summary });

  it('tells the agent to compare the PR file set before and after the base merge', () => {
    expect(prompt).toContain('git diff --name-only origin/main...HEAD');
    expect(prompt.toLowerCase()).toContain('before');
    expect(prompt.toLowerCase()).toContain('after');
    expect(prompt.toLowerCase()).toContain('leak');
  });

  it('threads the real base branch into the guard commands', () => {
    const custom = buildPostHogPrompt({
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      summary: { ...summary, baseBranch: 'develop' } as PRMergeableSummary,
    });
    expect(custom).toContain('git diff --name-only origin/develop...HEAD');
    expect(custom).not.toContain('origin/main...HEAD');
  });

  it('keeps the non-negotiable no-force-push / no-rebase rules', () => {
    expect(prompt).toContain('NEVER force-push');
    expect(prompt.toLowerCase()).toContain('never rebase');
  });

  it('forbids squash-merging the base and requires a real two-parent merge', () => {
    expect(prompt).toContain('git merge --squash');
    expect(prompt).toContain('TWO parents');
  });

  it('requires the deterministic post-merge ancestor / behind-by assertion', () => {
    expect(prompt).toContain('git merge-base --is-ancestor origin/main HEAD');
    expect(prompt).toContain('git rev-list --count HEAD..origin/main');
  });
});
