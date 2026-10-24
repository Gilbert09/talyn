import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Features, Workbench } from '@talyn/shared';
import { CommandPalette } from '../components/CommandPalette';
import { buildAppShortcuts } from '../components/layout/appShortcuts';
import { clearShortcuts, formatKeys, registerShortcuts } from '../lib/shortcuts';
import { useWorkspaceStore } from '../stores/workspace';
import { useWorkbenchStore } from '../stores/workbenches';
import { useNavigationStore } from '../stores/navigation';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../lib/api', () => ({ api: { workbenches: {}, pullRequests: {} } }));

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
  });

  it('lists live workbenches, with their repository, and leaves archived ones out', () => {
    render(<CommandPalette />);
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('lisbon')).toBeInTheDocument();
    expect(screen.getByText('oslo')).toBeInTheDocument();
    expect(screen.getByText('acme/web')).toBeInTheDocument();
    expect(screen.queryByText('gone')).not.toBeInTheDocument();
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
    expect(screen.queryByText('Pull requests: Code review')).not.toBeInTheDocument();
    expect(screen.getByText('Automations: Workflows')).toBeInTheDocument();
    expect(screen.queryByText('Automations: Loops')).not.toBeInTheDocument();
    expect(screen.getByText('Settings: Billing')).toBeInTheDocument();
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

it('uses browser shortcuts without app history commands', () => {
  const shortcuts = buildAppShortcuts();
  expect(shortcuts.find((s) => s.id === 'workbench.new')?.keys).toBe('mod+shift+o');
  expect(shortcuts.find((s) => s.id === 'workbench.jump.1')?.keys).toBe('mod+alt+1');
  expect(shortcuts.some((s) => s.id === 'nav.back' || s.id === 'nav.forward')).toBe(false);
});
