import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MAX_REPOSITORY_INSTRUCTION_BYTES } from '@talyn/shared';
import { RepositoryInstructionsSection } from '../components/settings/RepositoryInstructionsSection';

const { mockList, mockGet, mockPut, mockRemove, mockToastError } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockRemove: vi.fn(),
  mockToastError: vi.fn(),
}));
vi.mock('../lib/api', () => ({
  api: {
    repositories: {
      instructions: {
        list: (...args: unknown[]) => mockList(...args),
        get: (...args: unknown[]) => mockGet(...args),
        put: (...args: unknown[]) => mockPut(...args),
        remove: (...args: unknown[]) => mockRemove(...args),
      },
    },
  },
}));
vi.mock('../stores/toast', () => ({
  toast: { success: vi.fn(), error: (...args: unknown[]) => mockToastError(...args), info: vi.fn() },
}));
const state = vi.hoisted(() => ({ repos: [] as Array<{ id: string; workspaceId: string; owner: string; repo: string; fullName: string }> }));
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ currentWorkspaceId: 'ws1', repositories: state.repos }),
}));

const summary = (over = {}) => ({
  repositoryId: 'r1',
  agents: 'both',
  bytes: 2048,
  updatedAt: '2026-10-29T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  state.repos = [
    { id: 'r1', workspaceId: 'ws1', owner: 'acme', repo: 'app', fullName: 'acme/app' },
    { id: 'r2', workspaceId: 'ws1', owner: 'acme', repo: 'api', fullName: 'acme/api' },
  ];
  mockList.mockResolvedValue([summary()]);
  mockGet.mockResolvedValue({ ...summary(), body: 'Use tabs.' });
  mockPut.mockImplementation(async (_id: string, input: { body: string; agents: string }) => ({
    ...summary({ bytes: input.body.length, agents: input.agents }),
    body: input.body,
  }));
  mockRemove.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const editButton = (name: string) => screen.getByRole('button', { name: `Edit instructions for ${name}` });
const textbox = () => screen.getByRole('textbox') as HTMLTextAreaElement;

describe('RepositoryInstructionsSection', () => {
  it('shows the helper text and marks the repositories that have instructions', async () => {
    render(<RepositoryInstructionsSection />);
    expect(
      screen.getByText('Added to every session on this repository, for the agents you choose. Not committed.'),
    ).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Set')).toBeTruthy());
    expect(screen.getAllByText('Set')).toHaveLength(1);
    expect(screen.getByText('2.0 KB · Claude and Codex')).toBeTruthy();
    expect(mockList).toHaveBeenCalledWith('ws1');
  });

  it('loads the text into a monospace editor with a count against the cap', async () => {
    render(<RepositoryInstructionsSection />);
    await waitFor(() => expect((editButton('acme/app') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(editButton('acme/app'));
    await waitFor(() => expect((textbox()).value).toBe('Use tabs.'));
    expect((textbox()).classList.contains('font-mono')).toBe(true);
    expect((screen.getByTestId('repository-instructions-count')).textContent).toContain('0.0 KB of 64 KB');
    expect(mockGet).toHaveBeenCalledWith('r1');
  });

  it('saves the text and the chosen agents, then marks the repository', async () => {
    render(<RepositoryInstructionsSection />);
    await waitFor(() => expect((editButton('acme/api') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(editButton('acme/api'));
    expect(mockGet).not.toHaveBeenCalled();
    fireEvent.change(textbox(), { target: { value: 'Run make test.' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('r2', { body: 'Run make test.', agents: 'codex' }));
    await waitFor(() => expect(screen.getAllByText('Set')).toHaveLength(2));
    expect(screen.queryByTestId('repository-instructions-editor')).toBeNull();
  });

  it('keeps Save off for an empty body and for a body over the cap', async () => {
    render(<RepositoryInstructionsSection />);
    await waitFor(() => expect((editButton('acme/api') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(editButton('acme/api'));
    const save = screen.getByRole('button', { name: 'Save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(textbox(), { target: { value: '€'.repeat(MAX_REPOSITORY_INSTRUCTION_BYTES / 3 + 1) } });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('repository-instructions-count')).classList.contains('text-destructive')).toBe(true);
    fireEvent.change(textbox(), { target: { value: 'ok' } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it('asks inline before it deletes, and Keep backs out', async () => {
    render(<RepositoryInstructionsSection />);
    await waitFor(() => expect((editButton('acme/app') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(editButton('acme/app'));
    await waitFor(() => expect((textbox()).value).toBe('Use tabs.'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(mockRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(screen.queryByText('Set')).toBeNull());
  });

  it('offers no Delete for a repository without instructions', async () => {
    render(<RepositoryInstructionsSection />);
    await waitFor(() => expect((editButton('acme/api') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(editButton('acme/api'));
    const editor = screen.getByTestId('repository-instructions-editor');
    expect(within(editor).queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('shows a refusal from the server and stays open', async () => {
    mockPut.mockRejectedValueOnce(new Error('Trim them below 64 KB.'));
    render(<RepositoryInstructionsSection />);
    await waitFor(() => expect((editButton('acme/api') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(editButton('acme/api'));
    fireEvent.change(textbox(), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Trim them below 64 KB.'));
    expect(screen.getByTestId('repository-instructions-editor')).toBeTruthy();
  });

  it('says so when there are no repositories', () => {
    state.repos = [];
    render(<RepositoryInstructionsSection />);
    expect(screen.getByText(/Add a repository first/)).toBeTruthy();
  });
});
