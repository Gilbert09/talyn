import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '@talyn/shared';
import { QueuePanel } from '../renderer/components/panels/QueuePanel';

let tasks: Task[] = [];
let selectedTaskId: string | null = null;

jest.mock('../renderer/lib/api', () => ({ api: { ws: { on: () => () => {} } } }));
jest.mock('../renderer/hooks/useSkills', () => ({ useSkills: jest.fn() }));
jest.mock('../renderer/hooks/useApi', () => ({
  useTaskActions: () => ({
    retryTask: jest.fn(), deleteTask: jest.fn(), startTask: jest.fn(), cancelTask: jest.fn(),
  }),
  loadMoreTasks: jest.fn(),
}));
jest.mock('../renderer/components/panels/TaskTerminal', () => ({ TaskTerminal: () => null }));
jest.mock('../renderer/components/panels/github/useGitHubActions', () => ({ useGitHubActions: () => ({}) }));
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = { tasks, selectedTaskId, selectTask: () => {}, environments: [], repositories: [],
      tasksHasMore: false, tasksLoadingMore: false, tasksHistoryTotal: 0 };
    return selector ? selector(state) : state;
  },
}));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1', workspaceId: 'ws-1', type: 'code_writing', status: 'queued',
    priority: 'medium', title: 'A task', description: '', prompt: 'Prompt text from Talyn',
    createdAt: '2026-11-02T12:00:00.000Z', updatedAt: '2026-11-02T12:00:00.000Z',
    ...overrides,
  };
}

function renderTask(value: Task) {
  tasks = [value];
  selectedTaskId = value.id;
  return render(<QueuePanel />);
}

afterEach(() => {
  cleanup();
  tasks = [];
  selectedTaskId = null;
  jest.clearAllMocks();
});

describe('task prompt', () => {
  it.each([
    ['an automatic loop', task({ metadata: { source: 'loop' } })],
    ['a PR template started by a person', task({ type: 'pr_response', metadata: { source: 'user' } })],
    ['a skill prompt', task({ metadata: { source: 'user', skill: { name: 'Review' } } })],
    ['a task without a source', task()],
    ['a finished automatic task', task({ status: 'completed', metadata: { source: 'merge_queue' } })],
    ['a running automatic task', task({ status: 'in_progress', metadata: { source: 'auto_keep' } })],
  ])('collapses %s and lets the person show and hide its prompt', (_name, value) => {
    renderTask(value);
    const show = screen.getByRole('button', { name: 'Show prompt' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Prompt text from Talyn')).not.toBeInTheDocument();

    fireEvent.click(show);
    expect(screen.getByText('Prompt text from Talyn')).toBeInTheDocument();
    const hide = screen.getByRole('button', { name: 'Hide prompt' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(hide);
    expect(screen.queryByText('Prompt text from Talyn')).not.toBeInTheDocument();
  });

  it('collapses a person typed prompt once the run is over', () => {
    renderTask(task({ status: 'completed', prompt: 'Please fix this bug', metadata: { source: 'user' } }));
    expect(screen.queryByText('Please fix this bug')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show prompt' })).toBeInTheDocument();
  });

  it('shows a person typed code task prompt by default', () => {
    renderTask(task({ prompt: 'Please fix this bug', metadata: { source: 'user' } }));
    expect(screen.getByText('Please fix this bug')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide prompt' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the choice for each task while switching tasks', () => {
    const first = task({ metadata: { source: 'loop' } });
    const second = task({ id: 'task-2', title: 'Another task', prompt: 'Another prompt', metadata: { source: 'workflow' } });
    tasks = [first, second];
    selectedTaskId = first.id;
    const view = render(<QueuePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Show prompt' }));
    expect(screen.getByText(first.prompt!)).toBeInTheDocument();

    selectedTaskId = second.id;
    view.rerender(<QueuePanel />);
    expect(screen.queryByText(second.prompt!)).not.toBeInTheDocument();
    selectedTaskId = first.id;
    view.rerender(<QueuePanel />);
    expect(screen.getByText(first.prompt!)).toBeInTheDocument();
  });
});
