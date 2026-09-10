import { describe, it, expect } from '@jest/globals';
import {
  availableWorkflowConditions,
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
  it('offers a trigger-specific condition only for its trigger', () => {
    expect(availableWorkflowConditions(['pr_opened'])).toEqual({
      reviewStates: false,
      labelName: false,
      targetIsViewer: false,
      checkConclusions: false,
      bodyContains: false,
    });
    expect(availableWorkflowConditions(['pr_review_submitted']).reviewStates).toBe(true);
    expect(availableWorkflowConditions(['pr_labeled']).labelName).toBe(true);
    expect(availableWorkflowConditions(['pr_review_requested']).targetIsViewer).toBe(true);
    expect(availableWorkflowConditions(['pr_checks_completed']).checkConclusions).toBe(true);
    expect(availableWorkflowConditions(['pr_comment']).bodyContains).toBe(true);
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
