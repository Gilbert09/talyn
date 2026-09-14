import { describe, it, expect } from 'vitest';
import {
  buildPostHogPrompt,
  buildMergeablePrompt,
  prNeedsFollowup,
  prHasFixableIssues,
  TALYN_COMMENT_TAGLINE,
  TALYN_NEEDS_HUMAN_SENTINEL,
  parseNeedsHumanSentinel,
  mergeableBlockerSignature,
  type PRMergeableSummary,
  type CloudProviderType,
} from '@talyn/shared';

/**
 * The cloud "make this PR mergeable" prompt must match the PostHog Code
 * sandbox's signed-git tool contract (PostHog/code#2574): base updates go
 * through `git_signed_merge`, conflicts through a local rebase published with
 * `git_signed_rewrite`, ordinary work through `git_signed_commit` — and the
 * guard against base-branch files leaking into the PR stays. We assert the
 * intent, not the exact wording, so the prompt can still evolve.
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

describe('buildPostHogPrompt — signed-git tool contract', () => {
  const prompt = buildPostHogPrompt({ owner: 'acme', repo: 'widgets', number: 7, summary });

  it('routes all publishing through the signed tools (raw commit/push are blocked)', () => {
    expect(prompt).toContain('git_signed_commit');
    expect(prompt).toContain('git_signed_merge');
    expect(prompt).toContain('git_signed_rewrite');
    expect(prompt.toLowerCase()).toContain('blocked');
  });

  it('directs base updates to git_signed_merge first', () => {
    expect(prompt).toMatch(/ALWAYS call `git_signed_merge` first/);
  });

  it('forbids the local-merge-then-signed-commit linearization path', () => {
    expect(prompt).toMatch(/NEVER run a local `git merge origin\/main` and then `git_signed_commit`/);
    expect(prompt.toUpperCase()).toContain('LINEARIZE');
  });

  it('scopes rebase to conflict resolution and publishes it via git_signed_rewrite', () => {
    expect(prompt).toContain('git rebase origin/main');
    expect(prompt).toContain('git rebase --continue');
    expect(prompt).toMatch(/rebase[\s\S]*publish[\s\S]*`git_signed_rewrite`/i);
    expect(prompt.toLowerCase()).toContain('never rebase for any other reason');
  });

  it('treats signed-tool refusals as authoritative', () => {
    expect(prompt.toLowerCase()).toContain('refusal is authoritative');
  });

  it('still forbids single-parent imitations of a merge', () => {
    expect(prompt).toContain('git merge --squash');
    expect(prompt.toUpperCase()).toContain('ANCESTOR');
  });
});

describe('buildPostHogPrompt — base-merge leak guard', () => {
  const prompt = buildPostHogPrompt({ owner: 'acme', repo: 'widgets', number: 7, summary });

  it('tells the agent to compare the PR file set before and after the base update', () => {
    expect(prompt).toContain('git diff --name-only origin/main...HEAD');
    expect(prompt.toLowerCase()).toContain('before');
    expect(prompt.toLowerCase()).toContain('after');
    expect(prompt.toLowerCase()).toContain('leak');
  });

  it('threads the real base branch into the guard and update commands', () => {
    const custom = buildPostHogPrompt({
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      summary: { ...summary, baseBranch: 'develop' } as PRMergeableSummary,
    });
    expect(custom).toContain('git diff --name-only origin/develop...HEAD');
    expect(custom).toContain('git rebase origin/develop');
    expect(custom).not.toContain('origin/main...HEAD');
  });

  it('requires the deterministic post-update ancestor / behind-by assertion', () => {
    expect(prompt).toContain('git merge-base --is-ancestor origin/main HEAD');
    expect(prompt).toContain('git rev-list --count HEAD..origin/main');
  });
});

describe('buildMergeablePrompt — provider dispatch', () => {
  it('posthog_code matches the back-compat buildPostHogPrompt output', () => {
    expect(buildMergeablePrompt({ owner: 'acme', repo: 'widgets', number: 7, summary, provider: 'posthog_code' })).toBe(
      buildPostHogPrompt({ owner: 'acme', repo: 'widgets', number: 7, summary })
    );
  });

  it('an unknown/deferred provider falls back to the PostHog variant', () => {
    expect(buildMergeablePrompt({ owner: 'acme', repo: 'widgets', number: 7, summary, provider: 'codex_cloud' })).toBe(
      buildPostHogPrompt({ owner: 'acme', repo: 'widgets', number: 7, summary })
    );
  });
});

describe('buildMergeablePrompt — selfhosted variant (Talyn Fleet: fleet-publish, no push)', () => {
  const prompt = buildMergeablePrompt({
    owner: 'acme',
    repo: 'widgets',
    number: 7,
    summary,
    provider: 'selfhosted',
  });

  // The bug this pins: the fleet used to fall into the PostHog branch and was
  // told to call tools that do not exist inside the microVM.
  it('drops the PostHog-only signed-git tools', () => {
    expect(prompt).not.toContain('git_signed_commit');
    expect(prompt).not.toContain('git_signed_merge');
    expect(prompt).not.toContain('git_signed_rewrite');
  });

  it('publishes through fleet-publish and says a push will be rejected', () => {
    expect(prompt).toContain('fleet-publish');
    expect(prompt).toMatch(/NO outbound `git push`/);
    expect(prompt).toMatch(/signs it server-side|GitHub signs server-side|signed server-side/i);
  });

  it('gives the three-rung base-update ladder, in order', () => {
    // Scoped to the base-update section: `--move-branch` also appears up in the
    // git rules as one of the two publishing verbs, which is correct and much
    // earlier in the prompt.
    const ladder = prompt.slice(prompt.indexOf('/update-branch'));
    expect(prompt).toContain('/update-branch');
    expect(ladder.indexOf('/merges')).toBeGreaterThan(-1);
    expect(ladder.indexOf('--move-branch')).toBeGreaterThan(ladder.indexOf('/merges'));
  });

  it('keeps `gh` — the fleet golden ships a shim for it', () => {
    expect(prompt).toContain('gh pr view 7');
  });

  it('keeps the same goals and base-leak guard, threading the real base branch', () => {
    expect(prompt).toContain('Every reviewer comment is resolved');
    expect(prompt).toContain('CI is fully green');
    expect(prompt).toContain('The branch merges cleanly');
    expect(prompt.toUpperCase()).toContain('ANCESTOR');
    expect(prompt.toLowerCase()).toContain('leak');
    expect(prompt).toContain('git diff --name-only origin/main...HEAD');
    expect(prompt).toContain('git merge-base --is-ancestor origin/main HEAD');
  });

  it('still permits local rebase for conflicts but never a single-parent base imitation', () => {
    expect(prompt).toContain('git rebase origin/main');
    expect(prompt).toContain('git merge --squash');
    expect(prompt.toLowerCase()).toContain('single-parent');
  });
});

describe('buildMergeablePrompt — Talyn comment tagline', () => {
  it('exposes the linked, small-font tagline as the shared source of truth', () => {
    expect(TALYN_COMMENT_TAGLINE).toContain('talyn.dev');
    expect(TALYN_COMMENT_TAGLINE).toContain('https://talyn.dev');
    expect(TALYN_COMMENT_TAGLINE).toContain('<sub>'); // renders small on GitHub
  });

  it.each<CloudProviderType>(['posthog_code', 'selfhosted', 'codex_cloud'])(
    'instructs every provider to append the exact tagline to comments (%s)',
    (provider) => {
      const prompt = buildMergeablePrompt({ owner: 'acme', repo: 'widgets', number: 7, summary, provider });
      expect(prompt).toContain(TALYN_COMMENT_TAGLINE);
      expect(prompt).toContain('COMMENT FOOTER');
      // Scoped to comments — never commit messages / PR description.
      expect(prompt).toMatch(/Do NOT add it to commit messages/);
    }
  );
});

describe('buildMergeablePrompt — re-sign section (signed-commits repos)', () => {
  it('is absent by default (no behaviour change for the common case)', () => {
    for (const provider of ['posthog_code', 'selfhosted'] as CloudProviderType[]) {
      const prompt = buildMergeablePrompt({ owner: 'acme', repo: 'widgets', number: 7, summary, provider });
      expect(prompt).not.toContain('COMMIT SIGNING');
      expect(prompt).not.toMatch(/require signed commits/i);
    }
  });

  it('PostHog Code: re-sign via git_signed_rewrite + verify, threading the base branch', () => {
    const prompt = buildMergeablePrompt({
      owner: 'acme', repo: 'widgets', number: 7, provider: 'posthog_code',
      summary: { ...summary, baseBranch: 'develop' } as PRMergeableSummary,
      resignCommits: true,
    });
    expect(prompt).toContain('COMMIT SIGNING');
    expect(prompt).toMatch(/require.*signed commits/i);
    expect(prompt).toContain('git_signed_rewrite');
    expect(prompt).toContain('git log --show-signature origin/develop..HEAD');
    // Surfaced in the issues list too.
    expect(prompt.toLowerCase()).toContain('unsigned');
  });

  it('Talyn Fleet: re-sign by republishing through fleet-publish (no signed-git tools)', () => {
    const prompt = buildMergeablePrompt({
      owner: 'acme', repo: 'widgets', number: 7, summary, provider: 'selfhosted',
      resignCommits: true,
    });
    expect(prompt).toContain('COMMIT SIGNING');
    expect(prompt).toContain('fleet-publish');
    expect(prompt).toContain('--move-branch');
    expect(prompt).not.toContain('git_signed_rewrite');
    expect(prompt.toLowerCase()).toContain('unsigned');
  });
});

/**
 * The merge stack's squash escape hatch. When a stack's parent SQUASH-merges,
 * the base gets one new commit but the child's branch still carries the
 * parent's originals — so "merge the base in" either conflicts or leaves the
 * parent's changes showing in the child's diff. Talyn has no checkout and
 * cannot rebase; the run it dispatches can, but only if the prompt says so.
 */
