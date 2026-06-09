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

describe('workspace store — reconcileTasks (reconnect catch-up)', () => {
  beforeEach(() => useWorkspaceStore.setState({ tasks: [], selectedTaskId: null }));

  it('applies a missed status change for an existing task', () => {
    useWorkspaceStore.setState({ tasks: [makeTask('t1', { status: 'in_progress' })] });
    // Server-side the run auto-finalised while we were offline.
    useWorkspaceStore
      .getState()
      .reconcileTasks([makeTask('t1', { status: 'completed' })], 'ws1');

    const { tasks } = useWorkspaceStore.getState();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('completed');
  });

  it('preserves a locally-loaded transcript the list endpoint omits', () => {
    const transcript = [{ seq: 1 } as never];
    useWorkspaceStore.setState({
      tasks: [makeTask('t1', { status: 'in_progress', transcript })],
    });
    // The list payload has no transcript — reconcile must not wipe the local one.
    useWorkspaceStore
      .getState()
      .reconcileTasks([makeTask('t1', { status: 'completed' })], 'ws1');

    const updated = useWorkspaceStore.getState().tasks[0];
    expect(updated.status).toBe('completed');
    expect(updated.transcript).toBe(transcript);
  });

  it('adds tasks created while offline and orders by the server payload', () => {
    useWorkspaceStore.setState({ tasks: [makeTask('t1')] });
    useWorkspaceStore
      .getState()
      .reconcileTasks([makeTask('t2'), makeTask('t1')], 'ws1');

    expect(useWorkspaceStore.getState().tasks.map((t) => t.id)).toEqual(['t2', 't1']);
  });

  it('drops a task of the fetched workspace that was deleted offline', () => {
    useWorkspaceStore.setState({ tasks: [makeTask('t1'), makeTask('t2')] });
    // t2 absent from the fresh list → deleted server-side.
    useWorkspaceStore.getState().reconcileTasks([makeTask('t1')], 'ws1');

    expect(useWorkspaceStore.getState().tasks.map((t) => t.id)).toEqual(['t1']);
  });

  it('keeps tasks belonging to a different workspace than the one fetched', () => {
    useWorkspaceStore.setState({
      tasks: [makeTask('t1', { workspaceId: 'ws1' }), makeTask('other', { workspaceId: 'ws2' })],
    });
    // Reconcile only covers ws1; the ws2 task must survive.
    useWorkspaceStore.getState().reconcileTasks([makeTask('t1')], 'ws1');

    expect(useWorkspaceStore.getState().tasks.map((t) => t.id).sort()).toEqual([
      'other',
      't1',
    ]);
  });

  it('clears the selection when the selected task vanished server-side', () => {
    useWorkspaceStore.setState({
      tasks: [makeTask('t1')],
      selectedTaskId: 't1',
    });
    useWorkspaceStore.getState().reconcileTasks([], 'ws1');

    expect(useWorkspaceStore.getState().selectedTaskId).toBeNull();
  });

  it('keeps the selection when the selected task still exists', () => {
    useWorkspaceStore.setState({
      tasks: [makeTask('t1', { status: 'in_progress' })],
      selectedTaskId: 't1',
    });
    useWorkspaceStore
      .getState()
      .reconcileTasks([makeTask('t1', { status: 'completed' })], 'ws1');

    expect(useWorkspaceStore.getState().selectedTaskId).toBe('t1');
  });
});
