import type { Task } from '@talyn/shared';
import { useWorkspaceStore } from '../renderer/stores/workspace';

const TS = (iso: string) => ({ createdAt: iso, updatedAt: iso });

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

  it('drops an ACTIVE task of the fetched workspace absent from the fresh list', () => {
    // Both queued (active) by default. t2 absent → changed/deleted server-side.
    useWorkspaceStore.setState({ tasks: [makeTask('t1'), makeTask('t2')] });
    useWorkspaceStore.getState().reconcileTasks([makeTask('t1')], 'ws1');

    expect(useWorkspaceStore.getState().tasks.map((t) => t.id)).toEqual(['t1']);
  });

  it('KEEPS a completed history task absent from the fetch (paginated out, not deleted)', () => {
    // The reconnect fetch only covers active + the first history page, so an
    // older completed task missing from it must survive — it's just beyond the
    // page, not deleted.
    useWorkspaceStore.setState({
      tasks: [
        makeTask('active1', { status: 'in_progress' }),
        makeTask('oldDone', { status: 'completed' }),
      ],
    });
    // Fresh fetch returns only the active task (the old completed one is off-page).
    useWorkspaceStore
      .getState()
      .reconcileTasks([makeTask('active1', { status: 'in_progress' })], 'ws1');

    expect(useWorkspaceStore.getState().tasks.map((t) => t.id).sort()).toEqual([
      'active1',
      'oldDone',
    ]);
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

describe('workspace store — appendOlderTasks (lazy-loaded history pages)', () => {
  beforeEach(() =>
    useWorkspaceStore.setState({ tasks: [], tasksHasMore: false, tasksLoadingMore: false })
  );

  it('appends an older page after the existing tasks', () => {
    useWorkspaceStore.setState({
      tasks: [makeTask('c2', { status: 'completed', ...TS('2026-06-02T00:00:00Z') })],
    });
    useWorkspaceStore
      .getState()
      .appendOlderTasks([makeTask('c1', { status: 'completed', ...TS('2026-06-01T00:00:00Z') })]);

    expect(useWorkspaceStore.getState().tasks.map((t) => t.id)).toEqual(['c2', 'c1']);
  });

  it('dedupes ids already present (a boundary row re-fetched by the cursor)', () => {
    useWorkspaceStore.setState({
      tasks: [makeTask('c2', { status: 'completed' }), makeTask('c1', { status: 'completed' })],
    });
    // c1 arrives again alongside a genuinely new c0.
    useWorkspaceStore
      .getState()
      .appendOlderTasks([makeTask('c1', { status: 'completed' }), makeTask('c0', { status: 'completed' })]);

    expect(useWorkspaceStore.getState().tasks.map((t) => t.id)).toEqual(['c2', 'c1', 'c0']);
  });

  it('toggles the pagination flags', () => {
    const store = useWorkspaceStore.getState();
    store.setTasksHasMore(true);
    store.setTasksLoadingMore(true);
    expect(useWorkspaceStore.getState().tasksHasMore).toBe(true);
    expect(useWorkspaceStore.getState().tasksLoadingMore).toBe(true);
  });
});
