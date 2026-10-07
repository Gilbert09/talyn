/**
 * The pure halves of the usage-limit work: the sentence a failed cycle shows,
 * and the phase graph's treatment of a unit waiting for its second dispatch.
 */
import { describe, expect, it } from 'vitest';
import type { FleetAgent } from '@talyn/shared';
import { decide, type DecideState } from '../services/codeReview/decide.js';
import {
  aboutDuration,
  limitedAgentFacts,
  usageLimitCycleMessage,
  type LimitedAgentFact,
} from '../services/codeReview/failureMessage.js';
import {
  capFailureDetail,
  classifyFleetFailure,
  limitedAgentsInCycle,
} from '../services/codeReview/unitFailover.js';
import type { RunRow, RunStatus } from '../services/codeReview/store.js';

const INCIDENT =
  'harness_no_output: the harness produced no agent turn: You have hit your ChatGPT usage ' +
  'limit (prolite plan). Try again in ~7194 min.';

function run(overrides: Partial<RunRow>): RunRow {
  return {
    id: 'run-1',
    reviewId: 'rev-1',
    workspaceId: 'ws-1',
    cycle: 1,
    kind: 'lens',
    lens: 'correctness',
    chunkIndex: 0,
    chunkTotal: 1,
    status: 'running' as RunStatus,
    failureCode: null,
    failureDetail: null,
    failedOverFrom: null,
    provider: 'selfhosted',
    model: 'gpt-5.6-sol',
    sandboxId: 'sb-1',
    remoteTaskId: null,
    remoteRunId: null,
    host: null,
    endpoint: null,
    eventCursor: 0,
    findingCount: 0,
    parseAttempts: 0,
    dispatchedAt: new Date(),
    settledAt: null,
    createdAt: new Date(),
    ...overrides,
  } as RunRow;
}

function state(overrides: Partial<DecideState> = {}): DecideState {
  return {
    phase: 'reviewing',
    cycle: 1,
    preset: 'standard',
    lensKeys: ['correctness', 'security', 'reliability'],
    sweep: true,
    validate: true,
    chunkTotal: 1,
    runs: [],
    unitsAllowed: 3,
    prOpen: true,
    ...overrides,
  };
}

const failed = (lens: string, failureCode: string, over: Partial<RunRow> = {}) =>
  run({ id: lens, lens, status: 'failed', failureCode, ...over });

describe('classifyFleetFailure', () => {
  it.each([
    ['the incident sentence on a Codex model', INCIDENT, 'gpt-5.6-sol', 'usage_limit', 'codex'],
    ['a sentence naming no vendor on a Codex model', 'usage limit reached', 'gpt-5.6-sol', 'usage_limit', 'codex'],
    ['a ChatGPT sentence on a Claude model', INCIDENT, 'claude-sonnet-5', 'usage_limit', 'claude'],
    ['a spent Claude subscription', "You're out of extra usage.", 'claude-sonnet-5', 'quota_exhausted', 'claude'],
    ['a spent OpenAI key', 'insufficient_quota', 'gpt-5.6-sol', 'quota_exhausted', 'codex'],
    ['the text alone when no model was recorded', INCIDENT, null, 'usage_limit', 'codex'],
    ['an unrelated error', 'guest exited 137', 'gpt-5.6-sol', null, null],
    ['no error', null, 'gpt-5.6-sol', null, null],
  ])('reads %s', (_label, detail, model, reason, agent) => {
    expect(classifyFleetFailure(detail, model)).toEqual({ reason, agent });
  });
});

describe('capFailureDetail', () => {
  it.each([
    [undefined, null],
    [null, null],
    ['', null],
    ['   ', null],
    ['  spent  ', 'spent'],
  ])('reads %j as %j', (input, expected) => {
    expect(capFailureDetail(input)).toBe(expected);
  });

  it('keeps the first 500 characters', () => {
    expect(capFailureDetail('a'.repeat(499) + 'bc')).toBe('a'.repeat(499) + 'b');
  });
});

