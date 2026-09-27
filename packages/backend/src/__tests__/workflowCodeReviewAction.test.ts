import { describe, it, expect } from 'vitest';
import {
  describeWorkflowAction,
  emptyWorkflowAction,
  validateWorkflow,
  WORKFLOW_ACTION_LABELS,
  WORKFLOW_ACTION_TYPES,
  type WorkflowInput,
} from '@talyn/shared';

/**
 * The "run a code review" workflow action.
 *
 * The vocabulary is a discriminated union feeding three exhaustive switches and
 * two Records, so most of this is enforced by the compiler. What is NOT — and so
 * is asserted here — is the validator's treatment of the optional preset, and
 * the fact that a review does not count as a task-starting action.
 */

const base = (actions: unknown[]): WorkflowInput =>
  ({
    name: 'review new PRs',
    enabled: true,
    events: ['pr_opened'],
    conditions: {},
    actions,
    maxRunsPerPrPerHour: 5,
  }) as unknown as WorkflowInput;

describe('run_code_review', () => {
  it('is in the action vocabulary with a label', () => {
    expect(WORKFLOW_ACTION_TYPES).toContain('run_code_review');
    expect(WORKFLOW_ACTION_LABELS.run_code_review).toBe('Run a code review');
  });

  it('starts with no preset, so it follows the workspace default', () => {
    // A workflow written before a team settles on a depth should keep following
    // that setting rather than pinning whatever was current the day it was saved.
    expect(emptyWorkflowAction('run_code_review')).toEqual({ type: 'run_code_review' });
  });

  it.each(['quick', 'standard', 'deep'])('accepts the %s preset', (preset) => {
    const wf = validateWorkflow(base([{ type: 'run_code_review', preset }]));
    expect(wf.actions[0]).toEqual({ type: 'run_code_review', preset });
  });

  it('accepts an absent preset and stores no preset key', () => {
    const wf = validateWorkflow(base([{ type: 'run_code_review' }]));
    expect(wf.actions[0]).toEqual({ type: 'run_code_review' });
  });

  it('refuses a preset that is not a depth', () => {
    // Heard while typing rather than as a dispatch that failed an hour later.
    expect(() => validateWorkflow(base([{ type: 'run_code_review', preset: 'thorough' }]))).toThrow(
      /quick, standard or deep/
    );
  });

  it.each([
    [{ type: 'run_code_review' }, 'Run a code review'],
    [{ type: 'run_code_review', preset: 'deep' }, 'Run a deep code review'],
  ])('describes itself for the run history', (action, expected) => {
    expect(describeWorkflowAction(action as never)).toBe(expected);
  });
});

describe('workflowActionStartsTask', () => {
  it('does NOT count a code review as a task action', async () => {
    // Load-bearing, not a detail. A review's units are not `tasks` rows — they
    // cannot be, because activePrTaskId would refuse the second one and
    // withTaskLimitGate would spend the plan's allowance on them. Counting the
    // review here would make a workflow reserve a task slot it never uses.
    const { workflowActionStartsTask } = await import('@talyn/shared');
    expect(workflowActionStartsTask({ type: 'run_code_review' })).toBe(false);
    expect(workflowActionStartsTask({ type: 'run_prompt', prompt: 'x' })).toBe(true);
  });
});
