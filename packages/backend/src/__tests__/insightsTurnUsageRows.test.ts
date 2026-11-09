import { describe, expect, it } from 'vitest';
import {
  buildTurnUsageRows,
  codexDelta,
  parseStoredResult,
  UNKNOWN_MODEL,
  type ChatFacts,
  type StoredResultUsage,
  type TurnFacts,
} from '../services/insights/turnUsageRows.js';
import { bootSampleFromMetric } from '../services/insights/bootSamples.js';
import { parseInsightsRange, utcDays } from '../services/insights/range.js';

const T0 = new Date('2026-11-01T10:00:00.000Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

const claudeChat: ChatFacts = { chatId: 'c1', workbenchId: 'wb', workspaceId: 'ws', agent: 'claude', model: 'claude-chat-model' };
const codexChat: ChatFacts = { ...claudeChat, agent: 'codex', model: 'gpt-codex' };

function result(overrides: Partial<StoredResultUsage> = {}): StoredResultUsage {
  return {
    seq: 10, at: at(60), sessionId: 's1', usage: null, modelUsage: null,
    costUsd: null, durationMs: null, numTurns: null, isError: false, ...overrides,
  };
}

function facts(results: StoredResultUsage[], overrides: Partial<TurnFacts> = {}): TurnFacts {
  return { turn: 1, startedAt: T0, endedAt: at(60), initModel: null, sentAt: at(1), replyAt: at(4), results, ...overrides };
}

const codexUsage = (input: number, cached: number, output: number, cacheWrite = 0) => ({
  input_tokens: input, cache_read_input_tokens: cached, output_tokens: output, cache_creation_input_tokens: cacheWrite,
});

describe('buildTurnUsageRows: Claude', () => {
  it('splits by modelUsage, keeps each model cost, and puts turn facts on the init model', () => {
    const rows = buildTurnUsageRows(claudeChat, facts([result({
      modelUsage: {
        'claude-main': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 200, costUSD: 0.25 },
        'claude-small': { inputTokens: 900, outputTokens: 900, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 },
      },
      costUsd: 0.26, durationMs: 42_000, numTurns: 7,
    })], { initModel: 'claude-main' }));
    expect(rows).toHaveLength(2);
    const main = rows.find((r) => r.model === 'claude-main')!;
    const small = rows.find((r) => r.model === 'claude-small')!;
    expect(main).toMatchObject({
      isPrimary: true, inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 200,
      costEstimateMicros: 250_000, durationMs: 42_000, agentSteps: 7, firstReplyMs: 3000, agent: 'claude', endedAt: at(60),
    });
    expect(small).toMatchObject({ isPrimary: false, costEstimateMicros: 10_000, durationMs: null, agentSteps: null, firstReplyMs: null });
  });

  it('adds up two runs of one turn (a relaunch spent tokens twice)', () => {
    const run = (seq: number, cost: number) => result({
      seq, modelUsage: { m: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: cost } },
      durationMs: 1000, numTurns: 2,
    });
    const [row] = buildTurnUsageRows(claudeChat, facts([run(12, 0.5), run(5, 0.25)]));
    expect(row).toMatchObject({
      model: 'm', inputTokens: 20, outputTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 80,
      costEstimateMicros: 750_000, durationMs: 2000, agentSteps: 4,
    });
  });

  it.each<[string, Partial<TurnFacts>, string]>([
    ['the init model', { initModel: 'from-init' }, 'from-init'],
    ['the chat model', { initModel: null }, 'claude-chat-model'],
  ])('falls back to usage and %s without modelUsage', (_label, override, model) => {
    const [row] = buildTurnUsageRows(claudeChat, facts([result({
      usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8 }, costUsd: 0.1,
    })], override));
    expect(row).toMatchObject({ model, inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8, costEstimateMicros: 100_000 });
  });

  it('stores unknown when nothing names a model', () => {
    const [row] = buildTurnUsageRows({ ...claudeChat, model: null }, facts([result({ usage: { input_tokens: 1 } })]));
    expect(row.model).toBe(UNKNOWN_MODEL);
  });

  it('puts the total cost on the main model when modelUsage has no costs', () => {
    const [row] = buildTurnUsageRows(claudeChat, facts([result({
      modelUsage: { m: { inputTokens: 1, outputTokens: 1 } }, costUsd: 1.5,
    })]));
    expect(row.costEstimateMicros).toBe(1_500_000);
  });

  it('picks the model that did the most when the init model is not in modelUsage', () => {
    const rows = buildTurnUsageRows(claudeChat, facts([result({
      modelUsage: { a: { inputTokens: 1, outputTokens: 1 }, b: { inputTokens: 100, outputTokens: 100 } },
    })], { initModel: 'claude-x[1m]' }));
    expect(rows.find((r) => r.isPrimary)?.model).toBe('b');
  });

  it.each<[string, Partial<StoredResultUsage>, boolean]>([
    ['success', {}, false],
    ['an error result', { isError: true }, true],
  ])('marks %s', (_label, override, isError) => {
    const [row] = buildTurnUsageRows(claudeChat, facts([result(override)]));
    expect(row.isError).toBe(isError);
  });

  it.each<[string, Partial<TurnFacts>, number | null]>([
    ['reply after send', { sentAt: at(1), replyAt: at(4) }, 3000],
    ['no sent time', { sentAt: null }, null],
    ['no reply', { replyAt: null }, null],
    ['reply before send (clock skew)', { sentAt: at(5), replyAt: at(4) }, null],
  ])('first reply: %s', (_label, override, expected) => {
    const [row] = buildTurnUsageRows(claudeChat, facts([result()], override));
    expect(row.firstReplyMs).toBe(expected);
  });

  it('uses the event span when the result reports no duration', () => {
    const [row] = buildTurnUsageRows(claudeChat, facts([result()], { startedAt: at(0), endedAt: at(90) }));
    expect(row.durationMs).toBe(90_000);
  });

  it('returns nothing for a turn with no result event', () => {
    expect(buildTurnUsageRows(claudeChat, facts([]))).toEqual([]);
  });

  it.each([
    ['negative', -5], ['NaN string', 'abc'], ['huge float', 1.6],
  ])('cleans an odd token count (%s)', (_label, value) => {
    const [row] = buildTurnUsageRows(claudeChat, facts([result({ usage: { input_tokens: value } })]));
    expect(row.inputTokens).toBe(typeof value === 'number' && value > 0 ? 2 : 0);
  });
});