describe('limitedAgentsInCycle', () => {
  it.each<[string, RunRow[], [FleetAgent, string][]]>([
    ['nothing failed', [run({})], []],
    ['a unit failed on a usage limit', [failed('a', 'usage_limit')], [['codex', 'usage_limit']]],
    ['a unit failed on a spent subscription', [failed('a', 'quota_exhausted', { model: 'claude-sonnet-5' })], [['claude', 'quota_exhausted']]],
    ['a unit failed for another reason', [failed('a', 'run_failed')], []],
    ['a PostHog Code unit failed', [failed('a', 'usage_limit', { provider: 'posthog_code' })], []],
    [
      'a unit waits for its second dispatch',
      [run({ status: 'requeued', failureCode: 'quota_exhausted', failedOverFrom: 'codex' })],
      [['codex', 'quota_exhausted']],
    ],
    [
      'a unit moved and then succeeded',
      [run({ status: 'succeeded', model: 'claude-opus-5', failedOverFrom: 'codex' })],
      [['codex', 'usage_limit']],
    ],
    [
      'a unit moved and was limited again',
      [failed('a', 'quota_exhausted', { model: 'claude-opus-5', failedOverFrom: 'codex' })],
      [
        ['codex', 'usage_limit'],
        ['claude', 'quota_exhausted'],
      ],
    ],
  ])('when %s', (_label, runs, expected) => {
    expect([...limitedAgentsInCycle(runs)]).toEqual(expected);
  });
});

describe('aboutDuration', () => {
  it.each([
    [20_000, 'about 1 minute'],
    [45 * 60_000, 'about 45 minutes'],
    [60 * 60_000, 'about 1 hour'],
    [5 * 3_600_000, 'about 5 hours'],
    [47 * 3_600_000, 'about 47 hours'],
    [48 * 3_600_000, 'about 2 days'],
    [7194 * 60_000, 'about 5 days'],
  ])('says %d ms as "%s"', (ms, expected) => {
    expect(aboutDuration(ms)).toBe(expected);
  });
});

describe('usageLimitCycleMessage', () => {
  const now = new Date('2026-10-07T10:00:00Z');
  const inFiveDays = new Date(now.getTime() + 7194 * 60_000);
  const fact = (over: Partial<LimitedAgentFact> = {}): LimitedAgentFact => ({
    agent: 'codex',
    reason: 'usage_limit',
    resetsAt: null,
    ...over,
  });
  const message = (
    limited: LimitedAgentFact[],
    connectedAgents: FleetAgent[],
    reauthAgents: FleetAgent[] = []
  ) => usageLimitCycleMessage({ limited, connectedAgents, reauthAgents, now });

  it.each<[string, LimitedAgentFact[], FleetAgent[], FleetAgent[], string]>([
    [
      'the other agent is not connected, with a reset time',
      [fact({ resetsAt: inFiveDays })],
      ['codex'],
      [],
      'Codex reported a usage limit and no other agent is connected to run the review. Try again in about 5 days, or connect Claude.',
    ],
    [
      'the other agent is not connected, with no reset time',
      [fact()],
      ['codex'],
      [],
      'Codex reported a usage limit and no other agent is connected to run the review. Try again later, or connect Claude.',
    ],
    [
      'the other agent needs a reconnect',
      [fact({ resetsAt: inFiveDays })],
      ['codex', 'claude'],
      ['claude'],
      'Codex reported a usage limit and Claude needs to be reconnected. Try again in about 5 days, or reconnect Claude in Settings.',
    ],
    [
      'the other agent is connected',
      [fact()],
      ['codex', 'claude'],
      [],
      'Codex reported a usage limit and Claude could not take the review. Try again later.',
    ],
    [
      'a reset time already in the past',
      [fact({ resetsAt: new Date(now.getTime() - 1000) })],
      ['codex', 'claude'],
      [],
      'Codex reported a usage limit and Claude could not take the review. Try again later.',
    ],
    [
      'a spent Claude subscription with Codex not connected',
      [fact({ agent: 'claude', reason: 'quota_exhausted' })],
      ['claude'],
      [],
      'Claude usage is exhausted and no other agent is connected to run the review. Add usage for Claude, try again later, or connect Codex.',
    ],
    [
      'both agents rate limited, with the earlier reset',
      [
        fact({ resetsAt: inFiveDays }),
        fact({ agent: 'claude', resetsAt: new Date(now.getTime() + 20 * 60_000) }),
      ],
      ['codex', 'claude'],
      [],
      'Codex and Claude both reported a usage limit. Try again in about 20 minutes.',
    ],
    [
      'one agent limited and the other spent',
      [fact(), fact({ agent: 'claude', reason: 'quota_exhausted' })],
      ['codex', 'claude'],
      [],
      'Codex reported a usage limit and Claude usage is exhausted. Add usage for Claude, or try again later.',
    ],
    [
      'no unit names an agent',
      [],
      ['codex'],
      [],
      'A usage limit stopped every reviewer. Try again later.',
    ],
  ])('when %s', (_label, limited, connected, reauth, expected) => {
    expect(message(limited, connected, reauth)).toBe(expected);
  });
});

