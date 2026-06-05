import type { Task } from '@fastowl/shared';
import { useWorkspaceStore } from '../renderer/stores/workspace';

function makeTask(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    workspaceId: 'ws1',
    type: 'pr_response',
    status: 'queued',
    priority: 'medium',
    title: `Task ${id}`,
    description: '',
    createdAt: '2026-06-05T00:00:00Z',
    updatedAt: '2026-06-05T00:00:00Z',
    ...over,
  };
}

describe('workspace store — addTask idempotency', () => {
  beforeEach(() => useWorkspaceStore.setState({ tasks: [] }));

  it('adds a new task', () => {
    useWorkspaceStore.getState().addTask(makeTask('t1'));
    expect(useWorkspaceStore.getState().tasks.map((t) => t.id)).toEqual(['t1']);
  });

  it('does not duplicate a task already present (e.g. optimistic add + task:created broadcast)', () => {
    const add = useWorkspaceStore.getState().addTask;
    add(makeTask('t1', { title: 'Original' }));
    // A second add for the same id (broadcast / on-demand fetch) is a no-op —
    // it must not append a duplicate or clobber the existing richer copy.
    add(makeTask('t1', { title: 'From broadcast' }));

    const { tasks } = useWorkspaceStore.getState();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Original');
  });
});
