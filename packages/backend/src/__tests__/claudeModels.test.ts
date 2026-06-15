import { describe, it, expect } from 'vitest';
import {
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL_ID,
  isClaudeModelId,
} from '@fastowl/shared';

describe('Claude model catalogue', () => {
  it('offers exactly Opus 4.8, Sonnet 4.6, and Haiku 4.5', () => {
    expect(new Set(CLAUDE_MODELS.map((m) => m.id))).toEqual(
      new Set(['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']),
    );
  });

  it('defaults to Sonnet — PR work should not run on Opus pricing by default', () => {
    expect(DEFAULT_CLAUDE_MODEL_ID).toBe('claude-sonnet-4-6');
    expect(CLAUDE_MODELS.some((m) => m.id === DEFAULT_CLAUDE_MODEL_ID)).toBe(true);
  });

  it('isClaudeModelId accepts known ids and rejects everything else', () => {
    expect(isClaudeModelId('claude-sonnet-4-6')).toBe(true);
    expect(isClaudeModelId('claude-opus-4-8')).toBe(true);
    expect(isClaudeModelId('claude-haiku-4-5-20251001')).toBe(true);
    for (const bad of ['gpt-4', 'claude-3', '', null, undefined, 42]) {
      expect(isClaudeModelId(bad)).toBe(false);
    }
  });
});
