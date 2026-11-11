import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Features, SpaceSessionRow, SpacesTeam, Workbench, WorkbenchChat } from '@talyn/shared';
import { api } from '../lib/api';
import { CommandPalette } from '../components/CommandPalette';
import { buildAppShortcuts, orderedLiveWorkbenches, orderedSidebarSessionIds } from '../components/layout/appShortcuts';
import { FOCUS_COMPOSER_EVENT, clearShortcuts, dispatchKeydown, formatKeys, registerShortcuts } from '../lib/shortcuts';
import { useWorkspaceStore } from '../stores/workspace';
import { useWorkbenchStore } from '../stores/workbenches';
import { useNavigationStore } from '../stores/navigation';
import { useSpacesStore } from '../stores/spaces';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../lib/api', () => ({ api: { workbenches: { list: vi.fn(), restore: vi.fn(), get: vi.fn() }, pullRequests: {} } }));

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
    expect(screen.getByText('Integrations: GitHub')).toBeInTheDocument();
    expect(screen.queryByText('Integrations: Schedule')).not.toBeInTheDocument();
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
  expect(shortcuts.find((s) => s.id === 'context.jump.1')?.keys).toBe('mod+shift+1');
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
    ['n', { view: 'integrations' }],
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

  it.each([['y', 'sessions are off', {}]])('G then %s does nothing when %s', (letter, _label, features) => {
    useWorkspaceStore.setState({ features: features as Features });
    expect(go(letter)).toBe(false);
    expect(route()).toEqual({ view: 'home' });
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

describe('session arrows', () => {
  const opts = { menuOwnsChords: false, mac: true };
  let composer: HTMLTextAreaElement;
  const route = () => useNavigationStore.getState().route;

  beforeEach(() => {
    useNavigationStore.setState({ paletteOpen: false });
    composer = document.createElement('textarea');
    composer.setAttribute('data-session-composer', '');
    document.body.appendChild(composer);
  });

  afterEach(() => {
    composer.remove();
    document.querySelectorAll('[role="menu"]').forEach((el) => el.remove());
  });

  function press(key: 'ArrowUp' | 'ArrowDown', target: EventTarget = document.body, init: KeyboardEventInit = {}): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, metaKey: true, ...init });
    Object.defineProperty(e, 'target', { value: target });
    act(() => {
      dispatchKeydown(e, opts);
    });
    return e;
  }

  const ids = () => orderedLiveWorkbenches().map((w) => w.id);

  it('lists ⌘↑ and ⌘↓ and keeps ⌘⌥↑ and ⌘⌥↓ as hidden aliases', () => {
    const shortcuts = buildAppShortcuts();
    expect(shortcuts.filter((s) => s.id.startsWith('workbench.previous') || s.id.startsWith('workbench.next')).map((s) => [s.id, s.keys, s.hidden, s.alias])).toEqual([
      ['workbench.previous', 'mod+up', undefined, undefined],
      ['workbench.next', 'mod+down', undefined, undefined],
      ['workbench.previous.alt', 'mod+alt+up', true, true],
      ['workbench.next.alt', 'mod+alt+down', true, true],
    ]);
  });

  it.each([
    ['ArrowDown', {}, 0],
    ['ArrowUp', {}, -1],
    ['ArrowDown', { altKey: true }, 0],
    ['ArrowUp', { altKey: true }, -1],
  ] as const)('outside a session, %s %p opens the session at %i', (key, init, index) => {
    const e = press(key, document.body, init);
    expect(e.defaultPrevented).toBe(true);
    expect(route()).toEqual({ view: 'workbench', id: ids().at(index) });
  });

  it.each([
    ['ArrowDown', {}, 1],
    ['ArrowUp', {}, -1],
    ['ArrowDown', { altKey: true }, 1],
    ['ArrowUp', { altKey: true }, -1],
  ] as const)('in the first session, %s %p wraps to the session at %i', (key, init, index) => {
    act(() => useNavigationStore.getState().navigate({ view: 'workbench', id: ids()[0] }));
    press(key, document.body, init);
    expect(route()).toEqual({ view: 'workbench', id: ids().at(index) });
  });

  it.each(['ArrowDown', 'ArrowUp'] as const)('%s steps from an empty composer', (key) => {
    act(() => useNavigationStore.getState().navigate({ view: 'workbench', id: ids()[0] }));
    const e = press(key, composer);
    expect(e.defaultPrevented).toBe(true);
    expect(route()).not.toEqual({ view: 'workbench', id: ids()[0] });
  });

  it.each(['ArrowDown', 'ArrowUp'] as const)('%s moves the caret in a composer with text', (key) => {
    act(() => useNavigationStore.getState().navigate({ view: 'workbench', id: ids()[0] }));
    composer.value = 'line one\nline two';
    const e = press(key, composer);
    expect(e.defaultPrevented).toBe(false);
    expect(route()).toEqual({ view: 'workbench', id: ids()[0] });
  });

  it.each(['ArrowDown', 'ArrowUp'] as const)('⌥%s still steps from a composer with text', (key) => {
    act(() => useNavigationStore.getState().navigate({ view: 'workbench', id: ids()[0] }));
    composer.value = 'draft';
    const e = press(key, composer, { altKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(route()).not.toEqual({ view: 'workbench', id: ids()[0] });
  });

  it.each([
    ['an input', () => document.createElement('input')],
    ['a plain textarea', () => document.createElement('textarea')],
  ])('⌘↓ is left alone in %s', (_, make) => {
    const field = make();
    document.body.appendChild(field);
    const e = press('ArrowDown', field);
    expect(e.defaultPrevented).toBe(false);
    expect(route()).toEqual({ view: 'home' });
    field.remove();
  });

  it('⌘↓ is left alone while focus is in a menu', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const item = document.createElement('button');
    menu.appendChild(item);
    document.body.appendChild(menu);
    item.focus();
    const e = press('ArrowDown', item);
    expect(e.defaultPrevented).toBe(false);
    expect(route()).toEqual({ view: 'home' });
  });

  it('does nothing when sessions are off', () => {
    useWorkspaceStore.setState({ features: { workbenches: false } as Features });
    const e = press('ArrowDown');
    expect(e.defaultPrevented).toBe(false);
    expect(route()).toEqual({ view: 'home' });
  });
});