describe('buildTurnUsageRows: model and agent attribution', () => {
  const codexUsageResult = () => result({ usage: codexUsage(10, 0, 1) });
  const claudeResult = () => result({ modelUsage: { 'claude-opus-5-5': { inputTokens: 5, outputTokens: 5, costUSD: 0.5 } }, costUsd: 0.5 });

  it.each<[string, Partial<ChatFacts>, Partial<TurnFacts>, string]>([
    ['a Codex chat in a Claude session never takes the session model',
      { model: null, sessionAgent: 'claude', sessionModel: 'claude-opus-5-5' }, {}, UNKNOWN_MODEL],
    ['a Codex chat in a Codex session takes the session model',
      { model: null, sessionAgent: 'codex', sessionModel: 'gpt-6.1-sol' }, {}, 'gpt-6.1-sol'],
    ['a Claude model on a Codex chat is not the Codex model',
      { model: 'claude-sonnet-5', sessionAgent: 'claude', sessionModel: 'claude-sonnet-5' }, {}, UNKNOWN_MODEL],
    ['a Claude alias on a Codex chat is not the Codex model',
      { model: 'opus', sessionAgent: 'codex', sessionModel: 'gpt-6-astra' }, {}, 'gpt-6-astra'],
    ['the stamped model wins over the chat model',
      { model: 'gpt-6-luna' }, { turnModel: 'gpt-6-astra' }, 'gpt-6-astra'],
    ['a stamped agent default is unknown, whatever the chat says now',
      { model: 'gpt-6-luna', sessionAgent: 'codex', sessionModel: 'gpt-6-luna' }, { turnModel: null }, UNKNOWN_MODEL],
    ['a stamped Claude model on a Codex turn is unknown',
      { model: null }, { turnModel: 'claude-opus-5-5' }, UNKNOWN_MODEL],
  ])('Codex: %s', (_label, chatOverride, factsOverride, model) => {
    const [row] = buildTurnUsageRows({ ...codexChat, ...chatOverride }, facts([codexUsageResult()], factsOverride));
    expect(row).toMatchObject({ model, agent: 'codex' });
  });

  it.each<[string, Partial<ChatFacts>, Partial<TurnFacts>, string]>([
    ['an alias is the newest model of its family', { model: 'sonnet' }, {}, 'claude-sonnet-5-5'],
    ['an alias in any case', { model: 'Opus' }, {}, 'claude-opus-5-5'],
    ['fable', { model: 'fable' }, {}, 'claude-fable-5-2'],
    ['a full id stays', { model: 'claude-sonnet-5' }, {}, 'claude-sonnet-5'],
    ['a stamped alias', { model: null }, { turnModel: 'sonnet' }, 'claude-sonnet-5-5'],
    ['the init model wins over the stamp', { model: null }, { turnModel: 'claude-sonnet-5', initModel: 'claude-opus-5-5' }, 'claude-opus-5-5'],
    ['a Codex model on a Claude chat falls to the session model',
      { model: 'gpt-6.1-sol', sessionAgent: 'claude', sessionModel: 'claude-sonnet-5-5' }, {}, 'claude-sonnet-5-5'],
    ['a Claude chat in a Codex session never takes the session model',
      { model: null, sessionAgent: 'codex', sessionModel: 'gpt-6.1-sol' }, {}, UNKNOWN_MODEL],
  ])('Claude without modelUsage: %s', (_label, chatOverride, factsOverride, model) => {
    const [row] = buildTurnUsageRows({ ...claudeChat, ...chatOverride },
      facts([result({ usage: { input_tokens: 1 }, isError: true })], factsOverride));
    expect(row).toMatchObject({ model, agent: 'claude' });
  });

  it('keeps a Claude turn as Claude when the chat moved to Codex later', () => {
    const rows = buildTurnUsageRows({ ...codexChat, model: 'gpt-6-astra' },
      facts([claudeResult()], { initAgent: 'claude', initModel: 'claude-opus-5-5' }));
    expect(rows).toEqual([expect.objectContaining({ model: 'claude-opus-5-5', agent: 'claude', costEstimateMicros: 500_000, isPrimary: true })]);
  });

  it('keeps a Codex turn as Codex when the chat moved to Claude later', () => {
    const rows = buildTurnUsageRows({ ...claudeChat, model: 'claude-opus-5-5', sessionAgent: 'claude', sessionModel: 'claude-opus-5-5' },
      facts([codexUsageResult()], { initAgent: 'codex', turnModel: 'gpt-6-astra' }));
    expect(rows).toEqual([expect.objectContaining({ model: 'gpt-6-astra', agent: 'codex', inputTokens: 10, costEstimateMicros: null })]);
  });

  it('uses the chat agent when the turn has no init event', () => {
    const [row] = buildTurnUsageRows(codexChat, facts([codexUsageResult()], { initAgent: null }));
    expect(row.agent).toBe('codex');
  });
});

