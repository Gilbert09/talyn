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

describe('unitModelTier — escalation is currently OFF', () => {
  /**
   * These assert the DISABLED state on purpose.
   *
   * Escalation picked the top catalogue entry, claude-fable-5-1, and the fleet's
   * Claude Code refuses it: "Claude Code 2.1.75 does not support this model;
   * version 2.1.251 or newer is required" (claude_code_version_too_old). Both
   * judging units failed on every review the moment it shipped — and because the
   * lenses run on the workspace's own model and survived, the symptom was not a
   * broken review but an UNJUDGED one, with the precision bar silently absent.
   *
   * The catalogue says what Anthropic SERVES. It says nothing about what the
   * agent runtime inside the microVM can drive. Nothing checked the second
   * question, which is the actual lesson.
   *
   * Re-enabling is a deliberate act: delete the early return, flip these back to
   * expecting 'top', and first confirm the fleet's Claude Code is new enough.
   */
  it.each(['quick', 'standard', 'deep'] as const)(
    'runs the sweep and the judge on the workspace model for %s',
    (preset) => {
      expect(unitModelTier(preset, 'sweep')).toBe('default');
      expect(unitModelTier(preset, 'validate')).toBe('default');
    }
  );

  it.each(['quick', 'standard', 'deep'] as const)('leaves %s lenses alone too', (preset) => {
    expect(unitModelTier(preset, 'lens')).toBe('default');
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