describe('buildMergeablePrompt — retargeted stack member', () => {
  it('is absent by default', () => {
    for (const provider of ['posthog_code', 'selfhosted'] as CloudProviderType[]) {
      const prompt = buildMergeablePrompt({
        owner: 'acme', repo: 'widgets', number: 7, summary, provider,
      });
      expect(prompt).not.toMatch(/part of a stack/i);
    }
  });

  it('names the parent, the new base, and prefers a rebase over a base merge', () => {
    for (const provider of ['posthog_code', 'selfhosted'] as CloudProviderType[]) {
      const prompt = buildMergeablePrompt({
        owner: 'acme', repo: 'widgets', number: 7, provider,
        summary: { ...summary, baseBranch: 'develop' } as PRMergeableSummary,
        retargetedOnto: { base: 'develop', parentNumber: 41 },
      });
      expect(prompt).toMatch(/part of a stack/i);
      expect(prompt).toContain('#41');
      expect(prompt).toContain('develop');
      expect(prompt).toMatch(/squash/i);
      expect(prompt).toMatch(/rebas/i);
      // The outcome that actually matters to the reviewer of the child PR.
      expect(prompt).toMatch(/ONLY its own changes/);
    }
  });

  it('composes with the re-sign section rather than replacing it', () => {
    const prompt = buildMergeablePrompt({
      owner: 'acme', repo: 'widgets', number: 7, provider: 'posthog_code', summary,
      resignCommits: true,
      retargetedOnto: { base: 'main', parentNumber: 41 },
    });
    expect(prompt.toLowerCase()).toContain('unsigned');
    expect(prompt).toMatch(/part of a stack/i);
  });
});

