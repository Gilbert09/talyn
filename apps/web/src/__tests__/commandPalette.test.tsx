import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Features, Workbench, WorkbenchChat } from '@talyn/shared';
import { api } from '../lib/api';
import { CommandPalette } from '../components/CommandPalette';
import { buildAppShortcuts } from '../components/layout/appShortcuts';
import { FOCUS_COMPOSER_EVENT, clearShortcuts, dispatchKeydown, formatKeys, registerShortcuts } from '../lib/shortcuts';
import { useWorkspaceStore } from '../stores/workspace';
import { useWorkbenchStore } from '../stores/workbenches';
import { useNavigationStore } from '../stores/navigation';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../lib/api', () => ({ api: { workbenches: { list: vi.fn(), restore: vi.fn() }, pullRequests: {} } }));

function wb(id: string, over: Partial<Workbench> = {}): Workbench {
  return {
    id,
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/app',
    name: id,
    branch: `feat/${id}`,
    baseBranch: 'main',
    runtime: 'sandbox',
    agent: 'claude',
    deviceId: null,
    localPath: null,
    sandboxId: null,
    sandboxState: 'running',
    status: 'ready',
    pullRequestId: null,
    settings: {},
    diffStat: null,
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  } as Workbench;
}

beforeAll(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});

let unregister: () => void = () => {};

beforeEach(() => {
  vi.mocked(api.workbenches.list).mockReset().mockResolvedValue([]);
  vi.mocked(api.workbenches.restore).mockReset();
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws1',
    features: { workbenches: true, workflows: true } as Features,
  });
  useWorkbenchStore.getState().setWorkspace('ws1');
  useWorkbenchStore
    .getState()
    .setWorkbenches('ws1', [
      wb('lisbon', { repoFullName: 'acme/web' }),
      wb('oslo', { repoFullName: 'acme/api' }),
      wb('gone', { status: 'archived', archivedAt: '2026-10-13T01:00:00Z' }),
    ]);
  useWorkbenchStore.setState({ chats: {}, unread: {} });
  useNavigationStore.getState().navigate({ view: 'home' });
  useNavigationStore.setState({ paletteOpen: true });
  unregister = registerShortcuts(buildAppShortcuts());
});

afterEach(() => {
  cleanup();
  unregister();
  clearShortcuts();
});

