import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_FEATURE_FLAGS,
  DEFAULT_WORKBENCH_ACTION_PROMPTS,
  FEATURE_FLAGS,
  WORKBENCH_CITY_NAMES,
  gateForScope,
  isGatedFeature,
  nextWorkbenchAction,
  pickWorkbenchName,
  readFlagOverride,
  resolveWorkbenchActionPrompt,
  workbenchesOffered,
  type WorkbenchNextAction,
  type WorkbenchNextActionInput,
  type WorkbenchPromptAction,
} from '@talyn/shared';

describe('WORKBENCH_CITY_NAMES', () => {
  it('has about 150 names', () => {
    expect(WORKBENCH_CITY_NAMES.length).toBeGreaterThanOrEqual(140);
    expect(WORKBENCH_CITY_NAMES.length).toBeLessThanOrEqual(170);
  });

  it('has no duplicates', () => {
    expect(new Set(WORKBENCH_CITY_NAMES).size).toBe(WORKBENCH_CITY_NAMES.length);
  });

  it.each(WORKBENCH_CITY_NAMES.map((n) => [n]))('%s is lowercase ascii, hyphenated, and a valid branch segment', (name) => {
    expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });
});

describe('pickWorkbenchName', () => {
  const first = WORKBENCH_CITY_NAMES[0];
  const last = WORKBENCH_CITY_NAMES[WORKBENCH_CITY_NAMES.length - 1];

  it.each([
    ['random 0 picks the first free city', 0, [], first],
    ['random just below 1 picks the last free city', 0.999999, [], last],
    ['random 1 (out of contract) is clamped to the last', 1, [], last],
    ['negative random is clamped to the first', -0.5, [], first],
    ['a taken first city is skipped', 0, [first], WORKBENCH_CITY_NAMES[1]],
  ])('%s', (_name, r, taken, expected) => {
    expect(pickWorkbenchName(taken as string[], () => r as number)).toBe(expected);
  });

  it('never returns a taken name', () => {
    const taken = WORKBENCH_CITY_NAMES.slice(0, -1);
    for (const r of [0, 0.3, 0.7, 0.99]) {
      expect(pickWorkbenchName(taken, () => r)).toBe(last);
    }
  });

  it('compares case- and whitespace-insensitively', () => {
    const taken = WORKBENCH_CITY_NAMES.slice(1).concat([` ${first.toUpperCase()} `]);
    expect(pickWorkbenchName(taken, () => 0)).toBe(`${first}-v2`);
  });

  it('goes to -v2 once every city is taken', () => {
    expect(pickWorkbenchName(WORKBENCH_CITY_NAMES, () => 0)).toBe(`${first}-v2`);
  });

  it('goes to -v3 once every city and every -v2 is taken', () => {
    const taken = [...WORKBENCH_CITY_NAMES, ...WORKBENCH_CITY_NAMES.map((c) => `${c}-v2`)];
    expect(pickWorkbenchName(taken, () => 0)).toBe(`${first}-v3`);
  });

  it('fills a gap in -v2 before reaching -v3', () => {
    const taken = [
      ...WORKBENCH_CITY_NAMES,
      ...WORKBENCH_CITY_NAMES.filter((c) => c !== 'paris').map((c) => `${c}-v2`),
    ];
    expect(pickWorkbenchName(taken, () => 0.5)).toBe('paris-v2');
  });

  it('accepts any iterable', () => {
    expect(pickWorkbenchName(new Set([first]), () => 0)).toBe(WORKBENCH_CITY_NAMES[1]);
  });

  it('defaults to Math.random and always returns a city', () => {
    expect(WORKBENCH_CITY_NAMES).toContain(pickWorkbenchName([]));
  });
});

describe('nextWorkbenchAction', () => {
  const open = (mergeable?: 'conflicting' | 'mergeable' | 'unknown', ciStatus?: 'success' | 'failure' | 'pending' | 'none') => ({
    state: 'open' as const,
    mergeable,
    ciStatus,
  });

  it.each<[string, WorkbenchNextActionInput, WorkbenchNextAction]>([
    ['no PR, no changes', { hasChanges: false, pr: null }, null],
    ['no PR, changes', { hasChanges: true, pr: null }, 'create_pr'],
    ['no PR, only unpushed commits', { hasChanges: false, hasUnpushedCommits: true, pr: null }, 'create_pr'],
    ['open, conflicting, green', { hasChanges: false, pr: open('conflicting', 'success') }, 'resolve_conflicts'],
    ['open, conflicting AND failing: conflicts first', { hasChanges: false, pr: open('conflicting', 'failure') }, 'resolve_conflicts'],
    ['open, failing checks', { hasChanges: false, pr: open('mergeable', 'failure') }, 'fix_checks'],
    ['open, failing checks, mergeability unknown', { hasChanges: false, pr: open('unknown', 'failure') }, 'fix_checks'],
    ['open, green', { hasChanges: false, pr: open('mergeable', 'success') }, 'merge'],
    ['open, no checks configured', { hasChanges: false, pr: open('mergeable', 'none') }, 'merge'],
    ['open, nothing known about CI', { hasChanges: false, pr: open('mergeable') }, 'merge'],
    ['open, pending checks: wait', { hasChanges: false, pr: open('mergeable', 'pending') }, null],
    ['open, mergeability unknown: wait', { hasChanges: false, pr: open('unknown', 'success') }, null],
    ['open with local changes still follows the PR', { hasChanges: true, pr: open('mergeable', 'success') }, 'merge'],
    ['merged', { hasChanges: false, pr: { state: 'merged' } }, 'archive'],
    ['closed', { hasChanges: true, pr: { state: 'closed' } }, 'archive'],
    ['merged even if reported conflicting', { hasChanges: false, pr: { state: 'merged', mergeable: 'conflicting' } }, 'archive'],
  ])('%s → %s', (_name, input, expected) => {
    expect(nextWorkbenchAction(input)).toBe(expected);
  });
});

