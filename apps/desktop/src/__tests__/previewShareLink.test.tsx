import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Features, Workbench } from '@talyn/shared';
import { SessionPreviewChips } from '../renderer/components/workbench/SessionPreviewChips';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { usePreviewStatusStore } from '../renderer/stores/previewStatus';
import { toast } from '../renderer/stores/toast';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';

const previewGet = jest.fn();
const previewLink = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: {
    repositories: { preview: { get: (...args: unknown[]) => previewGet(...args) } },
    workbenches: { previewLink: (...args: unknown[]) => previewLink(...args) },
  },
  API_BASE_URL: 'https://api.example.com',
  getAccessToken: async () => 'token',
}));
jest.mock('../renderer/lib/previewProbe', () => ({ previewPortAnswers: async () => true }));
jest.mock('../renderer/stores/toast', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));

const wb = { id: 'wb1', repositoryId: 'repo', runtime: 'sandbox', status: 'ready' } as Workbench;
const ops = { runScript: jest.fn(), unavailable: null } as unknown as WorkbenchOps;
const writeText = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  previewGet.mockResolvedValue({ target: 'sandbox', ports: [{ port: 5173 }] });
  previewLink.mockResolvedValue({ url: 'https://abc-5173.preview.test/__talyn/auth?ticket=t', origin: 'https://abc-5173.preview.test', port: 5173, expiresAt: '' });
  writeText.mockReset().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  useWorkspaceStore.setState({ features: { workbenches: true, previewLinks: true } as Features });
  useWorkbenchStore.setState({ scriptOutput: { wb1: { run: { running: true } } } } as never);
  usePreviewStatusStore.setState({ ports: {} });
  usePreviewStatusStore.getState().set('wb1', 5173, 'live');
});
afterEach(cleanup);

it('copies a one-time share link for a live port', async () => {
  render(<SessionPreviewChips workbench={wb} ops={ops} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy a share link for port 5173' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://abc-5173.preview.test/__talyn/auth?ticket=t'));
  expect(previewLink).toHaveBeenCalledWith('wb1', 5173);
  expect(toast.success).toHaveBeenCalled();
});

it('says why when the link cannot be made', async () => {
  previewLink.mockRejectedValue(new Error('Hosted previews are not set up on this deployment.'));
  render(<SessionPreviewChips workbench={wb} ops={ops} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy a share link for port 5173' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not copy the share link', 'Hosted previews are not set up on this deployment.'));
  expect(writeText).not.toHaveBeenCalled();
});

it.each([
  ['the deployment has no preview domain', () => useWorkspaceStore.setState({ features: { workbenches: true } as Features })],
  ['the app is not running', () => useWorkbenchStore.setState({ scriptOutput: {} } as never)],
])('hides the share button when %s', async (_name, setup) => {
  setup();
  render(<SessionPreviewChips workbench={wb} ops={ops} />);
  await screen.findByRole('button', { name: /localhost:5173/ });
  expect(screen.queryByRole('button', { name: 'Copy a share link for port 5173' })).toBeNull();
});
