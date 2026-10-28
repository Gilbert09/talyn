import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '@talyn/shared';
import { TaskTerminal } from '../renderer/components/panels/TaskTerminal';

jest.mock('../renderer/hooks/useApi', () => ({
  useTaskActions: () => ({ stopTask: jest.fn() }),
  mergeTaskTranscript: jest.fn(),
}));
jest.mock('../renderer/hooks/useOnReconnect', () => ({ useOnReconnect: jest.fn() }));
jest.mock('../renderer/lib/api', () => ({
  api: { tasks: { refreshLogs: jest.fn(), get: jest.fn().mockResolvedValue({}), watch: jest.fn().mockResolvedValue(undefined) } },
}));
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) => selector({ environments: [] }),
}));
jest.mock('../renderer/components/terminal/AgentConversation', () => ({
  AgentConversation: () => null,
}));

function task(overrides: Partial<Task> = {}, cloud?: Record<string, unknown>): Task {
  return {
    id: 't1',
    status: 'in_progress',
    transcript: [],
    metadata: cloud ? { cloudTask: { remoteTaskId: 'r1', ...cloud } } : {},
    ...overrides,
  } as unknown as Task;
}

describe('the run bar', () => {
  afterEach(cleanup);

  beforeEach(() => {
    window.open = jest.fn();
  });

  it('is one bar with the provider and a View run link for a cloud task', () => {
    const logUrl = 'https://example.test/run/1';
    const { container } = render(
      <TaskTerminal task={task({}, { provider: 'selfhosted', status: 'running', logUrl })} />
    );

    expect(screen.getByText('Run')).toBeTruthy();
    expect(screen.getByText('Working')).toBeTruthy();
    expect(screen.getByText('Talyn Fleet')).toBeTruthy();
    expect(container.textContent).not.toContain('Cloud run on');
    expect(screen.queryByText('running')).toBeNull();

    fireEvent.click(screen.getByText('View run'));
    expect(window.open).toHaveBeenCalledWith(logUrl, '_blank');
    expect(screen.getByText('Abort')).toBeTruthy();
  });

  it('omits the provider and View run when there is no cloud run', () => {
    render(<TaskTerminal task={task({ status: 'queued' })} />);

    expect(screen.getByText('Queued')).toBeTruthy();
    expect(screen.queryByText('View run')).toBeNull();
    expect(screen.queryByText('Talyn Fleet')).toBeNull();
  });
});
