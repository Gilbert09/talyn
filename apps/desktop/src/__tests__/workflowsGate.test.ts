import { describe, it, expect } from '@jest/globals';
import {
  availableWorkflowConditions,
  emptyWorkflowConditionValue,
  validateWorkflow,
  WORKFLOW_CONDITION_SPECS,
  emptyWorkflowAction,
  emptyWorkflowInput,
  pruneWorkflowConditions,
  workflowInputProblem,
  workflowsOffered,
  workflowToInput,
  WORKFLOW_ACTION_TYPES,
} from '@talyn/shared';

/**
 * The Workflows page's visibility rule, and the editor logic behind its Save
 * button. Both are pure and shared, following `cloudProviderOffered`: the
 * predicate is what caused the visible bug, so the predicate is what is tested.
 */

describe('workflowsOffered', () => {
  it('renders nothing while the capability answer is still loading', () => {
    // `null` is "not answered yet", NOT "you may not". Conflating them flashes
    // the nav item in on every launch.
    expect(workflowsOffered(null)).toBe(false);
    expect(workflowsOffered(undefined)).toBe(false);
  });

  it('renders nothing when the backend says no', () => {
    expect(workflowsOffered({ workflows: false })).toBe(false);
  });

  it('renders when the backend says yes', () => {
    expect(workflowsOffered({ workflows: true })).toBe(true);
  });

  it('is strict about the value — a truthy non-true does not open the door', () => {
    expect(workflowsOffered({ workflows: 1 as unknown as boolean })).toBe(false);
  });
});

describe('the editor’s starting point', () => {
  it('opens on something, but not on something savable', () => {
    const input = emptyWorkflowInput();
    expect(input.events).toEqual(['pr_opened']);
    // Refused until the user says what to do: no name, and a label action with
    // no labels.
    expect(workflowInputProblem(input)).not.toBeNull();
  });

  it('is savable once named and filled in', () => {
    const input = {
      ...emptyWorkflowInput(),
      name: 'Label new PRs',
      actions: [{ type: 'add_labels' as const, labels: ['talyn-seen'] }],
    };
    expect(workflowInputProblem(input)).toBeNull();
  });

  it('round-trips a stored workflow back into the form', () => {
    const input = workflowToInput({
      id: 'w1',
      workspaceId: 'ws',
      name: 'Watch bot PRs',
      enabled: false,
      events: ['pr_opened'],
      conditions: { author: { kind: 'bot' } },
      actions: [{ type: 'watch_pr' }],
      maxRunsPerPrPerHour: 9,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    });
    expect(input).toEqual({
      name: 'Watch bot PRs',
      enabled: false,
      events: ['pr_opened'],
      conditions: { author: { kind: 'bot' } },
      actions: [{ type: 'watch_pr' }],
      maxRunsPerPrPerHour: 9,
    });
  });

  it('gives every action type a starting shape', () => {
    for (const type of WORKFLOW_ACTION_TYPES) {
      expect(emptyWorkflowAction(type).type).toBe(type);
    }
  });
});

describe('the form cannot compose a workflow the API refuses', () => {
  const keysFor = (events: Parameters<typeof availableWorkflowConditions>[0]) =>
    availableWorkflowConditions(events).map((s) => s.key);

  it('always offers the generic PR filters, whatever the trigger is', () => {
    // "but also generic PR filters should still apply" — repo, branch, author,
    // title, labels, draft and actor are offered for every event.
    for (const key of ['repos', 'baseBranches', 'author', 'titleContains', 'draft', 'actor']) {
      expect(keysFor(['pr_opened'])).toContain(key);
      expect(keysFor(['pr_checks_completed'])).toContain(key);
    }
  });

  it('offers a trigger-specific condition only for its trigger', () => {
    expect(keysFor(['pr_opened'])).not.toContain('reviewStates');
    expect(keysFor(['pr_review_submitted'])).toContain('reviewStates');
    expect(keysFor(['pr_labeled'])).toContain('labelName');
    expect(keysFor(['pr_review_requested'])).toContain('target');
    expect(keysFor(['pr_checks_completed'])).toContain('checkConclusions');
    expect(keysFor(['pr_comment'])).toContain('bodyContains');
  });

  it('does not re-offer a condition the workflow already carries', () => {
    // The "Add condition" menu is the specs minus what is on the page, so it can
    // never produce a duplicate row.
    const already = availableWorkflowConditions(['pr_opened'], { repos: ['acme/widget'] });
    expect(already.map((s) => s.key)).not.toContain('repos');
    expect(already.map((s) => s.key)).toContain('titleContains');
  });

  /**
   * Conditions whose input is a boolean, and so have no "present but unset"
   * state. Adding one constrains immediately — unavoidably, and the starting
   * value is the common intent rather than a neutral one.
   */
  const BOOLEAN_INPUTS = ['draft', 'baseIsDefault'];

  it('gives every condition a starting value that constrains nothing', () => {
    // A freshly added condition must not silently narrow the workflow before the
    // user has typed anything — the validator drops each of these.
    for (const spec of WORKFLOW_CONDITION_SPECS.filter(
      (s) => !BOOLEAN_INPUTS.includes(s.input)
    )) {
      const value = emptyWorkflowConditionValue(spec);
      const savable = validateWorkflow({
        name: 'x',
        events: spec.appliesTo ? [...spec.appliesTo] : ['pr_opened'],
        conditions: { [spec.key]: value },
        actions: [{ type: 'watch_pr' }],
      });
      // The key is in the loop's failure output via the spec list, and jest's
      // `expect` takes no message argument (that is vitest).
      expect(savable.conditions[spec.key]).toBeUndefined();
    }
  });

  it.each(BOOLEAN_INPUTS)('starts the %s condition at the common intent', (input) => {
    // "Not a draft" and "not the default branch" — the second being the whole
    // reason somebody adds a base-branch condition: they are after stacked PRs.
    const spec = WORKFLOW_CONDITION_SPECS.find((s) => s.input === input)!;
    expect(emptyWorkflowConditionValue(spec)).toBe(false);
    const savable = validateWorkflow({
      name: 'x',
      events: ['pr_opened'],
      conditions: { [spec.key]: false },
      actions: [{ type: 'watch_pr' }],
    });
    expect(savable.conditions[spec.key]).toBe(false);
  });

  it('prunes a condition when its trigger is unchecked', () => {
    // Without this, unchecking "Review submitted" leaves `reviewStates` behind
    // and the save 400s about a field that is no longer on screen.
    const pruned = pruneWorkflowConditions(
      { reviewStates: ['approved'], repos: ['acme/widget'] },
      ['pr_opened']
    );
    expect(pruned).toEqual({ repos: ['acme/widget'] });
  });

  it('keeps a condition whose trigger is still selected', () => {
    const kept = pruneWorkflowConditions({ reviewStates: ['approved'] }, [
      'pr_opened',
      'pr_review_submitted',
    ]);
    expect(kept.reviewStates).toEqual(['approved']);
  });

  it('the pruned result is savable where the unpruned one is not', () => {
    const base = { ...emptyWorkflowInput(), name: 'x', actions: [{ type: 'watch_pr' as const }] };
    const bad = { ...base, conditions: { reviewStates: ['approved' as const] } };
    expect(workflowInputProblem(bad)).toMatch(/only applies to/);
    const good = { ...bad, conditions: pruneWorkflowConditions(bad.conditions, bad.events) };
    expect(workflowInputProblem(good)).toBeNull();
  });
});
