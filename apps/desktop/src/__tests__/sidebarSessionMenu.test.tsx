/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import { SidebarWorkbenchList } from '../renderer/components/layout/SidebarWorkbenchList';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { installNavigation, useNavigationStore } from '../renderer/stores/navigation';
import { usePullRequestStore } from '../renderer/stores/pullRequests';
import { toast } from '../renderer/stores/toast';

const archive = jest.fn();
const update = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: { workbenches: { archive: (...a: unknown[]) => archive(...a), update: (...a: unknown[]) => update(...a) } },
}));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

function wb(id: string, over: Partial<Workbench> = {}): Workbench {
  return {
    id,
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/app',
    name: id,
    branch: `branch-${id}`,
    baseBranch: 'main',
    runtime: 'sandbox',
    sandboxState: 'running',
    status: 'ready',
    pullRequestId: null,
    diffStat: null,
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  } as Workbench;
}

const lisbon = wb('lisbon');
const oslo = wb('oslo', { pullRequestId: 'pr1' });

function rightClick(name: RegExp) {
  fireEvent.contextMenu(screen.getByRole('button', { name }));
}

beforeAll(() => {
  installNavigation();
  const g = global as unknown as Record<string, unknown>;
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  g.DOMRect = class {
    constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
    static fromRect(r: { x?: number; y?: number; width?: number; height?: number } = {}) {
      return new (g.DOMRect as new (...a: (number | undefined)[]) => unknown)(r.x, r.y, r.width, r.height);
    }
    get left() { return this.x; }
    get top() { return this.y; }
    get right() { return this.x + this.width; }
    get bottom() { return this.y + this.height; }
  };
});

beforeEach(() => {
  archive.mockReset();
  update.mockReset();
  jest.mocked(toast.error).mockClear();
  useWorkbenchStore.getState().setWorkspace('ws1');
  useWorkbenchStore.getState().setWorkbenches('ws1', [lisbon, oslo]);
  useWorkbenchStore.setState({ listLoaded: true });
  usePullRequestStore.setState({
    rows: [{ id: 'pr1', number: 4, state: 'open', summary: { draft: false, url: 'https://github.com/acme/app/pull/4' } }] as never,
  });
  useNavigationStore.getState().navigate({ view: 'home' });
});

afterEach(() => cleanup());

describe('sidebar session context menu', () => {
  async function editTitle(value: string, key = 'Enter') {
    rightClick(/lisbon/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const input = await screen.findByRole('textbox', { name: 'Session title' });
    expect(input).toHaveAttribute('maxLength', '100');
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key });
  }

  it('saves a trimmed title from Rename', async () => {
    update.mockResolvedValue({ ...lisbon, title: 'New title' });
    render(<SidebarWorkbenchList workbenches={[lisbon, oslo]} />);
    await editTitle('  New title  ');
    await waitFor(() => expect(update).toHaveBeenCalledWith('lisbon', { title: 'New title' }));
    expect(useWorkbenchStore.getState().workbenches.lisbon.title).toBe('New title');
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
  });

  it('cancels on Escape and ignores an empty title', async () => {
    render(<SidebarWorkbenchList workbenches={[lisbon, oslo]} />);
    await editTitle('Other title', 'Escape');
    expect(update).not.toHaveBeenCalled();
    await editTitle('   ');
    await editTitle('lisbon');
    expect(update).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState().workbenches.lisbon.title).toBeUndefined();
  });

  it('restores the old title and shows an error after a failed save', async () => {
    update.mockRejectedValue(new Error('offline'));
    render(<SidebarWorkbenchList workbenches={[lisbon, oslo]} />);
    await editTitle('Other title');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not rename the session', 'offline'));
    expect(useWorkbenchStore.getState().workbenches.lisbon.title).toBeUndefined();
  });

  it('archives a session after confirming, and stays on the current route', async () => {
    archive.mockResolvedValue({ ...lisbon, status: 'archived', archivedAt: '2026-10-14T00:00:00Z' });
    render(<SidebarWorkbenchList workbenches={[lisbon, oslo]} />);

    rightClick(/lisbon/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive…' }));
    expect(archive).not.toHaveBeenCalled();
    expect(await screen.findByText('Archive lisbon?')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Archive' }).pop()!);
    await waitFor(() => expect(archive).toHaveBeenCalledWith('lisbon'));
    await waitFor(() =>
      expect(useWorkbenchStore.getState().workbenches['lisbon']?.status).toBe('archived')
    );
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
  });

  it('leaves the open session when it is archived', async () => {
    archive.mockResolvedValue({ ...lisbon, status: 'archived', archivedAt: '2026-10-14T00:00:00Z' });
    useNavigationStore.getState().navigate({ view: 'workbench', id: 'lisbon' });
    render(<SidebarWorkbenchList workbenches={[lisbon, oslo]} />);

    rightClick(/lisbon/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive…' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Archive' }).pop()!);
    await waitFor(() => expect(archive).toHaveBeenCalledWith('lisbon'));
    await waitFor(() => expect(useNavigationStore.getState().route.view).not.toBe('workbench'));
  });

  it('does not archive when the dialog is cancelled', async () => {
    render(<SidebarWorkbenchList workbenches={[lisbon, oslo]} />);
    rightClick(/lisbon/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(archive).not.toHaveBeenCalled();
  });

  it('offers Open pull request only for a session with a PR', async () => {
    render(<SidebarWorkbenchList workbenches={[lisbon, oslo]} />);
    rightClick(/lisbon/);
    await screen.findByRole('menuitem', { name: 'Open' });
    expect(screen.queryByRole('menuitem', { name: 'Open pull request' })).not.toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Open' })).not.toBeInTheDocument());

    rightClick(/oslo/);
    expect(await screen.findByRole('menuitem', { name: 'Open pull request' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy branch name' })).toBeInTheDocument();
  });

  it('Copy session ID copies the session id', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<SidebarWorkbenchList workbenches={[lisbon, oslo]} />);
    rightClick(/oslo/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy session ID' }));
    expect(writeText).toHaveBeenCalledWith('oslo');
  });

  it('Open navigates to the session', async () => {
    render(<SidebarWorkbenchList workbenches={[lisbon, oslo]} />);
    rightClick(/oslo/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open' }));
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'oslo' });
  });
});
