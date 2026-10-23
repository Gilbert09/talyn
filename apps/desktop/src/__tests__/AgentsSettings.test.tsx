import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SESSION_DEFAULTS_KEY } from '../renderer/lib/sessionDefaults';
import { AgentsSettings } from '../renderer/components/settings/sections/AgentsSettings';

jest.mock('../renderer/components/settings/providerCards', () => ({
  ProviderConnectCards: () => null,
}));
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) => selector({
    currentWorkspaceId: null,
    workspaces: [],
    setWorkspaces: jest.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(SESSION_DEFAULTS_KEY);
});

it('shows the PR default below cloud agents and saves changes for new sessions', () => {
  render(<AgentsSettings />);
  const cloudAgents = screen.getByRole('heading', { name: 'Cloud agents' });
  const pullRequests = screen.getByRole('heading', { name: 'Pull requests' });
  expect(cloudAgents.compareDocumentPosition(pullRequests) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  const toggle = screen.getByRole('checkbox', { name: /^Open a PR when the agent is done/ });
  expect(screen.getByText('The agent opens a pull request when it thinks the work is finished. New sessions use this.')).toBeInTheDocument();
  expect(toggle).toBeChecked();
  fireEvent.click(toggle);
  expect(toggle).not.toBeChecked();
  expect(JSON.parse(localStorage.getItem(SESSION_DEFAULTS_KEY) ?? '{}')).toMatchObject({ autoCreatePr: false });
});
