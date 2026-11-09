import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FLEET_MODELS, fleetAgentForModel, type Workspace } from '@talyn/shared';
import { SESSION_DEFAULTS_KEY } from '../lib/sessionDefaults';
import { SessionsSettings } from '../components/settings/sections/SessionsSettings';

const { update, setWorkspaces, setSidebarOrder, state } = vi.hoisted(() => ({
  update: vi.fn(),
  setWorkspaces: vi.fn(),
  setSidebarOrder: vi.fn(),
  state: { workspaces: [] as Workspace[] },
}));

vi.mock('../lib/api', () => ({ api: { workspaces: { update } } }));
vi.mock('../stores/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: (selector: (value: unknown) => unknown) =>
    selector({
      workspaces: state.workspaces,
      currentWorkspaceId: 'ws1',
      setWorkspaces,
      sidebarOrder: 'active_first',
      setSidebarOrder,
    }),
}));

beforeEach(() => {
  state.workspaces = [{ id: 'ws1', name: 'WS', settings: {} } as Workspace];
  update.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  localStorage.removeItem(SESSION_DEFAULTS_KEY);
  vi.clearAllMocks();
});

describe('SessionsSettings', () => {
  it('uses the sandbox without a runtime picker', () => {
    render(<SessionsSettings />);
    expect(screen.queryByLabelText('Default runtime')).toBeNull();
    expect(screen.getByLabelText('Default agent')).toBeTruthy();
  });

  it('lets the person switch to repository grouping', () => {
    render(<SessionsSettings />);
    const select = screen.getByLabelText('Sidebar session order') as HTMLSelectElement;
    expect(select.value).toBe('active_first');
    fireEvent.change(select, { target: { value: 'repository' } });
    expect(setSidebarOrder).toHaveBeenCalledWith('repository');
  });

  it.each(['claude', 'codex'] as const)('lists %s models', (agent) => {
    localStorage.setItem(SESSION_DEFAULTS_KEY, JSON.stringify({ agent }));
    render(<SessionsSettings />);
    const select = screen.getByLabelText('Default model') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(
      FLEET_MODELS.filter((model) => fleetAgentForModel(model.id) === agent).map((model) => model.id),
    );
  });

  it('saves the branch prefix', async () => {
    render(<SessionsSettings />);
    const input = screen.getByLabelText('Branch prefix');
    fireEvent.change(input, { target: { value: ' tom/ ' } });
    fireEvent.blur(input);
    await waitFor(() => expect(update).toHaveBeenCalledWith('ws1', {
      settings: { sessionBranchPrefix: 'tom/' },
    }));
  });

  it('turns Claude commit co-authorship off', async () => {
    render(<SessionsSettings />);
    const toggle = screen.getByRole('checkbox', { name: /^Add Claude as a co-author/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(update).toHaveBeenCalledWith('ws1', {
      settings: { claudeCoAuthoredBy: false },
    }));
  });

  it('saves internet access for new sessions', () => {
    render(<SessionsSettings />);
    fireEvent.click(screen.getByRole('checkbox', { name: /^Internet access/ }));
    expect(JSON.parse(localStorage.getItem(SESSION_DEFAULTS_KEY) ?? '{}')).toMatchObject({ internetAccess: false });
  });

  it('shows the archive defaults and saves the idle window', async () => {
    render(<SessionsSettings />);
    const select = screen.getByLabelText('Archive idle sessions') as HTMLSelectElement;
    expect(select.value).toBe('7');
    expect((screen.getByRole('checkbox', { name: /^Archive when the pull request merges/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(select, { target: { value: '0' } });
    expect(select.value).toBe('0');
    await waitFor(() => expect(update).toHaveBeenCalledWith('ws1', { settings: { autoArchiveIdleDays: 0 } }));
  });

  it('keeps a custom idle window and saves the merge switch', async () => {
    state.workspaces = [{ id: 'ws1', name: 'WS', settings: { autoArchiveIdleDays: 45 } } as Workspace];
    render(<SessionsSettings />);
    expect((screen.getByLabelText('Archive idle sessions') as HTMLSelectElement).value).toBe('45');
    fireEvent.click(screen.getByRole('checkbox', { name: /^Archive when the pull request merges/ }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('ws1', { settings: { autoArchiveOnMerge: false } }));
  });
});