describe('action prompts', () => {
  const actions = Object.keys(DEFAULT_WORKBENCH_ACTION_PROMPTS) as WorkbenchPromptAction[];

  it('has a default for every action', () => {
    expect(actions.sort()).toEqual(['create_pr', 'fix_checks', 'rename_branch', 'resolve_conflicts']);
  });

  it.each(actions.map((a) => [a]))('%s mentions the fleet proxy', (action) => {
    expect(DEFAULT_WORKBENCH_ACTION_PROMPTS[action]).toContain('fleet proxy');
  });

  it('create_pr commits, pushes the current branch and opens a PR with gh', () => {
    const prompt = DEFAULT_WORKBENCH_ACTION_PROMPTS.create_pr;
    expect(prompt).toMatch(/commit/i);
    expect(prompt).toContain('git push -u origin HEAD');
    expect(prompt).toContain('gh pr create');
    expect(prompt).toMatch(/title/i);
    expect(prompt).toMatch(/body/i);
  });

  it.each<[string, Parameters<typeof resolveWorkbenchActionPrompt>[1], Record<string, string>, (s: string) => void]>([
    ['default, variables filled', null, { baseBranch: 'main', branch: 'tokyo' }, (s) => {
      expect(s).toContain('gh pr create --base main');
      expect(s).not.toContain('{{baseBranch}}');
    }],
    ['override used', { prompts: { create_pr: 'Ship {{branch}} to {{ baseBranch }}' } }, { baseBranch: 'dev', branch: 'oslo' }, (s) => {
      expect(s).toBe('Ship oslo to dev');
    }],
    ['blank override falls back to default', { prompts: { create_pr: '   ' } }, {}, (s) => {
      expect(s).toContain('gh pr create');
    }],
    ['override for another action is ignored', { prompts: { fix_checks: 'x' } }, {}, (s) => {
      expect(s).toContain('gh pr create');
    }],
    ['unknown placeholder kept visible', { prompts: { create_pr: 'Hi {{nobody}}' } }, {}, (s) => {
      expect(s).toBe('Hi {{nobody}}');
    }],
    ['variable value with $ is inserted literally', { prompts: { create_pr: 'B={{branch}}' } }, { branch: "$& $' x" }, (s) => {
      expect(s).toBe("B=$& $' x");
    }],
  ])('%s', (_name, settings, vars, check) => {
    check(resolveWorkbenchActionPrompt('create_pr', settings, vars));
  });
});

describe('workbenches feature flag', () => {
  it('is registered like loops: own env override, fallback off, gated', () => {
    expect(FEATURE_FLAGS.workbenches).toEqual({
      posthogKey: 'workbenches',
      envOverride: 'WORKBENCHES_ENABLED',
      fallback: false,
      description: expect.any(String),
      availability: 'gated',
      releaseScopes: ['workbenches'],
    });
  });

  it('is an account flag, so GET /features answers it', () => {
    expect(ACCOUNT_FEATURE_FLAGS).toContain('workbenches');
  });

  it('withholds its release notes while gated', () => {
    expect(isGatedFeature('workbenches')).toBe(true);
    expect(gateForScope('workbenches')).toBe('workbenches');
  });

  it.each([
    [undefined, undefined],
    ['', undefined],
    ['true', true],
    ['1', true],
    ['on', true],
    ['typo', true],
    ['false', false],
    ['0', false],
    ['off', false],
    ['no', false],
  ])('WORKBENCHES_ENABLED=%j → %j', (value, expected) => {
    const env: Record<string, string | undefined> = value === undefined ? {} : { WORKBENCHES_ENABLED: value };
    expect(readFlagOverride('workbenches', env)).toBe(expected);
  });

  it('does not answer another flag', () => {
    expect(readFlagOverride('loops', { WORKBENCHES_ENABLED: 'true' })).toBeUndefined();
  });

  it.each([
    [null, false],
    [undefined, false],
    [{}, false],
    [{ workbenches: false }, false],
    [{ workbenches: true }, true],
  ])('workbenchesOffered(%j) → %s', (features, expected) => {
    expect(workbenchesOffered(features)).toBe(expected);
  });
});
