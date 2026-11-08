import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MAX_MEMORY_NAME_CHARS, type MemoryEntrySummary } from '@talyn/shared';
import { MemorySection } from '../components/settings/MemorySection';

const { mockList, mockGet, mockPut, mockUpdate, mockForget, mockRestore, mockWorkspaceUpdate, mockToastError, mockToastSuccess, mockNavigate, mockSetWorkspaces, mockReviews, mockStartReview } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockUpdate: vi.fn(),
  mockForget: vi.fn(),
  mockRestore: vi.fn(),
  mockWorkspaceUpdate: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockReviews: vi.fn(),
  mockStartReview: vi.fn(),
  mockNavigate: vi.fn(),
  mockSetWorkspaces: vi.fn(),
}));
vi.mock('../lib/api', () => ({
  api: {
    workbenches: {
      memory: {
        list: (...args: unknown[]) => mockList(...args),
        get: (...args: unknown[]) => mockGet(...args),
        put: (...args: unknown[]) => mockPut(...args),
        update: (...args: unknown[]) => mockUpdate(...args),
        forget: (...args: unknown[]) => mockForget(...args),
        restore: (...args: unknown[]) => mockRestore(...args),
        reviews: (...args: unknown[]) => mockReviews(...args),
        startReview: (...args: unknown[]) => mockStartReview(...args),
      },
    },
    workspaces: { update: (...args: unknown[]) => mockWorkspaceUpdate(...args) },
  },
}));
vi.mock('../stores/toast', () => ({
  toast: { success: (...args: unknown[]) => mockToastSuccess(...args), error: (...args: unknown[]) => mockToastError(...args), info: vi.fn() },
}));
vi.mock('../stores/navigation', () => ({
  useNavigationStore: { getState: () => ({ navigate: mockNavigate }) },
}));
const mockState = {
  currentWorkspaceId: 'ws1',
  workspaces: [{ id: 'ws1', name: 'Acme', settings: {} as Record<string, unknown> }],
  setWorkspaces: (...args: unknown[]) => mockSetWorkspaces(...args),
  repositories: [
    { id: 'r1', workspaceId: 'ws1', owner: 'acme', repo: 'app', fullName: 'acme/app' },
    { id: 'r2', workspaceId: 'ws1', owner: 'acme', repo: 'api', fullName: 'acme/api' },
  ],
};
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: Object.assign((selector: (s: unknown) => unknown) => selector(mockState), {
    getState: () => mockState,
  }),
}));

const NOW = new Date().toISOString();

const entry = (over: Partial<MemoryEntrySummary> = {}): MemoryEntrySummary => ({
  id: 'm1',
  workspaceId: 'ws1',
  scope: 'workspace',
  repositoryId: null,
  threadId: null,
  type: 'feedback',
  name: 'Commit style',
  description: 'Use semantic commit messages.',
  bytes: 20,
  source: { kind: 'user' },
  createdAt: NOW,
  updatedAt: NOW,
  forgottenAt: null,
  ...over,
});

const ENTRIES = [
  entry(),
  entry({
    id: 'm2',
    scope: 'repository',
    repositoryId: 'r1',
    type: 'project',
    name: 'Build command',
    description: 'How to build the app.',
    source: { kind: 'session', workbenchId: 'wb9' },
  }),
  entry({ id: 'm3', scope: 'repository', repositoryId: 'r2', type: 'reference', name: 'API docs', description: 'Where the docs are.' }),
];

beforeEach(() => {
  mockState.workspaces = [{ id: 'ws1', name: 'Acme', settings: {} }];
  mockList.mockResolvedValue(ENTRIES);
  mockGet.mockImplementation(async (id: string) => ({ ...ENTRIES.find((e) => e.id === id)!, body: `Body of ${id}` }));
  mockUpdate.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
    ...ENTRIES.find((e) => e.id === id)!,
    ...patch,
    body: (patch.body as string) ?? `Body of ${id}`,
  }));
  mockPut.mockImplementation(async (input: Record<string, unknown>) => ({
    outcome: 'created',
    entry: { ...entry({ id: 'm9', ...input, source: { kind: 'user' } } as Partial<MemoryEntrySummary>), body: input.body },
  }));
  mockForget.mockImplementation(async (id: string) => ({ ...ENTRIES.find((e) => e.id === id)!, forgottenAt: NOW }));
  mockRestore.mockImplementation(async (id: string) => ({ ...ENTRIES.find((e) => e.id === id)!, body: `Body of ${id}` }));
  mockWorkspaceUpdate.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const loaded = () => waitFor(() => expect(screen.getByTestId('memory-count').textContent).toBe('3 of 500'));
const groupNames = () => screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'));

