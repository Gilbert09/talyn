import { MessageAttachments } from '../components/workbench/MessageAttachments';
import { vi, it, expect, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { Composer } from '../components/workbench/Composer';
import { sandboxOps } from '../lib/workbenchOps';
import { api } from '../lib/api';
import { downscaleImage } from '../lib/imageDownscale';

vi.mock('../lib/supabase', () => ({
  isSupabaseConfigured: () => false,
  supabase: null,
}));
vi.mock('../lib/imageDownscale', () => ({ downscaleImage: vi.fn() }));

const workbench = {
  id: 'wb-1',
  workspaceId: 'ws-1',
  runtime: 'sandbox',
  status: 'ready',
  sandboxId: 'box-1',
  sandboxState: 'running',
  archivedAt: null,
  agent: 'claude',
  settings: {},
} as Workbench;
const chat = {
  id: 'chat-1',
  status: 'idle',
  queuedMessages: [],
} as unknown as WorkbenchChat;
const attachment = {
  name: 'shot.png',
  mimeType: 'image/png',
  path: '.context/attachments/shot.png',
};

function paste() {
  const file = new File(['image'], 'shot.png', { type: 'image/png' });
  fireEvent.paste(screen.getByRole('textbox', { name: 'Message the agent' }), {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
    },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('uploads a pasted sandbox image and shows its chip', async () => {
  vi.mocked(downscaleImage).mockResolvedValue('data:image/png;base64,aGVsbG8=');
  const upload = vi.spyOn(api.workbenches, 'uploadAttachment').mockResolvedValue(attachment);
  render(
    <Composer
      workbench={workbench}
      chat={chat}
      ops={sandboxOps(workbench)}
      todos={null}
      contextUsage={null}
      slashCommands={null}
    />,
  );
  paste();
  await waitFor(() => expect(screen.getByText('shot.png')).toBeInTheDocument());
  expect(upload).toHaveBeenCalledWith('wb-1', expect.any(Blob), 'shot.png');
  expect(upload.mock.calls[0][1].type).toBe('image/png');
});

it('shows the ready note without an upload or message change', async () => {
  vi.mocked(downscaleImage).mockResolvedValue('data:image/png;base64,aGVsbG8=');
  const upload = vi.spyOn(api.workbenches, 'uploadAttachment').mockResolvedValue(attachment);
  const starting = { ...workbench, status: 'provisioning' as const };
  render(
    <Composer
      workbench={starting}
      chat={chat}
      ops={sandboxOps(starting)}
      todos={null}
      contextUsage={null}
      slashCommands={null}
    />,
  );
  paste();
  expect(screen.getByText('Images can be attached once the sandbox is ready.')).toBeInTheDocument();
  expect(upload).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Message the agent' })).toHaveValue('');
  expect(screen.getByRole('textbox', { name: 'Message the agent' })).toBeEnabled();
});

it('encodes a large PNG as JPEG before upload', async () => {
  vi.mocked(downscaleImage).mockResolvedValue(`data:image/png;base64,${'AAAA'.repeat(524289)}`);
  vi.stubGlobal(
    'Image',
    class {
      width = 1600;
      height = 900;
      onload: (() => void) | null = null;
      set src(_source: string) {
        this.onload?.();
      }
    },
  );
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,aGVsbG8=');
  const upload = vi.spyOn(api.workbenches, 'uploadAttachment').mockResolvedValue({
    ...attachment,
    name: 'shot.jpg',
    mimeType: 'image/jpeg',
  });
  render(
    <Composer
      workbench={workbench}
      chat={chat}
      ops={sandboxOps(workbench)}
      todos={null}
      contextUsage={null}
      slashCommands={null}
    />,
  );
  paste();
  await waitFor(() => expect(upload).toHaveBeenCalled());
  expect(vi.mocked(downscaleImage)).toHaveBeenCalledWith(expect.any(File), 1600);
  expect(encode).toHaveBeenCalledWith('image/jpeg', 0.85);
  expect(drawImage).toHaveBeenCalled();
  expect(upload.mock.calls[0][1].type).toBe('image/jpeg');
  expect(upload.mock.calls[0][2]).toBe('shot.jpg');
});

it.each([
  ['missing route', () => Promise.reject(new Error('404'))],
  ['empty image', () => Promise.resolve(new Blob())],
])('keeps the file name when the preview fails: %s', async (_label, fetchBlob) => {
  const ops = { ...sandboxOps(workbench), attachmentBlob: vi.fn(fetchBlob) };
  render(<MessageAttachments attachments={[{ ...attachment, path: `preview-${_label}` }]} ops={ops} />);
  await waitFor(() => expect(screen.getByText(/shot.png.*Image unavailable/)).toBeInTheDocument());
  expect(screen.queryByRole('img')).toBeNull();
});

it('keeps the composer enabled during a sandbox refresh', async () => {
  const send = vi.spyOn(api.workbenches, 'sendMessage').mockResolvedValue({ queued: true });
  const wb = { ...workbench, status: 'moving' as const };
  render(<Composer workbench={wb} chat={chat} ops={sandboxOps(wb)} todos={null} contextUsage={null} slashCommands={null} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message the agent' }), { target: { value: 'Continue' } });
  const button = screen.getByRole('button', { name: 'Send the message' });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  await waitFor(() => expect(send).toHaveBeenCalledWith('chat-1', expect.objectContaining({ text: 'Continue' })));
  expect(screen.queryByText(/moving to a fresh sandbox/i)).toBeNull();
});
