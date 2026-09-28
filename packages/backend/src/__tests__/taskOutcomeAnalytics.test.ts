import { describe, it, expect } from 'vitest';
import type { TaskResult, TaskStatus } from '@talyn/shared';
import {
  taskOutcomeEventName,
  taskOutcomeProperties,
} from '../services/analytics.js';

/**
 * The property bag every terminal task event carries.
 *
 * Both pollers build it through these two helpers, so the split between
 * `task_completed` / `task_needs_human` / `task_failed` and the shape of the
 * properties cannot drift between the fleet and PostHog Code — which is what
 * they did before: only one provider sent `duration_run_ms`, so the two could
 * not be compared on the one number anybody wanted.
 */

const CREATED = new Date('2026-09-20T10:00:00.000Z');
const DISPATCHED = '2026-09-20T10:00:30.000Z';
const FINISHED = new Date('2026-09-20T11:00:00.000Z');

function props(
  overrides: Partial<Parameters<typeof taskOutcomeProperties>[0]> = {}
): Record<string, unknown> {
  return taskOutcomeProperties({
    taskId: 'task-1',
    taskType: 'pr_response',
    provider: 'selfhosted',
    status: 'completed',
    result: { success: true },
    createdAt: CREATED,
    finishedAt: FINISHED,
    metadata: { dispatchedAt: DISPATCHED, source: 'auto_keep' },
    openedPr: true,
    ...overrides,
  });
}

describe('taskOutcomeEventName', () => {
  it.each([
    ['completed', 'task_completed'],
    ['needs_human', 'task_needs_human'],
    ['failed', 'task_failed'],
    ['cancelled', 'task_failed'],
  ] as const)('maps %s to %s', (status, expected) => {
    expect(taskOutcomeEventName(status as TaskStatus)).toBe(expected);
  });

  it('keeps a refusal distinct from a failure', () => {
    // The whole reason the split is three-way: folding needs_human into
    // task_failed makes a considered stand-down indistinguishable from a crash.
    expect(taskOutcomeEventName('needs_human')).not.toBe(
      taskOutcomeEventName('failed')
    );
  });
});

describe('taskOutcomeProperties — durations', () => {
  it('measures duration_total_ms from creation', () => {
    expect(props().duration_total_ms).toBe(60 * 60 * 1000);
  });

  it('measures duration_run_ms from dispatch, excluding the queue wait', () => {
    expect(props().duration_run_ms).toBe(59.5 * 60 * 1000);
  });

  it.each([
    ['absent', {}],
    ['unparseable', { dispatchedAt: 'not-a-date' }],
    ['null', { dispatchedAt: null }],
    ['a number', { dispatchedAt: 1758362430000 }],
  ])('omits duration_run_ms when dispatchedAt is %s', (_label, metadata) => {
    const p = props({ metadata });
    // Omitted, never zero: a task that failed before dispatch has no run to
    // time, and a 0 would drag every average it lands in.
    expect(p).not.toHaveProperty('duration_run_ms');
    expect(p.duration_total_ms).toBe(60 * 60 * 1000);
  });
});

describe('taskOutcomeProperties — source', () => {
  it.each(['user', 'auto_keep', 'merge_queue', 'code_review', 'loop', 'workflow'])(
    'passes through the known source %s',
    (source) => {
      expect(props({ metadata: { source } }).source).toBe(source);
    }
  );

  it.each([
    ['absent', {}],
    ['a source this build does not know', { source: 'from_the_future' }],
    ['not a string', { source: 42 }],
    ['null', { source: null }],
  ])('omits source when it is %s', (_label, metadata) => {
    // Omitted rather than bucketed as "unknown": a missing property can be
    // excluded from a breakdown, whereas an "unknown" bucket silently mixes
    // rows written before sources existed in with genuinely untagged ones.
    expect(props({ metadata })).not.toHaveProperty('source');
  });
});

describe('taskOutcomeProperties — optional dimensions', () => {
  it.each([
    ['repository', 'PostHog/posthog'],
    ['model', 'claude-opus-5'],
  ])('includes %s when present', (key, value) => {
    expect(props({ [key]: value })[key]).toBe(value);
  });

  it.each([
    ['repository', null],
    ['repository', undefined],
    ['repository', ''],
    ['model', null],
    ['model', undefined],
    ['model', ''],
  ])('omits %s when it is %s', (key, value) => {
    expect(props({ [key]: value })).not.toHaveProperty(key);
  });

  it('carries error_reason only on a result that has one', () => {
    const failed: TaskResult = { success: false, error: 'boom' };
    expect(props({ result: failed }).error_reason).toBe('boom');
    expect(props({ result: { success: true } })).not.toHaveProperty('error_reason');
  });

  it('does not put a needs_human reason in error_reason', () => {
    // `result.error` is what the admin console paints red. A refusal is not a
    // failure, so its reason deliberately travels on `needsHuman`.
    const refusal: TaskResult = {
      success: false,
      needsHuman: { reason: 'A human must approve the visual review.' },
    };
    expect(props({ result: refusal, status: 'needs_human' })).not.toHaveProperty(
      'error_reason'
    );
  });

  it('merges provider-specific extras', () => {
    expect(props({ extra: { cost_usd: 1.25 } }).cost_usd).toBe(1.25);
  });

  it('always carries the dimensions a breakdown needs', () => {
    expect(props()).toMatchObject({
      task_id: 'task-1',
      task_type: 'pr_response',
      provider: 'selfhosted',
      opened_pr: true,
    });
  });
});
