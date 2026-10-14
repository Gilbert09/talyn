import {
  DEFAULT_SESSION_DEFAULTS,
  SESSION_DEFAULTS_KEY,
  readSessionDefaults,
  subscribeSessionDefaults,
  writeSessionDefaults,
} from '../renderer/lib/sessionDefaults';

describe('session defaults', () => {
  beforeEach(() => localStorage.clear());

  it('falls back to the defaults when nothing is stored', () => {
    expect(readSessionDefaults()).toEqual(DEFAULT_SESSION_DEFAULTS);
    expect(DEFAULT_SESSION_DEFAULTS).toEqual({
      runtime: 'sandbox',
      agent: 'claude',
      effort: null,
      planMode: false,
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

  it('keeps the valid fields of a partly corrupt value', () => {
    localStorage.setItem(
      SESSION_DEFAULTS_KEY,
      JSON.stringify({ runtime: 'moon', agent: 'codex', effort: 'extreme', planMode: 'yes', notifyOnFinish: false })
    );
    expect(readSessionDefaults()).toEqual({
      ...DEFAULT_SESSION_DEFAULTS,
      agent: 'codex',
      notifyOnFinish: false,
    });
  });

  it.each([
    [{ runtime: 'local' as const }],
    [{ agent: 'codex' as const }],
    [{ effort: 'high' as const }],
    [{ effort: null }],
    [{ planMode: true }],
    [{ notifyOnFinish: false }],
  ])('round-trips %j', (patch) => {
    writeSessionDefaults(patch);
    expect(readSessionDefaults()).toEqual({ ...DEFAULT_SESSION_DEFAULTS, ...patch });
  });

  it('merges successive writes', () => {
    writeSessionDefaults({ runtime: 'local' });
    writeSessionDefaults({ effort: 'max' });
    expect(readSessionDefaults()).toMatchObject({ runtime: 'local', effort: 'max' });
  });

  it('returns the same object while the stored value is unchanged', () => {
    writeSessionDefaults({ planMode: true });
    expect(readSessionDefaults()).toBe(readSessionDefaults());
  });

  it('tells subscribers about a write, until they unsubscribe', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeSessionDefaults(listener);
    writeSessionDefaults({ agent: 'codex' });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    writeSessionDefaults({ agent: 'claude' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
