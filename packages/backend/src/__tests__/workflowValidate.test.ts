import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WORKFLOW_RUNS_PER_PR_PER_HOUR,
  MAX_WORKFLOW_NAME_LENGTH,
  validateWorkflow,
  type WorkflowInput,
} from '@talyn/shared';

/**
 * The validator, which is also the API's 400 message.
 *
 * Two rules here are doing real work beyond shape checking:
 *
 *  - a condition that cannot apply to any of the workflow's events is REFUSED,
 *    not dropped. Storing it would leave a rule whose editor shows a constraint
 *    the engine never tests — the shape of bug where somebody believes a
 *    workflow is narrower than it is and finds out when it comments on the
 *    wrong PR.
 *  - a `local:` skill is refused, because the backend cannot read a skill that
 *    lives in the user's home directory. Accepting one would store a rule that
 *    fails every single time it matches.
 */

function input(over: Partial<WorkflowInput> = {}): unknown {
  return {
    name: 'Label new PRs',
    events: ['pr_opened'],
    actions: [{ type: 'add_labels', labels: ['talyn-seen'] }],
    ...over,
  };
}

describe('validateWorkflow — the happy path', () => {
  it('normalises and defaults', () => {
    const out = validateWorkflow(
      input({
        name: '  Label new PRs  ',
        conditions: { repos: [' acme/widget ', 'acme/widget', ''] },
      })
    );
    expect(out.name).toBe('Label new PRs');
    expect(out.enabled).toBe(true);
    expect(out.maxRunsPerPrPerHour).toBe(DEFAULT_WORKFLOW_RUNS_PER_PR_PER_HOUR);
    // Trimmed, de-duplicated, blanks dropped — so the matcher's own
    // normalisation is a no-op on anything that came through this door.
    expect(out.conditions.repos).toEqual(['acme/widget']);
  });

  it('drops an "any" actor match instead of storing a non-constraint', () => {
    const out = validateWorkflow(input({ conditions: { author: { kind: 'any' } } }));
    expect(out.conditions.author).toBeUndefined();
  });

  it('drops empty lists and blank strings from the stored conditions', () => {
    const out = validateWorkflow(
      input({ conditions: { labelsAny: [], titleContains: '   ' } })
    );
    expect(out.conditions).toEqual({});
  });

  it('accepts an explicit enabled:false and a custom cap', () => {
    const out = validateWorkflow(input({ enabled: false, maxRunsPerPrPerHour: 20 }));
    expect(out.enabled).toBe(false);
    expect(out.maxRunsPerPrPerHour).toBe(20);
  });
});

describe('validateWorkflow — refusals', () => {
  it.each<[string, unknown, RegExp]>([
    ['not an object', 'nope', /must be an object/],
    ['no name', { ...(input() as object), name: '   ' }, /name must be a non-empty string/],
    [
      'an over-long name',
      { ...(input() as object), name: 'x'.repeat(MAX_WORKFLOW_NAME_LENGTH + 1) },
      /characters or fewer/,
    ],
    ['no events', { ...(input() as object), events: [] }, /at least one trigger event/],
    ['an unknown event', { ...(input() as object), events: ['pr_exploded'] }, /not a PR event/],
    ['no actions', { ...(input() as object), actions: [] }, /at least one action/],
    [
      'an unknown action',
      { ...(input() as object), actions: [{ type: 'launch_rocket' }] },
      /not an action Talyn can take/,
    ],
    [
      'an unknown condition key',
      { ...(input() as object), conditions: { colour: 'blue' } },
      /Unknown condition "colour"/,
    ],
    [
      'a cap below one',
      { ...(input() as object), maxRunsPerPrPerHour: 0 },
      /whole number of 1 or more/,
    ],
    [
      'a fractional cap',
      { ...(input() as object), maxRunsPerPrPerHour: 2.5 },
      /whole number of 1 or more/,
    ],
  ])('refuses %s', (_name, raw, message) => {
    expect(() => validateWorkflow(raw)).toThrow(message);
  });

  it.each<[string, unknown, RegExp]>([
    ['add_labels with no labels', { type: 'add_labels', labels: [] }, /names no labels/],
    ['remove_labels with blanks only', { type: 'remove_labels', labels: ['  '] }, /names no labels/],
    ['request_reviewers with nobody', { type: 'request_reviewers' }, /names no reviewers/],
    ['assign with nobody', { type: 'assign', users: [] }, /names nobody to assign/],
    ['comment with an empty body', { type: 'comment', body: '  ' }, /must be a non-empty string/],
    ['run_prompt with no prompt', { type: 'run_prompt', prompt: '' }, /must be a non-empty string/],
    ['run_skill with no key', { type: 'run_skill', skillKey: '' }, /must be a non-empty string/],
    [
      'enqueue_merge_queue with a bad method',
      { type: 'enqueue_merge_queue', method: 'fast-forward' },
      /squash, merge or rebase/,
    ],
  ])('refuses an action that would do nothing: %s', (_name, action, message) => {
    expect(() => validateWorkflow(input({ actions: [action as never] }))).toThrow(message);
  });

  it('refuses a local skill, and says why', () => {
    expect(() =>
      validateWorkflow(input({ actions: [{ type: 'run_skill', skillKey: 'local:my-skill' }] }))
    ).toThrow(/cannot run a local skill/);
  });

  it('accepts a repo skill and a platform skill', () => {
    for (const skillKey of ['repo:acme/widget:tidy', 'platform:abc-123']) {
      const out = validateWorkflow(input({ actions: [{ type: 'run_skill', skillKey }] }));
      expect(out.actions[0]).toMatchObject({ type: 'run_skill', skillKey });
    }
  });
});