describe('prHasFixableIssues vs prNeedsFollowup (manual button vs auto-fire)', () => {
  const base: PRMergeableSummary = {
    url: 'https://github.com/acme/app/pull/1',
    headBranch: 'feat',
    baseBranch: 'main',
    mergeable: 'MERGEABLE',
    reviewDecision: 'APPROVED',
    blockingReason: 'mergeable',
    checks: { total: 5, failed: 0 },
  };

  it('non-required failing checks enable the manual button but never auto-fire', () => {
    const s: PRMergeableSummary = {
      ...base,
      blockingReason: 'checks_failed_optional',
      checks: { total: 5, failed: 1 },
    };
    expect(prNeedsFollowup(s)).toBe(false); // watcher/queue stay quiet
    expect(prHasFixableIssues(s)).toBe(true); // human can still launch a run
  });

  it.each([
    ['merge conflicts', { ...base, blockingReason: 'merge_conflicts' } as PRMergeableSummary],
    ['required checks failed', { ...base, blockingReason: 'checks_failed', checks: { total: 5, failed: 2 } } as PRMergeableSummary],
    ['changes requested', { ...base, reviewDecision: 'CHANGES_REQUESTED' } as PRMergeableSummary],
    [
      'unresolved bot threads',
      { ...base, unresolvedReviewThreads: 2, unresolvedBotReviewThreads: 2, unresolvedHumanReviewThreads: 0 } as PRMergeableSummary,
    ],
  ])('%s: both predicates agree (auto-fixable ⊆ manually-fixable)', (_label, s) => {
    expect(prNeedsFollowup(s)).toBe(true);
    expect(prHasFixableIssues(s)).toBe(true);
  });

  it('a clean PR enables neither', () => {
    expect(prNeedsFollowup(base)).toBe(false);
    expect(prHasFixableIssues(base)).toBe(false);
  });

  // Reviewers on PostHog/posthog asked us to stop starting unattended runs over
  // their review threads. A human's thread is a conversation, not a work item.
  it('unresolved HUMAN threads enable the manual button but never auto-fire', () => {
    const s: PRMergeableSummary = {
      ...base,
      unresolvedReviewThreads: 3,
      unresolvedHumanReviewThreads: 3,
      unresolvedBotReviewThreads: 0,
    };
    expect(prNeedsFollowup(s)).toBe(false);
    expect(prHasFixableIssues(s)).toBe(true);
  });

  it('a mix still auto-fires — the bot threads are real work', () => {
    const s: PRMergeableSummary = {
      ...base,
      unresolvedReviewThreads: 4,
      unresolvedHumanReviewThreads: 3,
      unresolvedBotReviewThreads: 1,
    };
    expect(prNeedsFollowup(s)).toBe(true);
  });

  it('does not auto-fire on a summary cached before the split existed', () => {
    // Absence means "we don't know who wrote them", and guessing bot would
    // resurrect exactly the behaviour this change removes. The row re-polls
    // within a tick and gains the field, so this self-heals.
    const s: PRMergeableSummary = { ...base, unresolvedReviewThreads: 2 };
    expect(prNeedsFollowup(s)).toBe(false);
    expect(prHasFixableIssues(s)).toBe(true);
  });

  it('still auto-fires on a real blocker even when every thread is human', () => {
    // The comments are not the trigger; the failing checks are. A PR that is
    // genuinely broken must not become unfixable just because people are
    // talking on it.
    const s: PRMergeableSummary = {
      ...base,
      blockingReason: 'checks_failed',
      checks: { total: 5, failed: 2 },
      unresolvedReviewThreads: 2,
      unresolvedHumanReviewThreads: 2,
      unresolvedBotReviewThreads: 0,
    };
    expect(prNeedsFollowup(s)).toBe(true);
  });
});

