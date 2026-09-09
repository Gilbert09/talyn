import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_FLEET_CODEX_MODEL_ID, DEFAULT_FLEET_MODEL_ID } from '@talyn/shared';
import {
  withdrawnModelFrom,
  isWithdrawnModel,
  replacementFor,
  _resetWithdrawnModels,
} from '../services/selfHosted/withdrawnModels.js';

/**
 * Learning that a vendor withdrew a model, from the only source that reports it.
 *
 * OpenAI removes models from the ChatGPT sign-in path while leaving them on the
 * API-key path, so `GET /v1/models` — which answers for a KEY — cannot tell us.
 * The fleet runs on the user's own subscription. The failure text is the feed.
 */
describe('withdrawnModelFrom', () => {
  beforeEach(() => _resetWithdrawnModels());

  it('reads the id out of the vendor\'s own sentence', () => {
    // Verbatim, as it arrived in the run transcript.
    const detail =
      'the harness could not complete a turn: {"detail":"The \'gpt-5.1-codex\' model is ' +
      'not supported when using Codex with a ChatGPT account."}';
    expect(withdrawnModelFrom(detail)).toBe('gpt-5.1-codex');
  });

  it.each([
    'gpt-5-codex',
    'gpt-5.4',
    'some-future-id',
  ])('reads whichever id the vendor names: %s', (id) => {
    expect(
      withdrawnModelFrom(
        `The '${id}' model is not supported when using Codex with a ChatGPT account.`
      )
    ).toBe(id);
  });

  it.each([
    null,
    undefined,
    '',
    'Sandbox ended with status "failed"',
    'the harness produced no agent turn',
    // The near-miss that matters: a model can be rejected for reasons that are
    // NOT a withdrawal. Matching loosely here would retire an id the vendor
    // still serves, which is worse than missing one.
    "The 'gpt-6-astra' model is not supported for this request",
    'model not supported',
  ])('leaves anything else alone: %p', (detail) => {
    expect(withdrawnModelFrom(detail)).toBeNull();
  });

  it('does not treat an id as withdrawn until one is observed', () => {
    expect(isWithdrawnModel('gpt-5.1-codex')).toBe(false);
    expect(isWithdrawnModel(undefined)).toBe(false);
  });

  it('replaces with the AGENT\'s default, not a like-for-like tier', () => {
    // We have just learned the catalogue is wrong about this vendor, so the
    // only id left with grounds to be trusted is the shipped floor.
    expect(replacementFor('gpt-5.1-codex')).toBe(DEFAULT_FLEET_CODEX_MODEL_ID);
    expect(replacementFor('claude-opus-5')).toBe(DEFAULT_FLEET_MODEL_ID);
  });

  it('routes an unknown id to Claude, matching fleetProviderForModel', () => {
    // The back-compat answer. Guarded so the two cannot drift: if
    // fleetProviderForModel ever defaulted the other way, a withdrawal of an
    // unknown id would silently move a workspace onto the wrong vendor.
    expect(replacementFor('something-unrecognised')).toBe(DEFAULT_FLEET_MODEL_ID);
  });
});
