import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_SESSION_DEFAULTS,
  SESSION_DEFAULTS_KEY,
  readSessionDefaults,
  subscribeSessionDefaults,
  writeSessionDefaults,
} from '../lib/sessionDefaults';

describe('session defaults', () => {
  beforeEach(() => localStorage.clear());

  it('falls back to the defaults when nothing is stored', () => {
    expect(readSessionDefaults()).toEqual(DEFAULT_SESSION_DEFAULTS);
    expect(DEFAULT_SESSION_DEFAULTS).toEqual({
      agent: 'claude',
      effort: 'high',
      planMode: false,
      internetAccess: true,
      autoCreatePr: true,
      notifyOnFinish: true,
    });
  });

  it.each([
    ['not JSON', '{oops'],
    ['a JSON array', '[1,2]'],
    ['JSON null', 'null'],
    ['a string', '"local"'],
    ['an empty object', '{}'],
  ])('reads %s as the defaults', (_name, raw) => {
    localStorage.setItem(SESSION_DEFAULTS_KEY, raw);
    expect(readSessionDefaults()).toEqual(DEFAULT_SESSION_DEFAULTS);
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['missing', undefined],
  ])('reads a stored %s effort as High', (_name, effort) => {
    localStorage.setItem(SESSION_DEFAULTS_KEY, JSON.stringify({ agent: 'codex', effort }));
    expect(readSessionDefaults()).toMatchObject({ agent: 'codex', effort: 'high' });
  });

  it('keeps the valid fields of a partly corrupt value', () => {
    localStorage.setItem(
      SESSION_DEFAULTS_KEY,
      JSON.stringify({ agent: 'codex', effort: 'extreme', planMode: 'yes', internetAccess: 'no', notifyOnFinish: false })
    );
    expect(readSessionDefaults()).toEqual({
      ...DEFAULT_SESSION_DEFAULTS,
      agent: 'codex',
      notifyOnFinish: false,
    });
  });

  it.each([
    [{ agent: 'codex' as const }],
    [{ effort: 'high' as const }],
    [{ effort: 'low' as const }],
    [{ planMode: true }],
    [{ internetAccess: false }],
    [{ autoCreatePr: false }],
    [{ notifyOnFinish: false }],
  ])('round-trips %j', (patch) => {
    writeSessionDefaults(patch);
    expect(readSessionDefaults()).toEqual({ ...DEFAULT_SESSION_DEFAULTS, ...patch });
  });

  it('merges successive writes', () => {
    writeSessionDefaults({ agent: 'codex' });
    writeSessionDefaults({ effort: 'max' });
    expect(readSessionDefaults()).toMatchObject({ agent: 'codex', effort: 'max' });
  });

  it('ignores a runtime stored by an older build', () => {
    localStorage.setItem(SESSION_DEFAULTS_KEY, JSON.stringify({ runtime: 'local', agent: 'codex' }));
    expect(readSessionDefaults()).toEqual({ ...DEFAULT_SESSION_DEFAULTS, agent: 'codex' });
    expect(readSessionDefaults()).not.toHaveProperty('runtime');
  });

  it('returns the same object while the stored value is unchanged', () => {
    writeSessionDefaults({ planMode: true });
    expect(readSessionDefaults()).toBe(readSessionDefaults());
  });

  it('tells subscribers about a write, until they unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionDefaults(listener);
    writeSessionDefaults({ agent: 'codex' });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    writeSessionDefaults({ agent: 'claude' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
