import { describe, it, expect } from 'vitest';
import { TASK_STATUSES, TASK_STATUS_TERMINAL, type TaskStatus } from '@talyn/shared';
import { activeFixStatus } from '../components/panels/codeReview/activeFix';

/**
 * Whether a Code review row says an agent is working its pull request.
 *
 * The rule is one line and two of its three answers are judgement calls — an
 * unknown task id and a terminal one both mean "nothing running" — so it is
 * pinned here rather than left inline in the panel.
 *
 * Duplicated in apps/desktop on purpose: the renderer is a deliberate fork.
 */

const ACTIVE = TASK_STATUSES.filter((s) => !TASK_STATUS_TERMINAL[s]);
const TERMINAL = TASK_STATUSES.filter((s) => TASK_STATUS_TERMINAL[s]);

function store(entries: Record<string, TaskStatus>): ReadonlyMap<string, TaskStatus> {
  return new Map(Object.entries(entries));
}

describe('activeFixStatus', () => {
  it.each(ACTIVE)('reports %s, because that run is still going', (status) => {
    expect(activeFixStatus('t1', store({ t1: status }))).toBe(status);
  });

  it.each(TERMINAL)('answers null for %s, because that run is history', (status) => {
    expect(activeFixStatus('t1', store({ t1: status }))).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('answers null when the PR has no linked task (%s)', (_label, taskId) => {
    expect(activeFixStatus(taskId, store({ t1: 'in_progress' }))).toBeNull();
  });

  it('answers null for a task the store has never heard of', () => {
    // The store carries the workspace's live tasks, so an id it cannot resolve
    // finished long enough ago to have fallen out. Answering the other way
    // would strand a spinner on the row for ever.
    expect(activeFixStatus('gone', store({ t1: 'in_progress' }))).toBeNull();
  });

  it('reads the status of the named task, not of some other running one', () => {
    const m = store({ mine: 'completed', theirs: 'in_progress' });
    expect(activeFixStatus('mine', m)).toBeNull();
  });

  it('covers every status the build knows about', () => {
    // The helper derives from TASK_STATUS_TERMINAL, so a new member must land
    // in exactly one of the two lists above and be exercised by this file.
    expect([...ACTIVE, ...TERMINAL].sort()).toEqual([...TASK_STATUSES].sort());
    expect(ACTIVE.length).toBeGreaterThan(0);
    expect(TERMINAL.length).toBeGreaterThan(0);
  });
});