describe('codexDelta: Codex reports thread totals', () => {
  it.each<[string, StoredResultUsage, StoredResultUsage | null, Record<string, number>]>([
    ['first turn: its own totals, cached tokens taken out of input',
      result({ usage: codexUsage(21_905, 8064, 5) }), null,
      { inputTokens: 13_841, cacheReadTokens: 8064, outputTokens: 5, cacheWriteTokens: 0 }],
    ['second turn: the difference (the numbers a real two-turn thread reported)',
      result({ seq: 20, usage: codexUsage(43_828, 29_824, 22) }), result({ usage: codexUsage(21_905, 8064, 5) }),
      { inputTokens: 163, cacheReadTokens: 21_760, outputTokens: 17, cacheWriteTokens: 0 }],
    ['a new thread (other session id): its own totals',
      result({ seq: 20, sessionId: 's2', usage: codexUsage(500, 100, 10) }), result({ usage: codexUsage(400, 50, 5) }),
      { inputTokens: 400, cacheReadTokens: 100, outputTokens: 10, cacheWriteTokens: 0 }],
    ['a counter went down: a reset, its own totals',
      result({ seq: 20, usage: codexUsage(300, 10, 50) }), result({ usage: codexUsage(1000, 20, 5) }),
      { inputTokens: 290, cacheReadTokens: 10, outputTokens: 50, cacheWriteTokens: 0 }],
    ['cache writes are differenced too',
      result({ seq: 20, usage: codexUsage(200, 0, 2, 70) }), result({ usage: codexUsage(100, 0, 1, 30) }),
      { inputTokens: 100, cacheReadTokens: 0, outputTokens: 1, cacheWriteTokens: 40 }],
    ['the previous result has no usage: own totals',
      result({ seq: 20, usage: codexUsage(10, 0, 1) }), result({ usage: null }),
      { inputTokens: 10, cacheReadTokens: 0, outputTokens: 1, cacheWriteTokens: 0 }],
  ])('%s', (_label, current, previous, expected) => {
    expect(codexDelta(current, previous)).toEqual(expected);
  });

  it('chains results inside one turn and from the turn before', () => {
    const previous = result({ seq: 1, usage: codexUsage(100, 0, 10) });
    const rows = buildTurnUsageRows(codexChat, facts([
      result({ seq: 30, usage: codexUsage(400, 100, 40) }),
      result({ seq: 20, usage: codexUsage(250, 50, 25) }),
    ]), previous);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: 'gpt-codex', agent: 'codex', isPrimary: true,
      inputTokens: 200, cacheReadTokens: 100, outputTokens: 30, costEstimateMicros: null, agentSteps: null,
    });
  });

  it('stores Codex under the chat model, never an init model', () => {
    const [row] = buildTurnUsageRows(codexChat, facts([result({ usage: codexUsage(1, 0, 1) })], { initModel: 'other' }));
    expect(row.model).toBe('gpt-codex');
  });
});

