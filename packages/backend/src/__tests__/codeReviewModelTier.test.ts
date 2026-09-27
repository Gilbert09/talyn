import { describe, it, expect } from 'vitest';
import { topFleetModelForModel, FLEET_MODELS } from '@talyn/shared';
import { unitModelTier } from '../services/codeReview/executor.js';

/**
 * What "how deeply to review" actually buys.
 *
 * There is no reasoning-effort field on the fleet's create body and no effort
 * variants in the catalogue, so depth can only mean MODEL TIER. It was not
 * wired at all until now: the first real review ran all eight units — three
 * lenses, the sweep and the judge — on Sonnet, which made Deep differ from
 * Standard only in how many reviewers there were.
 */

describe('unitModelTier', () => {
  it.each(['quick', 'standard', 'deep'] as const)(
    'escalates the sweep and the judge on %s',
    (preset) => {
      // Both read more, or have to say no to something plausible, and that is
      // what the strongest model is for. True on every preset, not just Deep.
      expect(unitModelTier(preset, 'sweep')).toBe('top');
      expect(unitModelTier(preset, 'validate')).toBe('top');
    }
  );

  it.each(['quick', 'standard'] as const)('leaves %s lenses on the default model', (preset) => {
    expect(unitModelTier(preset, 'lens')).toBe('default');
  });

  it('escalates deep lenses too, because its plan says so', () => {
    // Derived from CODE_REVIEW_PRESET_PLAN rather than restated, so the preset
    // table stays the single definition of what a depth means.
    expect(unitModelTier('deep', 'lens')).toBe('top');
  });
});

describe('topFleetModelForModel', () => {
  it('stays with the vendor it was given', () => {
    // Load-bearing: a run dispatched at an OpenAI model has no route to
    // api.anthropic.com at all, so escalating across vendors would produce a
    // sandbox that cannot make a single call.
    expect(topFleetModelForModel('gpt-5.6-terra')).toMatch(/^gpt-/);
    expect(topFleetModelForModel('claude-sonnet-5')).toMatch(/^claude-/);
  });

  it('picks the first catalogue entry for that vendor, which is the strongest', () => {
    const topClaude = FLEET_MODELS.find((m) => m.provider === 'anthropic')!.id;
    const topGpt = FLEET_MODELS.find((m) => m.provider === 'openai')!.id;
    expect(topFleetModelForModel('claude-sonnet-4-6')).toBe(topClaude);
    expect(topFleetModelForModel('gpt-5.5')).toBe(topGpt);
  });

  it('hands back an unknown model unchanged rather than refusing it', () => {
    // A retired or pinned id must keep working; escalation is an improvement,
    // never a precondition.
    expect(topFleetModelForModel('some-retired-model')).toBe('some-retired-model');
  });

  it('leaves an absent model absent rather than inventing a vendor', () => {
    // Nothing to escalate, and guessing Anthropic here would be the same
    // cross-vendor mistake as the retired-id case above.
    expect(topFleetModelForModel(undefined)).toBe('');
  });
});
