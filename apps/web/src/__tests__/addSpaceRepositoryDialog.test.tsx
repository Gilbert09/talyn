import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SpaceRepository } from '@talyn/shared';
import { AddSpaceRepositoryDialog } from '../components/spaces/SpaceDialogs';
import { useSpacesStore } from '../stores/spaces';
import { useWorkspaceStore } from '../stores/workspace';

vi.mock('../lib/supabase', () => ({
  isSupabaseConfigured: () => false,
  supabase: null,
}));

const mockAddRepository = vi.fn();
vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    spaces: { addRepository: (...args: unknown[]) => mockAddRepository(...args) },
    teams: {},
  },
}));

const watched = (fullName: string) => {
  const [owner, repo] = fullName.split('/');
  return { id: `id-${fullName}`, workspaceId: 'ws1', owner: owner!, repo: repo!, fullName };
};

const spaceRepo = (repoFullName: string): SpaceRepository => ({
  spaceId: 's1',
  repoFullName,
  githubRepoId: 1,
  createdAt: '2026-11-08T00:00:00Z',
});

const picker = () => screen.getByRole('button', { name: 'Repository' });
const submitButton = () => screen.getByRole('button', { name: 'Add repository' });

function openPicker() {
  fireEvent.click(picker());
  return screen.findByPlaceholderText('Find a repository, or type owner/name…');
}

beforeAll(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  // jsdom has no layout, so no scrollIntoView. The repository list (cmdk) calls it.
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  useWorkspaceStore.setState({
    repositories: [watched('acme/api'), watched('acme/web'), watched('Acme/Docs')],
  });
  useSpacesStore.setState({ repositories: { s1: [spaceRepo('acme/docs')] } });
});

afterEach(cleanup);

describe('AddSpaceRepositoryDialog', () => {
  it('uses the composer repository picker instead of a text field', () => {
    render(<AddSpaceRepositoryDialog spaceId="s1" onOpenChange={vi.fn()} />);
    expect(picker()).toHaveTextContent('Choose a repository');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('datalist')).toBeNull();
    expect(submitButton()).toBeDisabled();
  });

  it('lists watched repositories that the space does not have yet', async () => {
    render(<AddSpaceRepositoryDialog spaceId="s1" onOpenChange={vi.fn()} />);
    await openPicker();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['acme/api', 'acme/web']);
  });

  it('adds a picked repository to the space', async () => {
    mockAddRepository.mockResolvedValue(spaceRepo('acme/web'));
    const onOpenChange = vi.fn();
    const onAdded = vi.fn();
    render(<AddSpaceRepositoryDialog spaceId="s1" onOpenChange={onOpenChange} onAdded={onAdded} />);
    await openPicker();
    fireEvent.click(screen.getByRole('option', { name: 'acme/web' }));
    expect(picker()).toHaveTextContent('acme/web');

    fireEvent.click(submitButton());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mockAddRepository).toHaveBeenCalledWith('s1', 'acme/web');
    expect(onAdded).toHaveBeenCalledWith(spaceRepo('acme/web'));
    expect(useSpacesStore.getState().repositories.s1!.map((r) => r.repoFullName)).toEqual(['acme/docs', 'acme/web']);
  });

  it('adds a typed owner/name that is not in the list', async () => {
    mockAddRepository.mockResolvedValue(spaceRepo('other-org/tool.js'));
    render(<AddSpaceRepositoryDialog spaceId="s1" onOpenChange={vi.fn()} />);
    const search = await openPicker();
    fireEvent.change(search, { target: { value: '  other-org/tool.js ' } });
    fireEvent.click(screen.getByRole('option', { name: /^Use\s*other-org\/tool\.js$/ }));
    expect(picker()).toHaveTextContent('other-org/tool.js');

    fireEvent.click(submitButton());
    await waitFor(() => expect(mockAddRepository).toHaveBeenCalledWith('s1', 'other-org/tool.js'));
  });

  it.each([
    ['a bare owner', 'acme'],
    ['a trailing slash', 'acme/'],
    ['a leading slash', '/api'],
    ['a space in the name', 'acme/my repo'],
    ['three segments', 'acme/api/extra'],
    ['a URL', 'https://github.com/acme/api'],
    ['a listed repository', 'acme/api'],
    ['a listed repository in another case', 'ACME/WEB'],
  ])('offers no typed repository for %s', async (_case, text) => {
    render(<AddSpaceRepositoryDialog spaceId="s1" onOpenChange={vi.fn()} />);
    const search = await openPicker();
    fireEvent.change(search, { target: { value: text } });
    expect(screen.queryByRole('option', { name: /^Use / })).toBeNull();
  });

  it('tells you to type owner/name when nothing matches', async () => {
    render(<AddSpaceRepositoryDialog spaceId="s1" onOpenChange={vi.fn()} />);
    const search = await openPicker();
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(await screen.findByText('No watched repository matches. Type owner/name to add any repository.')).toBeInTheDocument();
  });

  it('shows the error and stays open when the add fails', async () => {
    mockAddRepository.mockRejectedValue(new Error('Your GitHub account cannot read acme/api, or it does not exist.'));
    const onOpenChange = vi.fn();
    render(<AddSpaceRepositoryDialog spaceId="s1" onOpenChange={onOpenChange} />);
    await openPicker();
    fireEvent.click(screen.getByRole('option', { name: 'acme/api' }));
    fireEvent.click(submitButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Your GitHub account cannot read acme/api');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('does not open from the composer "/" shortcut', async () => {
    render(<AddSpaceRepositoryDialog spaceId="s1" onOpenChange={vi.fn()} />);
    window.dispatchEvent(new Event('talyn:open-repository-picker'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByPlaceholderText('Find a repository, or type owner/name…')).toBeNull();
    expect(picker()).not.toHaveAttribute('data-attr', 'new-workbench-repo');
  });
});