describe('buildMergeablePrompt — replying to human review comments', () => {
  const build = (respondToHumanComments?: boolean) =>
    buildPostHogPrompt({
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      summary,
      ...(respondToHumanComments === undefined ? {} : { respondToHumanComments }),
    });

  it('leaves the prompt untouched when the workspace has never set it', () => {
    // Absent must keep meaning today's behaviour — a new setting must not
    // silently mute every existing workspace's replies.
    const prompt = build();
    expect(prompt).not.toContain('TURNED OFF REPLYING TO HUMAN REVIEW COMMENTS');
    expect(prompt).toContain('HUMAN reviewers: their feedback takes priority');
  });

  it('leaves the prompt untouched when explicitly on', () => {
    expect(build(true)).not.toContain('TURNED OFF REPLYING TO HUMAN REVIEW COMMENTS');
  });

  it('tells the agent to leave human threads alone when off', () => {
    const prompt = build(false);
    expect(prompt).toContain('TURNED OFF REPLYING TO HUMAN REVIEW COMMENTS');
    // Not just "stay silent": replying, resolving and pushing are all off, so a
    // reviewer never sees an unexplained edit against an open thread.
    expect(prompt).toMatch(/do NOT reply to it/);
    expect(prompt).toMatch(/do NOT resolve it/);
    expect(prompt).toMatch(/do NOT push code for it/);
  });

  it('says it overrides the human-priority guidance it contradicts', () => {
    // Both sentences are in the prompt at once, so the rule has to name which
    // one wins or the agent is left to guess.
    const prompt = build(false);
    expect(prompt).toContain('HUMAN reviewers: their feedback takes priority');
    expect(prompt).toContain('overrides the human-reviewer guidance above');
  });

  it('leaves bot threads to be handled as usual', () => {
    const prompt = build(false);
    expect(prompt).toContain('Bot and automated-reviewer threads are UNAFFECTED');
    expect(prompt).toContain('BOTS and automated reviewers');
  });

  it('tells the agent that human-only leftovers are a finished run', () => {
    // Otherwise it loops: the threads it is forbidden to touch keep reading as
    // unfinished work, and the run burns its cycles going nowhere.
    expect(build(false)).toContain('that is a finished run');
  });

  it('applies to Claude Code runs too, not just PostHog Code', () => {
    const prompt = buildMergeablePrompt({
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      summary,
      provider: 'selfhosted' as CloudProviderType,
      respondToHumanComments: false,
    });
    expect(prompt).toContain('TURNED OFF REPLYING TO HUMAN REVIEW COMMENTS');
  });
});

