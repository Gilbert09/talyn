import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { FLEET_MODELS, defaultFleetModelForAgent, fleetAgentForModel, type Workspace } from '@talyn/shared';
import { SESSION_DEFAULTS_KEY } from '../renderer/lib/sessionDefaults';
import { SessionsSettings } from '../renderer/components/settings/sections/SessionsSettings';

const mockUpdate = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: { workspaces: { update: (...args: unknown[]) => mockUpdate(...args) } },
}));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const setWorkspaces = jest.fn();
let workspaces: Workspace[] = [];
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ workspaces, currentWorkspaceId: 'ws1', setWorkspaces }),
}));

const field = () => screen.getByLabelText('Branch prefix') as HTMLInputElement;

beforeEach(() => {
  workspaces = [{ id: 'ws1', name: 'WS', settings: {} } as unknown as Workspace];
  mockUpdate.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(SESSION_DEFAULTS_KEY);
  jest.clearAllMocks();
});

describe('SessionsSettings branch prefix', () => {
  it('shows the live example', () => {
    render(<SessionsSettings />);
    expect(screen.getByText('New branches use the session name, like seattle')).toBeInTheDocument();
    fireEvent.change(field(), { target: { value: 'tom/' } });
    expect(screen.getByText('New branches look like tom/seattle')).toBeInTheDocument();
  });

  it('saves a trimmed value on blur', async () => {
    render(<SessionsSettings />);
    fireEvent.change(field(), { target: { value: '  tom-  ' } });
    fireEvent.blur(field());
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith('ws1', { settings: { sessionBranchPrefix: 'tom-' } }),
    );
    await waitFor(() => expect(setWorkspaces).toHaveBeenCalled());
  });

  it('saves on Enter', async () => {
    render(<SessionsSettings />);
    field().focus();
    fireEvent.change(field(), { target: { value: 'tom/' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
  });

  it('shows an inline error and does not save a bad prefix', () => {
    render(<SessionsSettings />);
    fireEvent.change(field(), { target: { value: 'bad..' } });
    fireEvent.blur(field());
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot start a Git branch name/);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does not save when nothing changed', () => {
    render(<SessionsSettings />);
    fireEvent.blur(field());
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('SessionsSettings model', () => {
  const modelSelect = () => screen.getByLabelText('Default model') as HTMLSelectElement;
  const optionIds = () => Array.from(modelSelect().options).map((o) => o.value);

  it.each(['claude', 'codex'] as const)('lists only %s models', (agent) => {
    window.localStorage.setItem(SESSION_DEFAULTS_KEY, JSON.stringify({ agent }));
    render(<SessionsSettings />);
    const ids = optionIds();
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toEqual(FLEET_MODELS.filter((m) => fleetAgentForModel(m.id) === agent).map((m) => m.id));
    expect(modelSelect().value).toBe(defaultFleetModelForAgent(agent));
  });

  it('switches the list when the agent changes', () => {
    render(<SessionsSettings />);
    expect(optionIds().every((id) => fleetAgentForModel(id) === 'claude')).toBe(true);
    fireEvent.change(screen.getByLabelText('Default agent'), { target: { value: 'codex' } });
    expect(optionIds().every((id) => fleetAgentForModel(id) === 'codex')).toBe(true);
  });

  it('shows the stored model for the agent and ignores the other vendor', () => {
    const claude = FLEET_MODELS.filter((m) => fleetAgentForModel(m.id) === 'claude').at(-1)!.id;
    const codex = FLEET_MODELS.find((m) => fleetAgentForModel(m.id) === 'codex')!.id;
    workspaces = [{ id: 'ws1', name: 'WS', settings: { fleetModel: codex, fleetModels: { claude } } } as unknown as Workspace];
    render(<SessionsSettings />);
    expect(modelSelect().value).toBe(claude);
  });

  it('files the choice under the agent and keeps the other agent', async () => {
    const codex = FLEET_MODELS.find((m) => fleetAgentForModel(m.id) === 'codex')!.id;
    const claude = FLEET_MODELS.filter((m) => fleetAgentForModel(m.id) === 'claude').at(-1)!.id;
    workspaces = [{ id: 'ws1', name: 'WS', settings: { fleetModels: { codex } } } as unknown as Workspace];
    render(<SessionsSettings />);
    fireEvent.change(modelSelect(), { target: { value: claude } });
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith('ws1', { settings: { fleetModels: { codex, claude } } }),
    );
    await waitFor(() => expect(setWorkspaces).toHaveBeenCalled());
  });
});

describe('SessionsSettings internet access', () => {
  it('starts on and saves changes for new sessions', () => {
    render(<SessionsSettings />);
    const toggle = screen.getByRole('checkbox', { name: /^Internet access / });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(JSON.parse(localStorage.getItem(SESSION_DEFAULTS_KEY) ?? '{}')).toMatchObject({ internetAccess: false });
  });
});