describe('validateWorkflow — a condition must apply to the workflow’s events', () => {
  it.each<[string, Record<string, unknown>, string[], RegExp]>([
    ['reviewStates', { reviewStates: ['approved'] }, ['pr_opened'], /only applies to Review submitted/],
    ['labelName', { labelName: 'wip' }, ['pr_opened'], /only applies to Label added/],
    ['targetIsViewer', { targetIsViewer: true }, ['pr_opened'], /only applies to/],
    [
      'checkConclusions',
      { checkConclusions: ['failure'] },
      ['pr_opened'],
      /only applies to Checks finished/,
    ],
    ['bodyContains', { bodyContains: 'rebase' }, ['pr_opened'], /only applies to/],
  ])('refuses %s on the wrong event', (_name, conditions, events, message) => {
    expect(() => validateWorkflow(input({ conditions, events: events as never }))).toThrow(message);
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['reviewStates', { reviewStates: ['approved'] }, ['pr_review_submitted']],
    ['labelName', { labelName: 'wip' }, ['pr_labeled']],
    ['targetIsViewer', { targetIsViewer: true }, ['pr_review_requested']],
    ['checkConclusions', { checkConclusions: ['failure'] }, ['pr_checks_completed']],
    ['bodyContains', { bodyContains: 'rebase' }, ['pr_comment']],
  ])('accepts %s on the right event', (_name, conditions, events) => {
    expect(() => validateWorkflow(input({ conditions, events: events as never }))).not.toThrow();
  });

  it('accepts it when ONE of several events supports it', () => {
    expect(() =>
      validateWorkflow(
        input({
          conditions: { labelName: 'wip' },
          events: ['pr_opened', 'pr_labeled'] as never,
        })
      )
    ).not.toThrow();
  });

  it('a falsy value places no constraint, so it is not refused', () => {
    // `targetIsViewer: false` and a blank `labelName` mean "no constraint", and
    // an editor that ships defaults must not 400 for sending them.
    const out = validateWorkflow(
      input({ conditions: { targetIsViewer: false, labelName: '  ', bodyContains: '' } })
    );
    expect(out.conditions).toEqual({});
  });

  it('refuses an actor match that names no logins', () => {
    expect(() =>
      validateWorkflow(input({ conditions: { author: { kind: 'logins', logins: [] } } }))
    ).toThrow(/names no logins/);
  });

  it('refuses a bad review state and a bad check conclusion', () => {
    expect(() =>
      validateWorkflow(
        input({ conditions: { reviewStates: ['loved it'] as never }, events: ['pr_review_submitted'] as never })
      )
    ).toThrow(/not a review state/);
    expect(() =>
      validateWorkflow(
        input({
          conditions: { checkConclusions: ['flaky'] as never },
          events: ['pr_checks_completed'] as never,
        })
      )
    ).toThrow(/not a check conclusion/);
  });
});
