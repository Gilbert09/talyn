import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { Composer } from '../renderer/components/workbench/Composer';
import { sandboxOps } from '../renderer/lib/workbenchOps';
import { api } from '../renderer/lib/api';
import { downscaleImage } from '../renderer/lib/imageDownscale';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/lib/imageDownscale', () => ({ downscaleImage: jest.fn() }));

const workbench = {
  id: 'wb-1', workspaceId: 'ws-1', runtime: 'sandbox', status: 'ready', sandboxId: 'box-1',
  sandboxState: 'running', archivedAt: null, agent: 'claude', settings: {},
} as Workbench;
const chat = { id: 'chat-1', status: 'idle', queuedMessages: [] } as unknown as WorkbenchChat;
const attachment = { name: 'shot.png', mimeType: 'image/png', path: '.context/attachments/shot.png' };

function paste() {
  const file = new File(['image'], 'shot.png', { type: 'image/png' });
  fireEvent.paste(screen.getByRole('textbox', { name: 'Message the agent' }), {
    clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
  });
}

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

it('uploads a pasted sandbox image and shows its chip', async () => {
  jest.mocked(downscaleImage).mockResolvedValue('data:image/png;base64,aGVsbG8=');
  const upload = jest.spyOn(api.workbenches, 'uploadAttachment').mockResolvedValue(attachment);
  render(<Composer workbench={workbench} chat={chat} ops={sandboxOps(workbench)} todos={null} contextUsage={null} slashCommands={null} />);
  paste();
  await waitFor(() => expect(screen.getByText('shot.png')).toBeInTheDocument());
  expect(upload).toHaveBeenCalledWith('wb-1', expect.any(Blob), 'shot.png');
  expect(upload.mock.calls[0][1].type).toBe('image/png');
});

it('shows the ready note without an upload or message change', async () => {
  jest.mocked(downscaleImage).mockResolvedValue('data:image/png;base64,aGVsbG8=');
  const upload = jest.spyOn(api.workbenches, 'uploadAttachment').mockResolvedValue(attachment);
  const starting = { ...workbench, status: 'provisioning' as const };
  render(<Composer workbench={starting} chat={chat} ops={sandboxOps(starting)} todos={null} contextUsage={null} slashCommands={null} />);
  paste();
  expect(screen.getByText('Images can be attached once the sandbox is ready.')).toBeInTheDocument();
  expect(upload).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Message the agent' })).toHaveValue('');
  expect(screen.getByRole('textbox', { name: 'Message the agent' })).toBeEnabled();
});

it('encodes a large PNG as JPEG before upload', async () => {
  jest.mocked(downscaleImage)
    .mockResolvedValueOnce(`data:image/png;base64,${'AAAA'.repeat(524289)}`)
    .mockResolvedValueOnce('data:image/jpeg;base64,aGVsbG8=');
  const upload = jest.spyOn(api.workbenches, 'uploadAttachment').mockResolvedValue({ ...attachment, name: 'shot.jpg', mimeType: 'image/jpeg' });
  render(<Composer workbench={workbench} chat={chat} ops={sandboxOps(workbench)} todos={null} contextUsage={null} slashCommands={null} />);
  paste();
  await waitFor(() => expect(upload).toHaveBeenCalled());
  expect(jest.mocked(downscaleImage)).toHaveBeenLastCalledWith(expect.any(File), 1600, 'image/jpeg', 0.85);
  expect(upload.mock.calls[0][1].type).toBe('image/jpeg');
  expect(upload.mock.calls[0][2]).toBe('shot.jpg');
});