describe('CommandPalette', () => {
  it('renders nothing while closed', () => {
    useNavigationStore.setState({ paletteOpen: false });
    render(<CommandPalette />);
    expect(screen.queryByPlaceholderText(/Search sessions/)).not.toBeInTheDocument();
    expect(vi.mocked(api.workbenches.list)).not.toHaveBeenCalled();
  });

  it('lists live workbenches, with their repository, and leaves archived ones out', () => {
    render(<CommandPalette />);
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('lisbon')).toBeInTheDocument();
    expect(screen.getByText('oslo')).toBeInTheDocument();
    expect(screen.getByText('acme/web')).toBeInTheDocument();
    expect(screen.queryByText('gone')).not.toBeInTheDocument();
  });

  it.each([
    ['running', 'Working', 'text-warning'],
    ['error', 'Failed to start', 'text-destructive'],
    ['pr open', '#12 open, waiting on checks or review', 'text-success'],
  ])('shows the sidebar state icon for a %s session', (kind, label, color) => {
    if (kind === 'running') {
      useWorkbenchStore.getState().setChats('lisbon', [{ id: 'chat-1', status: 'running' } as WorkbenchChat]);
    } else if (kind === 'error') {
      useWorkbenchStore.getState().setWorkbenches('ws1', [wb('lisbon', { status: 'error' })]);
    } else {
      useWorkbenchStore.getState().setWorkbenches('ws1', [wb('lisbon', {
        pr: { number: 12, url: 'https://example.com/pr/12', state: 'open', mergeable: 'unknown', ciStatus: 'pending' },
      })]);
    }

    render(<CommandPalette />);
    expect(screen.getByLabelText(label)).toHaveClass(color);
  });

  it('orders sessions by latest update before search filtering and keeps ties in order', () => {
    useWorkbenchStore.getState().setWorkbenches('ws1', [
      wb('older', { repoFullName: 'acme/z', updatedAt: '2026-10-13T01:00:00Z' }),
      wb('same-a', { repoFullName: 'acme/a', createdAt: '2026-10-13T01:00:00Z', updatedAt: '2026-10-13T03:00:00Z' }),
      wb('latest', { repoFullName: 'acme/z', updatedAt: '2026-10-13T04:00:00Z' }),
      wb('same-b', { repoFullName: 'acme/a', createdAt: '2026-10-13T02:00:00Z', updatedAt: '2026-10-13T03:00:00Z' }),
    ]);
    render(<CommandPalette />);
    fireEvent.change(screen.getByPlaceholderText(/Search sessions/), { target: { value: 'feat/' } });
    expect(screen.getAllByText(/^(latest|same-a|same-b|older)$/).map((item) => item.textContent)).toEqual([
      'latest', 'same-a', 'same-b', 'older',
    ]);
  });

  it('loads archived sessions once on open and filters name, branch, and repository', async () => {
    const archived = [
      wb('named', { name: 'Hidden report', status: 'archived', archivedAt: '2026-10-13T01:00:00Z' }),
      wb('branch', { branch: 'fix/hidden', status: 'archived', archivedAt: '2026-10-13T02:00:00Z' }),
      wb('repo', { repoFullName: 'hidden/service', status: 'archived', archivedAt: '2026-10-13T03:00:00Z' }),
      wb('other', { status: 'archived', archivedAt: '2026-10-13T04:00:00Z' }),
    ];
    vi.mocked(api.workbenches.list).mockResolvedValue(archived);
    render(<CommandPalette />);
    expect(vi.mocked(api.workbenches.list)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.workbenches.list)).toHaveBeenCalledWith('ws1', { includeArchived: true });
    const input = screen.getByPlaceholderText(/Search sessions/);
    for (const term of ['report', 'fix/hidden', 'hidden/service']) {
      fireEvent.change(input, { target: { value: term } });
      const group = await screen.findByText('Archived');
      expect(within(group.closest('[cmdk-group]') as HTMLElement).getAllByRole('option')).toHaveLength(1);
    }
    expect(vi.mocked(api.workbenches.list)).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('other')).not.toBeInTheDocument();
  });

  it('limits archived results to eight', async () => {
    vi.mocked(api.workbenches.list).mockResolvedValue(Array.from({ length: 10 }, (_, index) =>
      wb(`past-${index}`, { status: 'archived', archivedAt: `2026-10-13T${String(index).padStart(2, '0')}:00:00Z` })
    ));
    render(<CommandPalette />);
    fireEvent.change(screen.getByPlaceholderText(/Search sessions/), { target: { value: 'past-' } });
    const group = await screen.findByText('Archived');
    expect(within(group.closest('[cmdk-group]') as HTMLElement).getAllByRole('option')).toHaveLength(8);
  });

  it('opens an archived session without restoring it', async () => {
    vi.mocked(api.workbenches.list).mockResolvedValue([
      wb('past', { name: 'Past work', status: 'archived', archivedAt: '2026-10-13T01:00:00Z' }),
    ]);
    render(<CommandPalette />);
    fireEvent.change(screen.getByPlaceholderText(/Search sessions/), { target: { value: 'Past work' } });
    fireEvent.click(await screen.findByText('Past work'));
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'past' });
    expect(useNavigationStore.getState().paletteOpen).toBe(false);
    expect(useWorkbenchStore.getState().workbenches.past).toBeDefined();
    expect(vi.mocked(api.workbenches.restore)).not.toHaveBeenCalled();
  });

  it('shows no archived results when the load fails', async () => {
    vi.mocked(api.workbenches.list).mockRejectedValue(new Error('offline'));
    render(<CommandPalette />);
    fireEvent.change(screen.getByPlaceholderText(/Search sessions/), { target: { value: 'gone' } });
    await waitFor(() => expect(vi.mocked(api.workbenches.list)).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Archived')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search sessions/)).toBeInTheDocument();
  });

  it('picking a workbench opens it and closes the palette', () => {
    render(<CommandPalette />);
    fireEvent.click(screen.getByText('oslo'));
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'oslo' });
    expect(useNavigationStore.getState().paletteOpen).toBe(false);
  });

  it('filters by branch', () => {
    render(<CommandPalette />);
    fireEvent.change(screen.getByPlaceholderText(/Search sessions/), { target: { value: 'feat/lisbon' } });
    expect(screen.getByText('lisbon')).toBeInTheDocument();
    expect(screen.queryByText('oslo')).not.toBeInTheDocument();
  });

  it('lists the places to go, gated like the sidebar', () => {
    render(<CommandPalette />);
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('Pull requests: PRs')).toBeInTheDocument();
    expect(screen.getByText('Review requests')).toBeInTheDocument();
    expect(screen.getByText('Merge queue')).toBeInTheDocument();
    expect(screen.getByText('Pull requests: Code review')).toBeInTheDocument();
    expect(screen.getByText('Automations: Workflows')).toBeInTheDocument();
    expect(screen.queryByText('Automations: Loops')).not.toBeInTheDocument();
    expect(screen.getByText('Settings: Billing')).toBeInTheDocument();
  });

  it('opens the new page in thread mode', () => {
    render(<CommandPalette />);
    fireEvent.click(screen.getByText('New thread'));
    expect(useNavigationStore.getState().route).toEqual({ view: 'home', mode: 'thread' });
  });

  it('a Navigate pick goes there', () => {
    render(<CommandPalette />);
    fireEvent.click(screen.getByText('Settings: Billing'));
    expect(useNavigationStore.getState().route).toEqual({ view: 'settings', section: 'billing' });
  });

  it('lists the actions that apply now, with their keys', () => {
    render(<CommandPalette />);
    expect(screen.getByText('Toggle Sidebar')).toBeInTheDocument();
    expect(screen.getByText(formatKeys('mod+b'))).toBeInTheDocument();
    expect(screen.getByText('Next Session')).toBeInTheDocument();
    // Workbench-only actions do not apply on the home page.
    expect(screen.queryByText('Create Pull Request')).not.toBeInTheDocument();
    expect(screen.queryByText('Focus Composer')).not.toBeInTheDocument();
    // Hidden entries stay out of the list.
    expect(screen.queryByText('Open session 1')).not.toBeInTheDocument();
  });

  it('lists the workbench actions inside a workbench', () => {
    act(() => useNavigationStore.getState().navigate({ view: 'workbench', id: 'oslo' }));
    useNavigationStore.setState({ paletteOpen: true });
    render(<CommandPalette />);
    expect(screen.getByText('Create Pull Request')).toBeInTheDocument();
    expect(screen.getByText(formatKeys('mod+alt+p'))).toBeInTheDocument();
    expect(screen.getByText('Toggle Terminal')).toBeInTheDocument();
  });

  it('running an action closes the palette first', () => {
    useWorkspaceStore.setState({ sidebarCollapsed: false });
    render(<CommandPalette />);
    fireEvent.click(screen.getByText('Toggle Sidebar'));
    expect(useNavigationStore.getState().paletteOpen).toBe(false);
    expect(useWorkspaceStore.getState().sidebarCollapsed).toBe(true);
  });
});