describe('parseNeedsHumanSentinel', () => {
  it('reads the reason off the last line', () => {
    expect(
      parseNeedsHumanSentinel(
        'I checked the snapshots and they are correct.\n' +
          `${TALYN_NEEDS_HUMAN_SENTINEL} Someone must approve the 6 Visual Review baselines.`
      )
    ).toEqual({ reason: 'Someone must approve the 6 Visual Review baselines.' });
  });

  it('ignores trailing blank lines before the sentinel', () => {
    expect(
      parseNeedsHumanSentinel(`done\n${TALYN_NEEDS_HUMAN_SENTINEL} need a key\n\n   \n`)
    ).toEqual({ reason: 'need a key' });
  });

  it('does NOT fire when the agent merely discusses the sentinel', () => {
    // The whole false-positive defence. An agent explaining the protocol, or
    // quoting its own instructions, must not be read as invoking it.
    expect(
      parseNeedsHumanSentinel(
        `If I were stuck I would emit ${TALYN_NEEDS_HUMAN_SENTINEL} and stop.\n` +
          'But I was not stuck, so I fixed the build instead.'
      )
    ).toBeNull();
  });

  it('is null for ordinary closing prose, which is what an override template produces', () => {
    // A workspace that forked the prompt template loses the instruction. That
    // must degrade to "unknown" — today's behaviour — never to needs_human.
    expect(parseNeedsHumanSentinel('All checks are green and the PR is mergeable.')).toBeNull();
    expect(parseNeedsHumanSentinel('')).toBeNull();
    expect(parseNeedsHumanSentinel(null)).toBeNull();
    expect(parseNeedsHumanSentinel(undefined)).toBeNull();
  });

  it('still counts a bare sentinel, and supplies wording', () => {
    const parsed = parseNeedsHumanSentinel(`stopping\n${TALYN_NEEDS_HUMAN_SENTINEL}`);
    expect(parsed).not.toBeNull();
    expect(parsed!.reason).toMatch(/needs a person/i);
  });

  it('clamps a runaway reason rather than storing prose', () => {
    const parsed = parseNeedsHumanSentinel(`${TALYN_NEEDS_HUMAN_SENTINEL} ${'x'.repeat(500)}`);
    expect(parsed!.reason.length).toBeLessThanOrEqual(300);
    expect(parsed!.reason.endsWith('…')).toBe(true);
  });

  it('round-trips the real refusal that prompted this state', () => {
    // Verbatim from task ae66b426 on PostHog/posthog#100390, plus the line the
    // agent would now be asked to add.
    const closing =
      'PR #100390 is clean except the Visual Review gate. Storybook run 9282adc0 has 6 new / 0 ' +
      'changed / 0 unresolved snapshots; I verified all 6 PNGs as correct first baselines. ' +
      'Finalizing commits a baseline and greens a merge gate, which repo policy requires an ' +
      'explicit per-run human yes for.\n' +
      `${TALYN_NEEDS_HUMAN_SENTINEL} Finalize the 6 Visual Review baselines, or authorize me to.`;
    expect(parseNeedsHumanSentinel(closing)).toEqual({
      reason: 'Finalize the 6 Visual Review baselines, or authorize me to.',
    });
  });
});

describe('mergeableBlockerSignature', () => {
  it('is stable when nothing about the blockers changed', () => {
    expect(mergeableBlockerSignature(summary, 'BLOCKED')).toBe(
      mergeableBlockerSignature({ ...summary }, 'BLOCKED')
    );
  });

  it('changes when the failing-check digest changes', () => {
    // The re-arm trigger: a human approving Visual Review clears a failing
    // check, which is what tells the watcher its stand-down is over.
    const after = { ...summary, failingChecksDigest: 'other' } as PRMergeableSummary;
    expect(mergeableBlockerSignature(after, 'BLOCKED')).not.toBe(
      mergeableBlockerSignature(summary, 'BLOCKED')
    );
  });

  it('treats an absent merge state as UNKNOWN, so the watcher can omit it', () => {
    expect(mergeableBlockerSignature(summary)).toBe(mergeableBlockerSignature(summary, ''));
    expect(mergeableBlockerSignature(summary)).toContain('UNKNOWN');
  });
});
