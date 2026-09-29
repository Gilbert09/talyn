import { describe, it, expect } from 'vitest';
import {
  deriveCiVerdict,
  humanGatesIn,
  prBlocksMerge,
  prNeedsFollowup,
  prNeedsHuman,
  type CheckFact,
  type PRMergeableSummary,
} from '@talyn/shared';

const fact = (
  name: string,
  state: CheckFact['state'],
  required: boolean | null = true,
  rawState?: string,
): CheckFact => ({ name, state, required, rawState, url: null });

const VR = (state: CheckFact['state'] = 'failure', rawState = 'FAILURE', name = 'PostHog Visual Review / storybook') =>
  fact(name, state, false, rawState);

describe('deriveCiVerdict', () => {
  it.each<[string, CheckFact[], Record<string, string>, string, number]>([
    ['no checks', [], {}, 'none', 0],
    ['all green', [fact('a', 'success'), fact('b', 'skipped')], {}, 'passing', 0],
    ['still running', [fact('a', 'success'), fact('b', 'pending')], {}, 'running', 0],
    ['a required failure beats running', [fact('a', 'failure'), fact('b', 'in_progress')], {}, 'failing_required', 0],
    ['only optional failures', [fact('a', 'failure', false), fact('b', 'success')], {}, 'failing_optional', 0],
    ['optional failure while running reads running', [fact('a', 'failure', false), fact('b', 'pending')], {}, 'running', 0],
    ['unknown required-ness reads required', [fact('a', 'failure', null)], {}, 'failing_required', 0],
    [
      'unknown is optional only when GitHub says MERGEABLE + UNSTABLE',
      [fact('a', 'failure', null)],
      { mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE' },
      'failing_optional',
      0,
    ],
    [
      'UNSTABLE on an unknown mergeable vouches for nothing',
      [fact('a', 'failure', null)],
      { mergeable: 'UNKNOWN', mergeStateStatus: 'UNSTABLE' },
      'failing_required',
      0,
    ],
    [
      'Visual Review plus the required check it fails',
      [VR(), fact('Visual regression tests pass', 'failure'), fact('Complete Visual Review run', 'failure', false)],
      {},
      'needs_human',
      1,
    ],
    ['Visual Review wins over running checks', [VR(), fact('Django Tests Pass', 'pending')], {}, 'needs_human', 1],
    [
      'Visual Review plus a real required failure',
      [VR(), fact('Visual regression tests pass', 'failure'), fact('Django Tests Pass', 'failure')],
      {},
      'failing_required',
      1,
    ],
    ['a Visual Review that errored is CI, not a person', [VR('failure', 'ERROR'), fact('Visual regression tests pass', 'failure')], {}, 'failing_required', 0],
    ['a tracking-only status does not gate', [VR('failure', 'FAILURE', 'PostHog Visual Review / storybook (tracking)')], {}, 'failing_optional', 0],
    ['a partial status does not gate', [VR('failure', 'FAILURE', 'PostHog Visual Review / playwright (partial)')], {}, 'failing_optional', 0],
    ['a passing Visual Review is not a gate', [VR('success', 'SUCCESS'), fact('a', 'success')], {}, 'passing', 0],
    ['a consequence with no failing gate is an ordinary failure', [fact('Visual regression tests pass', 'failure')], {}, 'failing_required', 0],
    ['a gate row with no raw state (older ledger rows) still gates', [fact('PostHog Visual Review / storybook', 'failure', false)], {}, 'needs_human', 1],
  ])('%s → %s', (_l, facts, pr, ciStatus, gates) => {
    const v = deriveCiVerdict(facts, pr);
    expect(v.ciStatus).toBe(ciStatus);
    expect(v.humanGates).toHaveLength(gates);
  });

  it('counts blocking, unknown and optional failures separately', () => {
    const v = deriveCiVerdict([
      fact('req', 'failure', true),
      fact('unk', 'failure', null),
      fact('opt', 'failure', false),
      fact('ok', 'success'),
    ]);
    expect(v).toMatchObject({ blockingFailing: 2, unknownFailing: 1, optionalFailing: 1 });
  });
});

describe('humanGatesIn', () => {
  it('attributes the gate and its consequences, and nothing else', () => {
    const { gates, attributed } = humanGatesIn([VR(), fact('Django Tests Pass', 'failure')]);
    expect(gates.map((g) => g.label)).toEqual(['Visual review']);
    expect([...attributed].sort()).toEqual([
      'Complete Visual Review run',
      'PostHog Visual Review / storybook',
      'Visual regression tests pass',
    ]);
  });
});

describe('predicates over needs_human', () => {
  const summary = (blockingReason: PRMergeableSummary['blockingReason']): PRMergeableSummary => ({
    url: 'u',
    headBranch: 'h',
    baseBranch: 'main',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    blockingReason,
    checks: { total: 3, failed: 2 },
  });

  it.each([
    ['needs_human', true, true, false],
    ['checks_failed', false, true, true],
    ['checks_failed_optional', false, false, false],
    ['blocked', false, false, false],
    ['mergeable', false, false, false],
  ] as const)('%s → needsHuman=%s, blocksMerge=%s, needsFollowup=%s', (reason, human, blocks, followup) => {
    const s = summary(reason);
    expect(prNeedsHuman(s)).toBe(human);
    // A human gate blocks the merge (the queue must not submit) …
    expect(prBlocksMerge(s)).toBe(blocks);
    // … and is never agent work.
    expect(prNeedsFollowup(s)).toBe(followup);
  });

  it('still follows up on bot threads while a human gate stands', () => {
    expect(prNeedsFollowup({ ...summary('needs_human'), unresolvedBotReviewThreads: 1 })).toBe(true);
  });
});