it.each([null, { workbenches: false }])('hides sessions and their actions when features are %p', (features) => {
  useWorkspaceStore.setState({ features: features as Features | null });
  useNavigationStore.getState().navigate({ view: 'workbench', id: 'oslo' });
  render(<CommandPalette />);
  expect(screen.queryByText('oslo')).not.toBeInTheDocument();
  expect(screen.queryByText('History')).not.toBeInTheDocument();
  expect(screen.queryByText('Settings: Sessions')).not.toBeInTheDocument();
  expect(screen.queryByText('Next Session')).not.toBeInTheDocument();
  expect(screen.queryByText('Create Pull Request')).not.toBeInTheDocument();
});

it('shows arrow navigation and keeps bracket aliases hidden', () => {
  const shortcuts = buildAppShortcuts();
  expect(shortcuts.find((s) => s.id === 'workbench.new')?.keys).toBe('mod+shift+o');
  expect(shortcuts.find((s) => s.id === 'workbench.jump.1')?.keys).toBe('mod+alt+1');
  expect(shortcuts.filter((s) => s.id.startsWith('nav.')).map((s) => [s.id, s.keys, s.hidden, s.menu])).toEqual([
    ['nav.back', 'mod+left', undefined, true],
    ['nav.forward', 'mod+right', undefined, true],
    ['nav.back.bracket', 'mod+[', true, undefined],
    ['nav.forward.bracket', 'mod+]', true, undefined],
  ]);
});

