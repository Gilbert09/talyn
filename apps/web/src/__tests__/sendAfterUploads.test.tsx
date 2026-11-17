import { vi, it, expect, afterEach, beforeEach, describe } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench, WorkbenchAttachment, WorkbenchChat } from '@talyn/shared';
import { Composer } from '../components/workbench/Composer';
import { sandboxOps } from '../lib/workbenchOps';
import { api } from '../lib/api';
import { toast } from '../stores/toast';
import { useWorkbenchStore } from '../stores/workbenches';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
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
const chat = { id: 'chat-1', status: 'idle', queuedMessages: [] } as unknown as WorkbenchChat;
const uploaded: WorkbenchAttachment = { name: 'notes.md', mimeType: 'text/plain', path: '.context/attachments/abc-notes.md' };

/** Starts an upload that waits until the test ends it. */
function slowUpload() {
  let end: (ok: boolean) => void = () => {};
  vi.spyOn(api.workbenches, 'uploadAttachment').mockImplementation(
    () => new Promise((resolve, reject) => {
      end = (ok) => (ok ? resolve(uploaded) : reject(new Error('The upload failed.')));
    }),
  );
  return (ok: boolean) => act(async () => end(ok));
}

function renderComposer() {
  const attachRef: { current: ((files: File[]) => void) | null } = { current: null };
  render(
    <Composer workbench={workbench} chat={chat} ops={sandboxOps(workbench)} todos={null} contextUsage={null} slashCommands={null} attachRef={attachRef} />,
  );
  act(() => attachRef.current?.([new File(['# Notes\n'], 'notes.md', { type: 'text/plain' })]));
}

const typeAndSend = async (text: string) => {
  fireEvent.change(screen.getByLabelText('Message the agent'), { target: { value: text } });
  await waitFor(() => expect(api.workbenches.uploadAttachment).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Send the message' }));
};

beforeEach(() => {
  useWorkbenchStore.setState({ outgoingMessages: {}, drafts: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('send while a file uploads', () => {
  it('holds the message and sends it with the file when the upload ends', async () => {
    const end = slowUpload();
    const send = vi.spyOn(api.workbenches, 'sendMessage').mockResolvedValue({ queued: false } as never);
    renderComposer();
    await typeAndSend('Read this');
    expect(screen.getByText('Uploading… The message sends after the upload.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel the waiting message' })).toBeEnabled();
    expect(send).not.toHaveBeenCalled();
    await end(true);
    await waitFor(() => expect(send).toHaveBeenCalledWith('chat-1', expect.objectContaining({ text: 'Read this', attachments: [uploaded] })));
  });

  it('holds the message on Enter', async () => {
    const end = slowUpload();
    const send = vi.spyOn(api.workbenches, 'sendMessage').mockResolvedValue({ queued: false } as never);
    renderComposer();
    const field = screen.getByLabelText('Message the agent');
    fireEvent.change(field, { target: { value: 'Read this' } });
    await waitFor(() => expect(api.workbenches.uploadAttachment).toHaveBeenCalled());
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByText('Uploading… The message sends after the upload.')).toBeInTheDocument();
    await end(true);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it('keeps the message when the upload fails', async () => {
    const end = slowUpload();
    const send = vi.spyOn(api.workbenches, 'sendMessage');
    const error = vi.spyOn(toast, 'error');
    renderComposer();
    await typeAndSend('Read this');
    await end(false);
    await waitFor(() => expect(error).toHaveBeenCalledWith('The message was not sent', expect.any(String)));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message the agent')).toHaveValue('Read this');
  });

  it('cancels the held message on a second click', async () => {
    const end = slowUpload();
    const send = vi.spyOn(api.workbenches, 'sendMessage');
    renderComposer();
    await typeAndSend('Read this');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the waiting message' }));
    await end(true);
    await waitFor(() => expect(screen.getByText('notes.md')).toBeInTheDocument());
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send the message' })).toBeEnabled();
  });
});
