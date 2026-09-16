import { describe, it, expect } from 'vitest';
import { emptyLoopInput, loopToInput, validateLoop, type LoopInput } from '@talyn/shared';

/**
 * The per-loop tool-server pin, through the validator.
 *
 * Its three states are the whole point and each has to survive: null is
 * inherit, `[]` is "no tool servers", and a list is exactly those. Collapsing
 * null and `[]` would make "run this one with no tools" the one thing a loop
 * could not ask for, and coercing junk to null would silently hand a run every
 * tool server the workspace has.
 */

function loop(over: Partial<LoopInput> = {}): LoopInput {
  return {
    ...emptyLoopInput(),
    name: 'Nightly sweep',
    prompt: 'Fix the failing checks.',
    cron: '0 9 * * *',
    timezone: 'Europe/London',
    provider: 'selfhosted',
    model: 'claude-opus-4-5',
    repositoryId: 'repo-1',
    repoFullName: 'Gilbert09/talyn',
    ...over,
  };
}

describe('a loop’s tool servers', () => {
  it('defaults to inherit', () => {
    expect(validateLoop(loop()).mcpServerIds).toBeNull();
    expect(emptyLoopInput().mcpServerIds).toBeNull();
  });

  it('keeps null and [] apart, because they are opposite answers', () => {
    expect(validateLoop(loop({ mcpServerIds: null })).mcpServerIds).toBeNull();
    expect(validateLoop(loop({ mcpServerIds: [] })).mcpServerIds).toEqual([]);
  });

  it('carries a pin through', () => {
    expect(validateLoop(loop({ mcpServerIds: ['a', 'b'] })).mcpServerIds).toEqual(['a', 'b']);
  });

  // Refused rather than coerced. Reading a string as "inherit" would hand the
  // run every tool server the workspace has, which is the opposite of what
  // somebody trying to narrow a loop meant.
  it.each([['a string', 'all'], ['a number', 7], ['a list of numbers', [1, 2]]])(
    'refuses %s rather than coercing it',
    (_label, value) => {
      expect(() => validateLoop(loop({ mcpServerIds: value as never }))).toThrow(
        /must be a list of tool server ids/
      );
    }
  );

  // The editor round-trip: what comes back out has to be what went in, or
  // opening a loop and pressing Save would silently change its posture.
  it('survives loopToInput unchanged', () => {
    for (const ids of [null, [], ['a']]) {
      const normalized = validateLoop(loop({ mcpServerIds: ids }));
      const back = loopToInput({
        ...normalized,
        id: 'l1',
        workspaceId: 'ws-1',
        repositoryId: 'repo-1',
        nextRunAt: null,
        disabledReason: null,
        createdAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T00:00:00.000Z',
      });
      expect(back.mcpServerIds).toEqual(ids);
    }
  });
});
