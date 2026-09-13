import { describe, it, expect } from 'vitest';
import { emptyLoopInput, loopInputProblem, validateLoop, type LoopInput } from '@talyn/shared';

/**
 * `validateLoop` — the one definition of what a saveable loop is.
 *
 * The messages are part of the contract, not incidental: the route passes them
 * through verbatim as a 400 and the editor shows them under the Save button, so
 * a person reads every one of these strings.
 */

const VALID: LoopInput = {
  name: 'Morning triage',
  prompt: 'Look at yesterday’s failing checks and fix what you can.',
  cron: '0 9 * * 1-5',
  timezone: 'Europe/London',
  provider: 'posthog_code',
  model: 'claude-opus-5',
  repositoryId: 'repo-1',
  repoFullName: 'Gilbert09/talyn',
};

const withField = (patch: Partial<LoopInput>): LoopInput => ({ ...VALID, ...patch });

describe('validateLoop', () => {
  it('accepts a complete loop and fills the defaults', () => {
    const out = validateLoop(VALID);
    expect(out.enabled).toBe(true);
    // Skip is the default, and it is what makes a tight schedule harmless.
    expect(out.concurrency).toBe('skip');
    expect(out.name).toBe('Morning triage');
  });

  it.each([null, undefined, 'a string', 42, []])('refuses %j as a loop', (raw) => {
    expect(() => validateLoop(raw)).toThrow(/must be an object/);
  });

  describe('name', () => {
    it.each([{ name: '' }, { name: '   ' }, { name: 42 as unknown as string }])(
      'refuses %j',
      (patch) => {
        expect(() => validateLoop(withField(patch))).toThrow(/name must be a non-empty string/);
      }
    );

    it('refuses one over the length limit', () => {
      expect(() => validateLoop(withField({ name: 'x'.repeat(81) }))).toThrow(/80 characters/);
    });

    it('trims rather than refusing', () => {
      expect(validateLoop(withField({ name: '  Morning  ' })).name).toBe('Morning');
    });
  });

  describe('prompt', () => {
    it.each(['', '   '])('refuses %j and says why a loop needs one', (prompt) => {
      expect(() => validateLoop(withField({ prompt }))).toThrow(/needs a prompt/);
    });
  });

  describe('schedule', () => {
    it('refuses a six-field expression', () => {
      expect(() => validateLoop(withField({ cron: '0 0 9 * * *' }))).toThrow(/five fields/);
    });

    it('refuses an expression that never fires', () => {
      expect(() => validateLoop(withField({ cron: '0 0 30 2 *' }))).toThrow(/no future runs/);
    });

    it('refuses an unknown timezone by name', () => {
      expect(() => validateLoop(withField({ timezone: 'Mars/Olympus' }))).toThrow(
        /"Mars\/Olympus" is not a timezone/
      );
    });

    it('refuses a missing timezone with an example', () => {
      // There is no sensible default here. Guessing UTC would silently move
      // somebody's 09:00 loop by up to half a day.
      expect(() => validateLoop(withField({ timezone: '' }))).toThrow(/Europe\/London/);
    });
  });

  describe('provider and model coherence', () => {
    it('accepts a Claude model on PostHog Code', () => {
      expect(validateLoop(withField({ provider: 'posthog_code', model: 'claude-sonnet-5' })).model).toBe(
        'claude-sonnet-5'
      );
    });

    it('accepts either vendor on the fleet', () => {
      expect(validateLoop(withField({ provider: 'selfhosted', model: 'gpt-5.6-terra' })).model).toBe(
        'gpt-5.6-terra'
      );
      expect(validateLoop(withField({ provider: 'selfhosted', model: 'claude-fable-5-1' })).model).toBe(
        'claude-fable-5-1'
      );
    });

    it('refuses a fleet-only model on PostHog Code, naming the right catalogue', () => {
      // The directed message is the point. "Invalid model" costs the reader ten
      // minutes; naming which catalogue it belongs to costs them none.
      expect(() =>
        validateLoop(withField({ provider: 'posthog_code', model: 'gpt-5.6-sol' }))
      ).toThrow(/Talyn Fleet model — PostHog Code runs Claude models only/);
    });

    it('refuses a model neither catalogue has', () => {
      expect(() => validateLoop(withField({ model: 'gpt-4' }))).toThrow(
        /not a model PostHog Code can run/
      );
      expect(() =>
        validateLoop(withField({ provider: 'selfhosted', model: 'gpt-4' }))
      ).toThrow(/not a model Talyn Fleet can run/);
    });

    it('accepts a RETIRED fleet model so an old loop still opens and saves', () => {
      // Stored fleet ids are perishable — OpenAI withdraws them from the
      // ChatGPT sign-in path on its own schedule. Refusing one here would mean
      // a loop whose editor cannot be saved at all; dispatch remaps it instead.
      expect(
        validateLoop(withField({ provider: 'selfhosted', model: 'gpt-5.1-codex' })).model
      ).toBe('gpt-5.1-codex');
    });

    it('refuses an unknown provider', () => {
      expect(() =>
        validateLoop(withField({ provider: 'codex_cloud' as LoopInput['provider'] }))
      ).toThrow(/posthog_code or selfhosted/);
    });
  });

  describe('repository', () => {
    it('refuses a loop with no repository, and says why one is needed', () => {
      expect(() => validateLoop(withField({ repositoryId: '' }))).toThrow(/something to clone/);
    });

    it.each(['', 'talyn', 'a/b/c', 'has space/repo'])('refuses repoFullName %j', (repoFullName) => {
      expect(() => validateLoop(withField({ repoFullName }))).toThrow(/owner\/repo/);
    });
  });

  describe('concurrency', () => {
    it.each(['skip', 'allow'] as const)('accepts %s', (concurrency) => {
      expect(validateLoop(withField({ concurrency })).concurrency).toBe(concurrency);
    });

    it('refuses anything else', () => {
      expect(() =>
        validateLoop(withField({ concurrency: 'queue' as LoopInput['concurrency'] }))
      ).toThrow(/skip or allow/);
    });
  });
});

describe('loopInputProblem', () => {
  it('reports the blank editor as incomplete rather than throwing', () => {
    // It drives the Save button's disabled state, so it must answer for every
    // half-finished form the editor can be in.
    expect(loopInputProblem(emptyLoopInput('UTC'))).toMatch(/name/);
  });

  it('is null for a loop the validator accepts', () => {
    expect(loopInputProblem(VALID)).toBeNull();
  });

  it('returns exactly the message the server would 400 with', () => {
    // One definition of "valid", so the disabled button and the server cannot
    // disagree about what is wrong.
    const bad = withField({ model: 'gpt-5.6-sol' });
    let thrown = '';
    try {
      validateLoop(bad);
    } catch (err) {
      thrown = (err as Error).message;
    }
    expect(loopInputProblem(bad)).toBe(thrown);
  });
});
