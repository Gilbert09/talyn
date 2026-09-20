import { describe, it, expect } from 'vitest';
import { exhaustedAgentFrom } from '../services/selfHosted/exhaustedQuota.js';

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
