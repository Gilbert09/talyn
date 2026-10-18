import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Workspace } from '@talyn/shared';
import { SessionsSettings } from '../renderer/components/settings/sections/SessionsSettings';

const mockUpdate = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: { workspaces: { update: (...args: unknown[]) => mockUpdate(...args) } },
}));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock('../renderer/components/settings/WorkspaceModelSelector', () => ({
  WorkspaceModelSelector: () => null,
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