describe('go-to shortcuts', () => {
  const opts = { menuOwnsChords: false, mac: true };
  let clock = 0;
  const route = () => useNavigationStore.getState().route;

  function press(key: string, init: KeyboardEventInit = {}): boolean {
    clock += 100;
    const e = new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true, ...init });
    let ran = false;
    act(() => {
      ran = dispatchKeydown(e, { ...opts, now: clock });
    });
    return ran;
  }
  const go = (letter: string) => {
    press('g');
    return press(letter);
  };

  beforeEach(() => {
    useNavigationStore.setState({ paletteOpen: false });
  });

  it.each([
    ['p', { view: 'prs', tab: 'my_prs' }],
    ['r', { view: 'prs', tab: 'reviews' }],
    ['c', { view: 'prs', tab: 'code_reviews' }],
    ['m', { view: 'prs', tab: 'merge_queue' }],
    ['t', { view: 'prs', tab: 'queue' }],
    ['a', { view: 'automations', tab: 'workflows' }],
    ['i', { view: 'insights' }],
    ['y', { view: 'history' }],
  ])('G then %s opens %p', (letter, expected) => {
    expect(go(letter)).toBe(true);
    expect(route()).toEqual(expected);
  });

  it('G then H opens Home', () => {
    act(() => useNavigationStore.getState().navigate({ view: 'insights' }));
    expect(go('h')).toBe(true);
    expect(route()).toEqual({ view: 'home' });
  });

  it('G then S opens Settings', () => {
    expect(go('s')).toBe(true);
    expect(route().view).toBe('settings');
  });

  it('? opens Settings → Shortcuts', () => {
    expect(press('?', { code: 'Slash', shiftKey: true })).toBe(true);
    expect(route()).toEqual({ view: 'settings', section: 'shortcuts' });
  });

  it.each([
    ['l', 'Loops is off', { workbenches: true, workflows: true }],
    ['a', 'no automation is offered', { workbenches: true }],
    ['y', 'sessions are off', {}],
  ])('G then %s does nothing when %s', (letter, _label, features) => {
    useWorkspaceStore.setState({ features: features as Features });
    expect(go(letter)).toBe(false);
    expect(route()).toEqual({ view: 'home' });
  });

  it('G then L opens Loops when Loops is on', () => {
    useWorkspaceStore.setState({ features: { workbenches: true, loops: true } as Features });
    expect(go('l')).toBe(true);
    expect(route()).toEqual({ view: 'automations', tab: 'loops' });
  });

  it('G then A opens the first automation offered', () => {
    useWorkspaceStore.setState({ features: { workbenches: true, loops: true } as Features });
    expect(go('a')).toBe(true);
    expect(route()).toEqual({ view: 'automations', tab: 'loops' });
  });

  it('the palette shows the keys on its Navigate rows', () => {
    useNavigationStore.setState({ paletteOpen: true });
    render(<CommandPalette />);
    const prs = screen.getByText('Pull requests: PRs').closest('[cmdk-item]') as HTMLElement;
    expect(within(prs).getByText('G then P')).toBeInTheDocument();
    const reviews = screen.getByText('Review requests').closest('[cmdk-item]') as HTMLElement;
    expect(within(reviews).getByText('G then R')).toBeInTheDocument();
    // The go-to entries are not repeated as Actions.
    expect(screen.queryByText('Go to Pull requests')).not.toBeInTheDocument();
  });
});

describe('Tab focuses the chat input', () => {
  const opts = { menuOwnsChords: false, mac: true };
  let composer: HTMLTextAreaElement;
  const onFocus = vi.fn();

  beforeEach(() => {
    useNavigationStore.setState({ paletteOpen: false });
    composer = document.createElement('textarea');
    composer.setAttribute('data-session-composer', '');
    document.body.appendChild(composer);
    onFocus.mockReset();
    window.addEventListener(FOCUS_COMPOSER_EVENT, onFocus);
  });

  afterEach(() => {
    window.removeEventListener(FOCUS_COMPOSER_EVENT, onFocus);
    composer.remove();
  });

  function tab(init: KeyboardEventInit = {}): KeyboardEvent {
    return new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true, ...init });
  }

  it('in a session, asks the composer for focus', () => {
    act(() => useNavigationStore.getState().navigate({ view: 'workbench', id: 'oslo' }));
    const e = tab();
    expect(dispatchKeydown(e, opts)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it('outside a session, Tab is left alone', () => {
    const e = tab();
    expect(dispatchKeydown(e, opts)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('Shift+Tab is left alone', () => {
    act(() => useNavigationStore.getState().navigate({ view: 'workbench', id: 'oslo' }));
    const e = tab({ shiftKey: true });
    expect(dispatchKeydown(e, opts)).toBe(false);
    expect(onFocus).not.toHaveBeenCalled();
  });
});
