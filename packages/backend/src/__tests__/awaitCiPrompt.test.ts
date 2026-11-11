import { describe, it, expect } from 'vitest';
import {
  TALYN_AWAIT_CI_SENTINEL,
  TALYN_NEEDS_HUMAN_SENTINEL,
  TASK_STATUS_TERMINAL,
  ACTIVE_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  awaitCiRule,
  buildAwaitCiResumePrompt,
  buildMergeablePrompt,
  parseAwaitCiSentinel,
  parseNeedsHumanSentinel,
  postHogCodeLoopRules,
  withAwaitCiRule,
  FEATURE_FLAGS,
  type AwaitCiOutcome,
  type CloudProviderType,
  type PRMergeableSummary,
} from '@talyn/shared';

const summary = {
  url: 'https://github.com/acme/widgets/pull/7',
  title: 'Add gizmo',
  headBranch: 'feature/x',
  baseBranch: 'main',
  mergeable: 'MERGEABLE',
  blockingReason: 'checks_failed',
  reviewDecision: null,
  checks: { total: 3, failed: 1 },
} as unknown as PRMergeableSummary;

const input = { owner: 'acme', repo: 'widgets', number: 7, summary };
const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('parseAwaitCiSentinel', () => {
  it.each([
    ['full sha on the last line', `pushed\n${TALYN_AWAIT_CI_SENTINEL} ${SHA}`, SHA],
    ['short sha', `${TALYN_AWAIT_CI_SENTINEL} abc1234`, 'abc1234'],
    ['trailing blank lines', `pushed\n${TALYN_AWAIT_CI_SENTINEL} ${SHA}\n\n   \n`, SHA],
    ['sha in backticks', `${TALYN_AWAIT_CI_SENTINEL} \`${SHA}\``, SHA],
    ['upper-case sha', `${TALYN_AWAIT_CI_SENTINEL} ${SHA.toUpperCase()}`, SHA],
    ['indented line', `done\n   ${TALYN_AWAIT_CI_SENTINEL} ${SHA}`, SHA],
  ])('reads %s', (_name, text, sha) => {
    expect(parseAwaitCiSentinel(text)).toEqual({ headSha: sha });
  });

  it.each([
    ['no value', `${TALYN_AWAIT_CI_SENTINEL}`],
    ['too short', `${TALYN_AWAIT_CI_SENTINEL} abc12`],
    ['too long', `${TALYN_AWAIT_CI_SENTINEL} ${SHA}0`],
    ['not hex', `${TALYN_AWAIT_CI_SENTINEL} not-a-sha`],
    ['prose after the sha', `${TALYN_AWAIT_CI_SENTINEL} ${SHA} please wait`],
  ])('keeps the sentinel but drops a bad sha: %s', (_name, text) => {
    expect(parseAwaitCiSentinel(text)).toEqual({ headSha: null });
  });

  it.each([
    ['empty', ''],
    ['null', null],
    ['undefined', undefined],
    ['plain prose', 'All checks are green and the PR is mergeable.'],
    ['a mention in prose', `I will end with ${TALYN_AWAIT_CI_SENTINEL} ${SHA} later.\nDone for now.`],
    ['sentinel not on the last line', `${TALYN_AWAIT_CI_SENTINEL} ${SHA}\nand then I kept going`],
    ['the needs-human sentinel', `${TALYN_NEEDS_HUMAN_SENTINEL} need an approval`],
    ['a lower-case prefix', `talyn_await_ci: ${SHA}`],
  ])('is unknown for %s', (_name, text) => {
    expect(parseAwaitCiSentinel(text as string | null | undefined)).toBeNull();
  });

  it('does not collide with the needs-human parser', () => {
    const text = `pushed\n${TALYN_AWAIT_CI_SENTINEL} ${SHA}`;
    expect(parseNeedsHumanSentinel(text)).toBeNull();
  });
});

