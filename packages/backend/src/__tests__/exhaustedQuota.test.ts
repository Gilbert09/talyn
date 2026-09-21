import { describe, it, expect } from 'vitest';
import {
  exhaustedAgentFrom,
  heldBackReason,
  isHeldBack,
  probeAfter,
  resetInstantFrom,
} from '../services/selfHosted/exhaustedQuota.js';

/**
 * The line between "this subscription is spent" and "wait a moment".
 *
 * Only the first is worth moving a run for. A rate limit clears by itself, and
 * moving off it means spending metered credits to avoid a short wait — so the
 * matcher is deliberately one-sided and everything unrecognised is left to
 * fail the ordinary way.
 */
describe('exhaustedAgentFrom', () => {
  it('reads the sentence a spent Claude subscription actually produced', () => {
    // Verbatim from the failing run on 2026-09-20 — a fleet `harness_no_output`
    // wrapping Anthropic's 400. The whole envelope is what reaches us, so the
    // matcher has to find the sentence inside it.
    const detail =
      'harness_no_output: the harness produced no agent turn: 400 {"type":"error",' +
      '"error":{"type":"invalid_request_error","message":"You\'re out of extra usage. ' +
      'Add more at claude.ai/settings/usage and keep going."},' +
      '"request_id":"req_011CfFDX4G7dRubkb2P2E9e5"}';
    expect(exhaustedAgentFrom(detail)).toBe('claude');
  });

  it.each([
    ['a Console key with nothing left', 'Your credit balance is too low to access the API'],
    ['the subscription sentence alone', "You're out of extra usage."],
    ['a curly apostrophe', 'You’re out of extra usage. Add more at claude.ai/settings/usage'],
  ])('recognises %s as Claude', (_label, detail) => {
    expect(exhaustedAgentFrom(detail)).toBe('claude');
  });

  it.each([
    ['the documented error code', 'insufficient_quota: You exceeded your current quota'],
    ['the prose form', 'You exceeded your current quota, please check your plan and billing'],
  ])('recognises %s as Codex', (_label, detail) => {
    expect(exhaustedAgentFrom(detail)).toBe('codex');
  });

  it.each([
    ['a rate limit', 'rate_limited: Rate limited by the Anthropic API — the account\'s limit'],
    ['a five-hour window', 'You have reached your usage limit. Your limit resets at 3pm.'],
    ['an overloaded vendor', '529 {"type":"overloaded_error"}'],
    ['an unrelated harness failure', 'harness_no_output: the harness produced no agent turn'],
    ['a merge conflict', 'could not apply patch: conflict in src/app.ts'],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('leaves %s alone', (_label, detail) => {
    expect(exhaustedAgentFrom(detail)).toBeNull();
  });

  it('does not fire on an agent merely DISCUSSING running out of usage', () => {
    // The same restraint the needs_human sentinel and findPullRequestUrl keep:
    // a transcript that talks about a failure must not be read as one. This is
    // the weakest of the three (the detail is an error string, not prose), so
    // it is pinned to vendor wording rather than to the words "out of usage".
    expect(
      exhaustedAgentFrom('I checked whether the account had run out of usage; it had not.'),
    ).toBeNull();
  });
});

/**
 * When the quota comes back.
 *
 * The rule that matters: a reset is READ, never invented. A guessed one is
 * stored, believed, and silently keeps work off a subscription that returned
 * hours ago — so an unparseable failure must answer null and let the caller
 * fall back to a probe it knows is a probe.
 */
describe('resetInstantFrom', () => {
  const NOW = new Date('2026-09-20T12:00:00.000Z');

  it.each([
    ['an ISO resetsAt', '{"resetsAt":"2026-09-20T17:30:00.000Z"}', '2026-09-20T17:30:00.000Z'],
    ['a snake_case resets_at', '{"resets_at":"2026-09-20T17:30:00.000Z"}', '2026-09-20T17:30:00.000Z'],
    ['epoch seconds', '{"resetsAt":1789574400}', new Date(1789574400000).toISOString()],
    [
      "Anthropic's unified-reset header",
      'anthropic-ratelimit-unified-reset: 1789574400',
      new Date(1789574400000).toISOString(),
    ],
  ])('reads %s', (_label, detail, expected) => {
    expect(resetInstantFrom(detail, NOW)).toBe(expected);
  });

  it.each([
    ['seconds', 'retry-after: 900', 900_000],
    ['minutes', 'try again in 30 minutes', 30 * 60_000],
    ['hours', 'try again in 5 hours', 5 * 3_600_000],
  ])('turns a relative hint in %s into an instant', (_label, detail, ms) => {
    expect(resetInstantFrom(detail, NOW)).toBe(new Date(NOW.getTime() + ms).toISOString());
  });

  it.each([
    ['the sentence that started this', "You're out of extra usage. Add more at claude.ai"],
    ['a bare quota refusal', 'insufficient_quota'],
    ['an unparseable date', '{"resetsAt":"not-a-date-at-all"}'],
    ['nothing at all', ''],
    ['null', null],
  ])('answers null rather than invent one for %s', (_label, detail) => {
    expect(resetInstantFrom(detail, NOW)).toBeNull();
  });
});

/**
 * The hold buys back a BURST of dispatches, and nothing longer.
 *
 * It was five hours, on the reasoning that both vendors meter consumer
 * subscriptions on a rolling five-hour window. Rolling is the word that broke
 * it: such a window frees capacity continuously, so a subscription refused at
 * 08:00 can be usable at 08:20. On 2026-09-21 Claude reported "out of extra
 * usage" at 08:00:33, the quota came back well before the 13:00 probe, and a
 * 10:00 loop ran on Codex having never asked Claude.
 */
describe('holding a spent agent back', () => {
  const AT = '2026-09-20T12:00:00.000Z';
  const FIVE_MIN = 5 * 60 * 1000;

  it('re-probes five minutes after the refusal when the vendor named no reset', () => {
    const record = { at: AT };
    expect(probeAfter(record)).toBe(new Date(AT).getTime() + FIVE_MIN);
    expect(isHeldBack(record, new Date('2026-09-20T12:04:59.000Z'))).toBe(true);
    expect(isHeldBack(record, new Date('2026-09-20T12:05:01.000Z'))).toBe(false);
  });

  it('takes the vendor\'s reset when it is SOONER — no point holding past a known return', () => {
    const record = { at: AT, resetsAt: '2026-09-20T12:02:00.000Z' };
    expect(probeAfter(record)).toBe(new Date('2026-09-20T12:02:00.000Z').getTime());
    expect(isHeldBack(record, new Date('2026-09-20T12:01:59.000Z'))).toBe(true);
    expect(isHeldBack(record, new Date('2026-09-20T12:02:01.000Z'))).toBe(false);
  });

  // The change. A vendor naming a LATER instant is describing a full window
  // reset, which on a rolling limit is pessimistic for the same reason — so we
  // spend one microVM boot finding out rather than sitting out the difference.
  it.each([
    ['an hour out', '2026-09-20T13:00:00.000Z'],
    ['five hours out', '2026-09-20T17:00:00.000Z'],
    ['years out', '2099-01-01T00:00:00.000Z'],
  ])('ignores the vendor\'s reset when it is later (%s)', (_label, resetsAt) => {
    const record = { at: AT, resetsAt };
    expect(probeAfter(record)).toBe(new Date(AT).getTime() + FIVE_MIN);
    expect(isHeldBack(record, new Date('2026-09-20T12:05:01.000Z'))).toBe(false);
  });

  it('holds nothing back when there is no record', () => {
    expect(isHeldBack(undefined)).toBe(false);
  });

  it('does not hold on a corrupt timestamp — an unreadable record must not be a permanent ban', () => {
    expect(isHeldBack({ at: 'nonsense' }, new Date(AT))).toBe(false);
  });

  it('falls back to our own window when the vendor\'s reset is unparseable', () => {
    const record = { at: AT, resetsAt: 'not-a-date' };
    expect(probeAfter(record)).toBe(new Date(AT).getTime() + FIVE_MIN);
  });
});

describe('what the refusal says', () => {
  // It used to quote `resetsAt`. Since that stopped deciding the hold, quoting
  // it would name a moment the agent is not waiting for — worse than naming
  // none, because it reads as a fact about the vendor.
  it('names the instant we will actually retry, not the vendor\'s reset', () => {
    const reason = heldBackReason('claude', {
      at: '2026-09-20T12:00:00.000Z',
      resetsAt: '2026-09-20T17:00:00.000Z',
    });
    expect(reason).toContain('2026-09-20T12:05:00.000Z');
    expect(reason).not.toContain('17:00:00');
    expect(reason).toContain('Claude');
  });
});
