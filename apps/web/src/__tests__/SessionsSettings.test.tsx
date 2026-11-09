import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FLEET_MODELS, fleetAgentForModel, type SpacesTeam, type Workspace } from '@talyn/shared';
import { SESSION_DEFAULTS_KEY } from '../lib/sessionDefaults';
import { SessionsSettings, sessionSettingsWorkspaceId } from '../components/settings/sections/SessionsSettings';
import { useSpacesStore } from '../stores/spaces';

const { update, setWorkspaces, setSidebarOrder, state } = vi.hoisted(() => ({
  update: vi.fn(),
  setWorkspaces: vi.fn(),
  setSidebarOrder: vi.fn(),
  state: {
    workspaces: [] as Workspace[],
    context: { kind: 'personal', workspaceId: 'ws1' } as { kind: 'personal'; workspaceId: string } | { kind: 'space'; spaceId: string },
  },
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
      features: { spaces: true },
      currentContext: state.context,
    }),
}));

const team = (homeWorkspaceId: string | null): SpacesTeam => ({
  id: 't1',
  name: 'Acme',
  role: 'member',
  homeWorkspaceId,
  createdAt: '',
  spaces: [{ id: 's1', teamId: 't1', name: 'Web', color: null, image: null, createdByUserId: null, archivedAt: null, createdAt: '', updatedAt: '' }],
});

beforeEach(() => {
  state.workspaces = [{ id: 'ws1', name: 'WS', settings: {} } as Workspace];
  state.context = { kind: 'personal', workspaceId: 'ws1' };
  useSpacesStore.setState({ teams: [team('ws2')] });
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

  it('says the session order applies in spaces too', () => {
    render(<SessionsSettings />);
    expect(screen.getByText(/This device uses this order in Personal and in every space/)).toBeTruthy();
  });
});

describe('sessionSettingsWorkspaceId', () => {
  const workspaces = [{ id: 'ws1' }, { id: 'ws2' }];
  it.each<[string, string | null | undefined, string | null]>([
    ['Personal', undefined, 'ws1'],
    ['a space whose home workspace is mine', 'ws2', 'ws2'],
    ['a space whose home workspace is not mine', 'ws-other', 'ws1'],
    ['a space with no home workspace', null, 'ws1'],
  ])('%s', (_name, home, expected) => {
    const space = home === undefined ? null : { team: team(home) };
    expect(sessionSettingsWorkspaceId(space, workspaces, 'ws1')).toBe(expected);
  });
});

describe('SessionsSettings in a space', () => {
  beforeEach(() => {
    state.workspaces = [
      { id: 'ws1', name: 'WS', settings: {} } as Workspace,
      { id: 'ws2', name: 'Home', settings: { autoArchiveIdleDays: 14 } } as Workspace,
    ];
  });

  it.each<[string, 'personal' | 'space', string | null, string, string]>([
    ['Personal', 'personal', 'ws2', 'ws1', '7'],
    ['a space', 'space', 'ws2', 'ws2', '14'],
    ['a space whose home workspace is not mine', 'space', 'ws-other', 'ws1', '7'],
  ])('in %s, edits %s', async (_name, kind, home, target, shown) => {
    useSpacesStore.setState({ teams: [team(home)] });
    state.context = kind === 'space' ? { kind: 'space', spaceId: 's1' } : { kind: 'personal', workspaceId: 'ws1' };
    render(<SessionsSettings />);
    const note = screen.queryByText(/^Sessions you start in Web use the settings of/);
    if (target === 'ws2') expect(note?.textContent).toBe('Sessions you start in Web use the settings of Home.');
    else expect(note).toBeNull();
    const select = screen.getByLabelText('Archive idle sessions') as HTMLSelectElement;
    expect(select.value).toBe(shown);
    fireEvent.change(select, { target: { value: '3' } });
    await waitFor(() => expect(update).toHaveBeenCalledWith(target, { settings: { autoArchiveIdleDays: 3 } }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^Add Claude as a co-author/ }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(target, { settings: { claudeCoAuthoredBy: false } }));
  });
});