describe('MemorySection', () => {
  it('lists live entries grouped by scope, workspace first, then each repository by name', async () => {
    render(<MemorySection />);
    await loaded();
    expect(mockList).toHaveBeenCalledWith({ workspaceId: 'ws1' });
    expect(groupNames()).toEqual(['Workspace', 'acme/api', 'acme/app']);
    const app = screen.getByRole('group', { name: 'acme/app' });
    expect(within(app).getByText('Build command')).toBeTruthy();
    expect(within(app).getByText('Project')).toBeTruthy();
    expect(within(app).getByText('How to build the app.')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Workspace' })).getByText('Added by you')).toBeTruthy();
  });

  it('opens the session that saved an entry', async () => {
    render(<MemorySection />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Saved by a session' }));
    expect(mockNavigate).toHaveBeenCalledWith({ view: 'workbench', id: 'wb9' });
  });

  it('shows the body when a row is opened', async () => {
    render(<MemorySection />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Show Commit style' }));
    await waitFor(() => expect(screen.getByTestId('memory-body').textContent).toBe('Body of m1'));
    expect(mockGet).toHaveBeenCalledWith('m1');
  });

  it('saves an edit through the client with only the changed fields', async () => {
    render(<MemorySection />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Build command' }));
    const description = screen.getByRole('textbox', { name: 'Memory description' }) as HTMLInputElement;
    await waitFor(() => expect(description.value).toBe('How to build the app.'));
    fireEvent.change(description, { target: { value: 'Run make build.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('m2', { description: 'Run make build.' }));
    await waitFor(() => expect(screen.getByText('Run make build.')).toBeTruthy());
    expect(screen.queryByTestId('memory-editor')).toBeNull();
  });

  it("shows the shared validator's message and does not save a name that is too long", async () => {
    render(<MemorySection />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Commit style' }));
    const name = screen.getByRole('textbox', { name: 'Memory name' }) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe('Commit style'));
    fireEvent.change(name, { target: { value: 'x'.repeat(MAX_MEMORY_NAME_CHARS + 1) } });
    expect(screen.getByText(`${MAX_MEMORY_NAME_CHARS + 1} / ${MAX_MEMORY_NAME_CHARS}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toBe(
      `name can be at most ${MAX_MEMORY_NAME_CHARS} characters; this one is ${MAX_MEMORY_NAME_CHARS + 1}.`,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('forgets an entry, then brings it back with Undo', async () => {
    render(<MemorySection />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Forget API docs' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy());
    expect(mockForget).toHaveBeenCalledWith('m3');
    expect(screen.getByText('Forgotten')).toBeTruthy();
    expect(screen.getByTestId('memory-count').textContent).toBe('2 of 500');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Forget API docs' })).toBeTruthy());
    expect(mockRestore).toHaveBeenCalledWith('m3');
    expect(screen.getByTestId('memory-count').textContent).toBe('3 of 500');
  });

  it('turns session memory off through the workspace setting', async () => {
    render(<MemorySection />);
    await loaded();
    const toggle = screen.getByRole('switch', { name: 'Session memory' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => expect(mockWorkspaceUpdate).toHaveBeenCalledWith('ws1', { settings: { sessionMemory: false } }));
    await waitFor(() => expect(mockSetWorkspaces).toHaveBeenCalled());
    expect(mockSetWorkspaces.mock.calls[0][0][0].settings).toEqual({ sessionMemory: false });
  });

  it('shows the switch off when the workspace turned memory off', async () => {
    mockState.workspaces = [{ id: 'ws1', name: 'Acme', settings: { sessionMemory: false } }];
    render(<MemorySection />);
    await loaded();
    expect(screen.getByRole('switch', { name: 'Session memory' }).getAttribute('aria-checked')).toBe('false');
  });

  it('adds a memory for one repository', async () => {
    render(<MemorySection />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Memory scope' }), { target: { value: 'r2' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Memory type' }), { target: { value: 'reference' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Memory name' }), { target: { value: 'Staging URL' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Memory description' }), { target: { value: 'Where staging runs.' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Memory note' }), { target: { value: 'https://staging.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        scope: 'repository',
        repositoryId: 'r2',
        type: 'reference',
        name: 'Staging URL',
        description: 'Where staging runs.',
        body: 'https://staging.example',
      }),
    );
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'acme/api' })).getByText('Staging URL')).toBeTruthy());
    expect(screen.getByTestId('memory-count').textContent).toBe('4 of 500');
  });

  it('refuses an empty create with the validator message', async () => {
    render(<MemorySection />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toBe('name is required');
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('searches with q and can include forgotten entries', async () => {
    vi.useFakeTimers();
    try {
      render(<MemorySection />);
      await act(async () => {
        await Promise.resolve();
      });
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search memory' }), { target: { value: 'build' } });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(mockList).toHaveBeenLastCalledWith({ workspaceId: 'ws1', q: 'build' });
      fireEvent.click(screen.getByRole('checkbox', { name: 'Show forgotten' }));
      expect(mockList).toHaveBeenLastCalledWith({ workspaceId: 'ws1', q: 'build', includeForgotten: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('explains what memory is when there are no entries', async () => {
    mockList.mockResolvedValue([]);
    render(<MemorySection />);
    await waitFor(() =>
      expect(
        screen.getByText('Sessions save notes here as they learn about your work. You can add your own too.'),
      ).toBeTruthy(),
    );
    expect(screen.getByTestId('memory-count').textContent).toBe('0 of 500');
  });

  describe('memory review', () => {
    const run = (over: Record<string, unknown> = {}) => ({
      id: 'run1',
      workspaceId: 'ws1',
      trigger: 'schedule',
      status: 'started',
      workbenchId: 'wb7',
      error: null,
      createdAt: NOW,
      ...over,
    });
    const reviewSelect = () => screen.getByRole('combobox', { name: 'Memory review' }) as HTMLSelectElement;

    beforeEach(() => {
      mockReviews.mockResolvedValue({ cadence: 'off', runs: [] });
      mockStartReview.mockResolvedValue(run({ trigger: 'manual' }));
    });

    it('shows the cadence of the workspace, off when unset', async () => {
      render(<MemorySection />);
      await loaded();
      expect(reviewSelect().value).toBe('off');
      expect(within(reviewSelect()).getAllByRole('option').map((o) => o.textContent)).toEqual([
        'Off',
        'Daily',
        'Weekly',
        'Monthly',
      ]);
    });

    it('shows the saved cadence', async () => {
      mockState.workspaces = [{ id: 'ws1', name: 'Acme', settings: { memoryReview: 'monthly' } }];
      render(<MemorySection />);
      await loaded();
      expect(reviewSelect().value).toBe('monthly');
    });

    it('saves a new cadence through the workspace setting', async () => {
      render(<MemorySection />);
      await loaded();
      fireEvent.change(reviewSelect(), { target: { value: 'weekly' } });
      await waitFor(() => expect(mockWorkspaceUpdate).toHaveBeenCalledWith('ws1', { settings: { memoryReview: 'weekly' } }));
      await waitFor(() => expect(mockSetWorkspaces).toHaveBeenCalled());
      expect(mockSetWorkspaces.mock.calls[0][0][0].settings).toEqual({ memoryReview: 'weekly' });
    });

    it('shows an error when the cadence does not save', async () => {
      mockWorkspaceUpdate.mockRejectedValueOnce(new Error('nope'));
      render(<MemorySection />);
      await loaded();
      fireEvent.change(reviewSelect(), { target: { value: 'daily' } });
      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('nope'));
      expect(mockSetWorkspaces).not.toHaveBeenCalled();
    });

    it('starts a review and loads the runs again', async () => {
      render(<MemorySection />);
      await loaded();
      await waitFor(() => expect(mockReviews).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole('button', { name: 'Review now' }));
      await waitFor(() => expect(mockStartReview).toHaveBeenCalledWith('ws1'));
      await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Memory review started'));
      await waitFor(() => expect(mockReviews).toHaveBeenCalledTimes(2));
    });

    it('shows the refusal message when a review does not start', async () => {
      mockStartReview.mockRejectedValueOnce(new Error('Memory has fewer than two notes'));
      render(<MemorySection />);
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'Review now' }));
      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Memory has fewer than two notes'));
      expect(mockToastSuccess).not.toHaveBeenCalled();
    });

    it('disables Review now while session memory is off', async () => {
      mockState.workspaces = [{ id: 'ws1', name: 'Acme', settings: { sessionMemory: false } }];
      render(<MemorySection />);
      await loaded();
      expect((screen.getByRole('button', { name: 'Review now' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('shows no line when there are no runs', async () => {
      render(<MemorySection />);
      await loaded();
      await waitFor(() => expect(mockReviews).toHaveBeenCalled());
      expect(screen.queryByText(/Last review/)).toBeNull();
      expect(screen.queryByText('A review is starting')).toBeNull();
    });

    it('shows a started run with a link to its thread', async () => {
      mockReviews.mockResolvedValue({ cadence: 'daily', runs: [run()] });
      render(<MemorySection />);
      await loaded();
      await screen.findByText(/Last review:/);
      expect(screen.getByText('just now')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Open thread' }));
      expect(mockNavigate).toHaveBeenCalledWith({ view: 'workbench', id: 'wb7' });
    });

    it('shows the error of a failed run', async () => {
      mockReviews.mockResolvedValue({
        cadence: 'daily',
        runs: [run({ status: 'failed', workbenchId: null, error: 'No sandbox' }), run({ id: 'run0' })],
      });
      render(<MemorySection />);
      await loaded();
      expect(await screen.findByText('Last review failed: No sandbox')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Open thread' })).toBeNull();
    });

    it('shows a run that is starting', async () => {
      mockReviews.mockResolvedValue({ cadence: 'daily', runs: [run({ status: 'starting', workbenchId: null })] });
      render(<MemorySection />);
      await loaded();
      expect(await screen.findByText('A review is starting')).toBeTruthy();
    });

    it('shows nothing, and no error toast, when the runs do not load', async () => {
      mockReviews.mockRejectedValue(new Error('network down'));
      render(<MemorySection />);
      await loaded();
      await waitFor(() => expect(mockReviews).toHaveBeenCalled());
      expect(screen.queryByText(/Last review/)).toBeNull();
      expect(mockToastError).not.toHaveBeenCalled();
    });
  });
});