describe('limitedAgentFacts', () => {
  const settledAt = new Date('2026-10-07T10:00:00Z');

  it('counts the vendor wait from when the unit settled, not from now', () => {
    const facts = limitedAgentFacts([
      failed('a', 'usage_limit', { failureDetail: INCIDENT, settledAt }),
    ]);
    expect(facts).toEqual([
      {
        agent: 'codex',
        reason: 'usage_limit',
        resetsAt: new Date(settledAt.getTime() + 7194 * 60_000),
      },
    ]);
  });

  it('never invents a reset time', () => {
    const facts = limitedAgentFacts([
      failed('a', 'usage_limit', { failureDetail: 'usage limit reached', settledAt }),
    ]);
    expect(facts[0]!.resetsAt).toBeNull();
  });

  it('reads one fact per agent and fills in a reset a later unit carried', () => {
    const facts = limitedAgentFacts([
      failed('a', 'usage_limit', { settledAt }),
      failed('b', 'usage_limit', { failureDetail: INCIDENT, settledAt }),
      failed('c', 'run_failed', { settledAt }),
      run({ status: 'succeeded' }),
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.resetsAt).not.toBeNull();
  });
});

describe('decide, for a unit waiting for its second dispatch', () => {
  const requeued = run({ status: 'requeued', failedOverFrom: 'codex', failureCode: 'usage_limit' });
  const others = [
    run({ id: 's', lens: 'security' }),
    run({ id: 'r', lens: 'reliability' }),
  ];

  it('dispatches it again when the ceiling has room', () => {
    expect(decide(state({ runs: [requeued, ...others], unitsAllowed: 1 }))).toEqual([
      { type: 'dispatch', unit: { kind: 'lens', lens: 'correctness', chunkIndex: 0 } },
    ]);
  });

  it('waits when the workspace ceiling is full', () => {
    expect(decide(state({ runs: [requeued, ...others], unitsAllowed: 0 }))).toEqual([]);
  });

  it('does not end the phase while it waits, even when every other unit settled', () => {
    const settled = others.map((r) => ({ ...r, status: 'succeeded' }) as RunRow);
    expect(decide(state({ runs: [requeued, ...settled], unitsAllowed: 0 }))).toEqual([]);
  });

  it('does not dispatch a unit that is already running its second run', () => {
    const second = run({ status: 'running', failedOverFrom: 'codex', model: 'claude-opus-5' });
    expect(decide(state({ runs: [second, ...others] }))).toEqual([]);
  });
});

describe('decide, when no reviewer finished', () => {
  const all = (codes: string[]) =>
    ['correctness', 'security', 'reliability'].map((lens, i) => failed(lens, codes[i]!));

  it.each([
    ['every unit hit a usage limit', ['usage_limit', 'usage_limit', 'usage_limit'], 'usage_limit'],
    ['every unit found a spent subscription', ['quota_exhausted', 'quota_exhausted', 'quota_exhausted'], 'quota_exhausted'],
    ['the two limit codes are mixed', ['usage_limit', 'quota_exhausted', 'usage_limit'], 'usage_limit'],
    ['a limit is mixed with another failure', ['usage_limit', 'usage_limit', 'run_failed'], 'no_reviewer_finished'],
    ['every unit was unparseable', ['unparseable', 'unparseable', 'unparseable'], 'no_reviewer_finished'],
    ['every unit timed out', ['timeout', 'timeout', 'timeout'], 'timeout'],
  ])('fails the cycle with the right code when %s', (_label, codes, expected) => {
    const actions = decide(state({ runs: all(codes) }));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'fail', code: expected });
  });
});