describe('parseStoredResult', () => {
  it.each<[string, unknown, Partial<StoredResultUsage> | null]>([
    ['a full result', { seq: 3, at: T0.toISOString(), sessionId: 's', usage: { a: 1 }, modelUsage: { m: {} }, cost: 0.5, durationMs: 9, numTurns: 2, isError: false, subtype: 'success' },
      { seq: 3, sessionId: 's', costUsd: 0.5, durationMs: 9, numTurns: 2, isError: false }],
    ['an error subtype', { seq: 3, at: T0.toISOString(), subtype: 'error_max_turns' }, { isError: true }],
    ['arrays and strings are not objects', { seq: 3, at: T0.toISOString(), usage: [1], modelUsage: 'x', cost: '1' }, { usage: null, modelUsage: null, costUsd: null }],
    ['no seq', { at: T0.toISOString() }, null],
    ['a bad date', { seq: 1, at: 'nope' }, null],
    ['not an object', 'x', null],
  ])('%s', (_label, raw, expected) => {
    const parsed = parseStoredResult(raw);
    if (expected === null) expect(parsed).toBeNull();
    else expect(parsed).toMatchObject(expected);
  });
});

describe('bootSampleFromMetric', () => {
  it.each<[string, string, Record<string, unknown>, unknown]>([
    ['a box start', 'box_created', { totalMs: 41_234, cause: 'new', layer: 'user' }, { kind: 'box_start', ms: 41_234, cause: 'new', layer: 'user', source: null }],
    ['a box start with its time as a string (the backfill reads text)', 'box_created', { totalMs: '1200' }, { kind: 'box_start', ms: 1200, cause: null, layer: null, source: null }],
    ['a box start with no total', 'box_created', { totalMs: null }, null],
    ['a successful wake', 'wake_end', { ms: 900, ok: true, from: 'host' }, { kind: 'wake', ms: 900, cause: null, layer: null, source: 'host' }],
    ['a successful wake read as text', 'wake_end', { ms: '900', ok: 'true', from: 'storage' }, { kind: 'wake', ms: 900, cause: null, layer: null, source: 'storage' }],
    ['a failed wake', 'wake_end', { ms: 900, ok: false }, null],
    ['a wake with no time', 'wake_end', { ms: null, ok: true }, null],
    ['a negative time', 'box_created', { totalMs: -1 }, null],
    ['another metric', 'wake_start', { ms: 5 }, null],
  ])('%s', (_label, metric, fields, expected) => {
    expect(bootSampleFromMetric(metric, fields)).toEqual(expected);
  });
});