describe('session arrows in a space', () => {
  const opts = { menuOwnsChords: false, mac: true };
  const route = () => useNavigationStore.getState().route;
  const space = (id: string, name: string) => ({ id, teamId: 't1', name, color: null, image: null, createdByUserId: null, archivedAt: null, createdAt: '', updatedAt: '' });
  const TEAM: SpacesTeam = { id: 't1', name: 'Acme', role: 'admin', homeWorkspaceId: 'ws1', createdAt: '', spaces: [space('s1', 'Web')] };

  function row(id: string, over: Partial<SpaceSessionRow> = {}): SpaceSessionRow {
    return {
      id,
      spaceId: 's1',
      workspaceId: 'ws1',
      kind: 'session',
      threadId: null,
      name: id,
      title: null,
      status: 'ready',
      sandboxState: 'running',
      running: false,
      repoFullName: 'acme/app',
      branch: `feat/${id}`,
      baseBranch: 'main',
      agent: 'claude',
      model: null,
      pullRequest: null,
      creator: { userId: 'me', githubLogin: 'me', avatarUrl: null },
      lastActivityAt: null,
      archivedAt: null,
      createdAt: '2026-10-13T00:00:00Z',
      updatedAt: '2026-10-13T00:00:00Z',
      ...over,
    };
  }

  function setSpaceSessions(items: SpaceSessionRow[], loaded = true): void {
    useSpacesStore.setState({ sessions: { s1: { items, hiddenCount: 0, loaded, error: null } } });
  }

  function press(key: 'ArrowUp' | 'ArrowDown'): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, metaKey: true });
    Object.defineProperty(e, 'target', { value: document.body });
    act(() => {
      dispatchKeydown(e, opts);
    });
    return e;
  }

  beforeEach(() => {
    useNavigationStore.setState({ paletteOpen: false });
    vi.mocked(api.workbenches.get).mockReset().mockResolvedValue(wb('mate', { workspaceId: 'ws2', spaceId: 's1' }));
    useWorkspaceStore.setState({
      features: { workbenches: true, spaces: true } as Features,
      currentContext: { kind: 'space', spaceId: 's1' },
    });
    useWorkbenchStore.getState().removeWorkbench('mate');
    useWorkbenchStore.getState().setWorkbenches('ws1', [wb('lisbon', { spaceId: 's1' }), wb('oslo', { spaceId: 's1' }), wb('rome')]);
    useSpacesStore.setState({ teams: [TEAM], presence: {}, selfUserId: 'me' });
    // Sidebar order: "Active now" (oslo runs a turn), then "Recent" by last activity.
    setSpaceSessions([
      row('mate', { workspaceId: 'ws2', lastActivityAt: '2026-10-13T01:00:00Z', creator: { userId: 'u2', githubLogin: 'mate', avatarUrl: null } }),
      row('lisbon', { lastActivityAt: '2026-10-13T03:00:00Z' }),
      row('oslo', { running: true, lastActivityAt: '2026-10-13T00:30:00Z' }),
      row('old', { archivedAt: '2026-10-13T04:00:00Z', lastActivityAt: '2026-10-13T04:00:00Z' }),
    ]);
  });

  afterEach(() => {
    useWorkspaceStore.setState({ currentContext: { kind: 'personal', workspaceId: 'ws1' } });
    useSpacesStore.setState({ teams: null, sessions: {}, presence: {}, extraLoads: {} });
  });

  it('follows the space sidebar order, not the personal list', () => {
    expect(orderedSidebarSessionIds()).toEqual(['oslo', 'lisbon', 'mate']);
    expect(orderedLiveWorkbenches().map((w) => w.id)).toEqual(['rome']);
  });

  it.each<[string, 'active_first' | 'repository', Record<string, true>, boolean, string[]]>([
    ['active first', 'active_first', {}, false, ['oslo', 'lisbon', 'mate']],
    ['by repository', 'repository', {}, false, ['lisbon', 'mate', 'oslo']],
    ['active first, a teammate has mate open', 'active_first', {}, true, ['mate', 'oslo', 'lisbon']],
    ['by repository, a teammate has mate open', 'repository', {}, true, ['lisbon', 'mate', 'oslo']],
    ["the space's active group collapsed", 'active_first', { 'space:s1:active': true }, false, ['lisbon', 'mate']],
    ["Personal's active group collapsed", 'active_first', { active: true }, false, ['oslo', 'lisbon', 'mate']],
  ])('counts the space sidebar order: %s', (_name, sidebarOrder, collapsedSessionGroups, watched, ids) => {
    useWorkspaceStore.setState({ sidebarOrder, collapsedSessionGroups });
    if (watched) {
      useSpacesStore.setState({
        presence: { s1: [{ userId: 'u3', githubLogin: 'ben', avatarUrl: null, sessionId: 'mate', state: 'active', at: 0 }] },
      });
    }
    try {
      expect(orderedSidebarSessionIds()).toEqual(ids);
    } finally {
      useWorkspaceStore.setState({ sidebarOrder: 'active_first', collapsedSessionGroups: {} });
    }
  });

  it.each([
    ['home', 'ArrowDown', 'oslo'],
    ['home', 'ArrowUp', 'mate'],
    ['oslo', 'ArrowDown', 'lisbon'],
    ['lisbon', 'ArrowUp', 'oslo'],
    ['lisbon', 'ArrowDown', 'mate'],
    ['mate', 'ArrowDown', 'oslo'],
    ['oslo', 'ArrowUp', 'mate'],
    ['rome', 'ArrowDown', 'oslo'],
    ['rome', 'ArrowUp', 'mate'],
  ] as const)('from %s, ⌘%s opens %s', async (from, key, to) => {
    if (from !== 'home') act(() => useNavigationStore.getState().navigate({ view: 'workbench', id: from }));
    const e = press(key);
    expect(e.defaultPrevented).toBe(true);
    await waitFor(() => expect(route()).toEqual({ view: 'workbench', id: to }));
  });

  it("fetches a teammate's session before it opens it", async () => {
    act(() => useNavigationStore.getState().navigate({ view: 'workbench', id: 'lisbon' }));
    press('ArrowDown');
    await waitFor(() => expect(route()).toEqual({ view: 'workbench', id: 'mate' }));
    expect(api.workbenches.get).toHaveBeenCalledWith('mate');
    expect(useWorkbenchStore.getState().extraWorkbenchIds.mate).toBe(true);
  });

  it('does not fetch a session that is already loaded', async () => {
    act(() => useNavigationStore.getState().navigate({ view: 'workbench', id: 'oslo' }));
    press('ArrowDown');
    await waitFor(() => expect(route()).toEqual({ view: 'workbench', id: 'lisbon' }));
    expect(api.workbenches.get).not.toHaveBeenCalled();
  });

  it.each([
    [1, 'oslo'],
    [2, 'lisbon'],
    [3, 'mate'],
  ] as const)('⌘⌥%i opens the space session at that place', async (n, to) => {
    const jump = buildAppShortcuts().find((s) => s.id === `workbench.jump.${n}`);
    expect(jump?.when?.()).toBe(true);
    act(() => jump?.run());
    await waitFor(() => expect(route()).toEqual({ view: 'workbench', id: to }));
  });

  it('⌘⌥4 is off with three space sessions', () => {
    expect(buildAppShortcuts().find((s) => s.id === 'workbench.jump.4')?.when?.()).toBe(false);
  });

  it.each([
    ['not loaded yet', [row('oslo')], false],
    ['empty', [], true],
    ['all archived', [row('old', { archivedAt: '2026-10-13T04:00:00Z' })], true],
  ] as const)('does nothing while the space list is %s', (_, items, loaded) => {
    setSpaceSessions([...items], loaded);
    const e = press('ArrowDown');
    expect(e.defaultPrevented).toBe(false);
    expect(route()).toEqual({ view: 'home' });
  });

  it('uses the personal list again after a switch to Personal', () => {
    act(() => useWorkspaceStore.setState({ currentContext: { kind: 'personal', workspaceId: 'ws1' } }));
    expect(orderedSidebarSessionIds()).toEqual(['rome']);
    press('ArrowDown');
    expect(route()).toEqual({ view: 'workbench', id: 'rome' });
  });
});