describe('the CI WAITING rule in the mergeable prompt', () => {
  it.each<[CloudProviderType, boolean | undefined, boolean]>([
    ['selfhosted', true, true],
    ['selfhosted', false, false],
    ['selfhosted', undefined, false],
    ['posthog_code', true, false],
    ['posthog_code', undefined, false],
  ])('provider %s with awaitCi %s includes the rule: %s', (provider, awaitCi, expected) => {
    const prompt = buildMergeablePrompt({ ...input, provider, ...(awaitCi === undefined ? {} : { awaitCi }) });
    expect(prompt.includes(TALYN_AWAIT_CI_SENTINEL)).toBe(expected);
    expect(prompt.includes('wait for CI to finish')).toBe(!expected);
  });

  it('keeps the default loop rules byte-identical when off', () => {
    expect(postHogCodeLoopRules('acme/widgets#7')).toBe(postHogCodeLoopRules('acme/widgets#7', { awaitCi: false }));
    expect(postHogCodeLoopRules('acme/widgets#7')).toContain(
      '  - After every publish, wait for CI to finish, then re-check all of: (1) review comments, (2) check status, and (3) mergeability — conflicts',
    );
  });

  it('tells the agent never to sleep-poll for CI', () => {
    expect(awaitCiRule()).toMatch(/NEVER sleep or poll/);
    expect(awaitCiRule()).toContain('git rev-parse HEAD');
  });

  it('reaches a workspace template that renders loopRules', () => {
    const prompt = buildMergeablePrompt({
      ...input,
      provider: 'selfhosted',
      awaitCi: true,
      template: 'Fix {{pr.ref}}.\n\n{{loopRules}}',
    });
    expect(prompt).toContain(TALYN_AWAIT_CI_SENTINEL);
  });
});

describe('withAwaitCiRule', () => {
  it('replaces the wait line and appends the rule to a default prompt', () => {
    const base = buildMergeablePrompt({ ...input, provider: 'selfhosted' });
    const out = withAwaitCiRule(base);
    expect(out).not.toContain('wait for CI to finish');
    expect(out).toContain('end your turn as the CI WAITING rule says');
    expect(out.endsWith(awaitCiRule())).toBe(true);
  });

  it('reaches a template override that drops loopRules', () => {
    const base = buildMergeablePrompt({ ...input, provider: 'selfhosted', template: 'Just fix {{pr.ref}}.' });
    const out = withAwaitCiRule(base);
    expect(out).toBe(`Just fix acme/widgets#7.\n\n${awaitCiRule()}`);
  });

  it('is idempotent', () => {
    const once = withAwaitCiRule(buildMergeablePrompt({ ...input, provider: 'selfhosted' }));
    expect(withAwaitCiRule(once)).toBe(once);
    const built = buildMergeablePrompt({ ...input, provider: 'selfhosted', awaitCi: true });
    expect(withAwaitCiRule(built)).toBe(built);
  });
});

describe('buildAwaitCiResumePrompt', () => {
  it.each<[string, AwaitCiOutcome, RegExp]>([
    ['passing', { kind: 'passing' }, /no required check is failing/],
    ['failing with names', { kind: 'failing', checks: ['lint', 'Django tests'] }, /`lint`, `Django tests`/],
    ['failing without names', { kind: 'failing', checks: [] }, /some checks failed/],
    ['head moved', { kind: 'head_moved', headSha: 'fedcba9876543210' }, /moved from 0123456789ab to fedcba987654/],
    ['timed out', { kind: 'timed_out' }, /did not finish/],
  ])('says what happened: %s', (_name, outcome, pattern) => {
    const prompt = buildAwaitCiResumePrompt({ ref: 'acme/widgets#7', headSha: SHA, outcome });
    expect(prompt).toMatch(pattern);
    expect(prompt).toContain('acme/widgets#7');
    // Every resume asks for the sentinel again after the next publish.
    expect(prompt).toContain(TALYN_AWAIT_CI_SENTINEL);
  });
});

describe('waiting_ci status', () => {
  it('is active, never terminal', () => {
    expect(TASK_STATUS_TERMINAL.waiting_ci).toBe(false);
    expect(ACTIVE_TASK_STATUSES).toContain('waiting_ci');
    expect(TERMINAL_TASK_STATUSES).not.toContain('waiting_ci');
  });
});

describe('the ci-park flag', () => {
  it('fails closed and is withheld from release notes under its own scope', () => {
    expect(FEATURE_FLAGS.ciPark).toMatchObject({
      posthogKey: 'ci-park',
      envOverride: 'CI_PARK_ENABLED',
      fallback: false,
      availability: 'gated',
    });
    expect(FEATURE_FLAGS.ciPark.releaseScopes).not.toContain('fleet');
  });
});