describe('parseInsightsRange', () => {
  const now = new Date('2026-11-04T12:00:00.000Z');
  const period = { start: new Date('2026-10-20T08:00:00.000Z'), end: new Date('2026-11-20T08:00:00.000Z') };
  it.each<[string, Record<string, unknown>, { from: string; to: string; preset: string } | { error: RegExp }]>([
    ['default: last 30 days', {}, { from: '2026-10-05T12:00:00.000Z', to: now.toISOString(), preset: '30d' }],
    ['7d', { range: '7d' }, { from: '2026-10-28T12:00:00.000Z', to: now.toISOString(), preset: '7d' }],
    ['30d', { range: '30d' }, { from: '2026-10-05T12:00:00.000Z', to: now.toISOString(), preset: '30d' }],
    ['period: start to now', { range: 'period' }, { from: period.start.toISOString(), to: now.toISOString(), preset: 'period' }],
    ['custom', { from: '2026-09-01T00:00:00Z', to: '2026-09-08T00:00:00Z' }, { from: '2026-09-01T00:00:00.000Z', to: '2026-09-08T00:00:00.000Z', preset: 'custom' }],
    ['custom named explicitly', { range: 'custom', from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z', preset: 'custom' }],
    ['unknown preset', { range: '90d' }, { error: /7d, 30d or period/ }],
    ['only from', { from: '2026-09-01T00:00:00Z' }, { error: /both from and to/ }],
    ['bad date', { from: 'yesterday', to: '2026-09-01T00:00:00Z' }, { error: /ISO dates/ }],
    ['from after to', { from: '2026-09-02T00:00:00Z', to: '2026-09-01T00:00:00Z' }, { error: /before to/ }],
    ['over 366 days', { from: '2025-01-01T00:00:00Z', to: '2026-09-01T00:00:00Z' }, { error: /at most 366 days/ }],
    ['array param', { from: ['a'], to: '2026-09-01T00:00:00Z' }, { error: /ISO dates/ }],
  ])('%s', (_label, query, expected) => {
    const out = parseInsightsRange(query, now, period);
    if ('error' in expected) {
      expect(out).toMatchObject({ error: expect.stringMatching(expected.error) });
    } else {
      expect('error' in out).toBe(false);
      if (!('error' in out)) expect({ from: out.from.toISOString(), to: out.to.toISOString(), preset: out.preset }).toEqual(expected);
    }
  });

  it('uses the calendar month when there is no period', () => {
    const out = parseInsightsRange({ range: 'period' }, now, null);
    expect('error' in out ? out : out.from.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('stops a past period at its end', () => {
    const out = parseInsightsRange({ range: 'period' }, now, { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-10-01T00:00:00Z') });
    expect('error' in out ? out : out.to.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('utcDays', () => {
  it.each<[string, string, string, string[]]>([
    ['one day', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', ['2026-11-01']],
    ['partial days at both ends', '2026-11-01T22:00:00Z', '2026-11-03T01:00:00Z', ['2026-11-01', '2026-11-02', '2026-11-03']],
    ['a month boundary', '2026-10-31T00:00:00Z', '2026-11-02T00:00:00Z', ['2026-10-31', '2026-11-01']],
  ])('%s', (_label, from, to, expected) => {
    expect(utcDays(new Date(from), new Date(to))).toEqual(expected);
  });
});
