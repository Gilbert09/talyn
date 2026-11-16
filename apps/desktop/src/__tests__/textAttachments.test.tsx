import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { Composer } from '../renderer/components/workbench/Composer';
import { MessageAttachments } from '../renderer/components/workbench/MessageAttachments';
import { readTextAttachment, useComposerImages } from '../renderer/components/workbench/useComposerImages';
import { sandboxOps } from '../renderer/lib/workbenchOps';
import { api } from '../renderer/lib/api';
import { downscaleImage } from '../renderer/lib/imageDownscale';
import { toast } from '../renderer/stores/toast';
import { useWorkbenchStore } from '../renderer/stores/workbenches';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/lib/imageDownscale', () => ({ downscaleImage: jest.fn() }));

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

const base64 = (text: string) => Buffer.from(text).toString('base64');

function renderComposer() {
  const attachRef: { current: ((files: File[]) => void) | null } = { current: null };
  render(
    <Composer
      workbench={workbench}
      chat={chat}
      ops={sandboxOps(workbench)}
      todos={null}
      contextUsage={null}
      slashCommands={null}
      attachRef={attachRef}
    />,
  );
  return (files: File[]) => act(() => attachRef.current?.(files));
}

beforeEach(() => {
  useWorkbenchStore.setState({ outgoingMessages: {}, drafts: {} });
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('readTextAttachment', () => {
  it('encodes UTF-8 text as base64', async () => {
    await expect(readTextAttachment(new Blob(['naïve café ✓\n']))).resolves.toBe(base64('naïve café ✓\n'));
  });

  it.each([
    ['binary bytes', new Blob([new Uint8Array([0x89, 0x50, 0x00, 0x47])]), 'The file is not UTF-8 text.'],
    ['Latin-1 text', new Blob([new Uint8Array([0x63, 0x61, 0x66, 0xe9])]), 'The file is not UTF-8 text.'],
    ['a file over 1 MB', new Blob([new Uint8Array(1024 * 1024 + 1).fill(0x61)]), 'The file is larger than 1 MB.'],
  ])('refuses %s', async (_label, blob, reason) => {
    await expect(readTextAttachment(blob)).rejects.toThrow(reason);
  });
});

describe('attaching a text file in a session', () => {
  it('uploads it as text/plain under its own name and shows a text chip', async () => {
    const upload = jest.spyOn(api.workbenches, 'uploadAttachment').mockResolvedValue({
      name: 'notes.md', mimeType: 'text/plain', path: '.context/attachments/abc-notes.md',
    });
    const attach = renderComposer();
    attach([new File(['# Notes\n'], 'notes.md', { type: '' })]);
    await waitFor(() => expect(screen.getByText('notes.md')).toBeInTheDocument());
    expect(downscaleImage).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledWith('wb-1', expect.any(Blob), 'notes.md');
    expect(upload.mock.calls[0][1].type).toBe('text/plain');
    expect(screen.getByLabelText('Text file')).toBeInTheDocument();
  });

  it('treats a .ts file as text, not as a video', async () => {
    const upload = jest.spyOn(api.workbenches, 'uploadAttachment').mockResolvedValue({
      name: 'index.ts', mimeType: 'text/plain', path: '.context/attachments/abc-index.ts',
    });
    const attach = renderComposer();
    attach([new File(['export {};\n'], 'index.ts', { type: 'video/mp2t' })]);
    await waitFor(() => expect(upload).toHaveBeenCalled());
    expect(upload.mock.calls[0][1].type).toBe('text/plain');
  });

  it.each([
    ['a binary file named as text', new File([new Uint8Array([0, 1, 2])], 'data.txt', { type: 'text/plain' }), 'The file is not UTF-8 text.'],
    ['a PDF', new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' }), 'Only images, videos and text files can be attached.'],
  ])('refuses %s without an upload', async (_label, file, reason) => {
    const error = jest.spyOn(toast, 'error');
    const upload = jest.spyOn(api.workbenches, 'uploadAttachment');
    const attach = renderComposer();
    attach([file]);
    await waitFor(() => expect(error).toHaveBeenCalledWith('Could not attach the file', reason));
    expect(upload).not.toHaveBeenCalled();
    expect(screen.queryByText('Uploading…')).toBeNull();
  });

  it('offers text files in the file picker', () => {
    renderComposer();
    const accept = screen.getByLabelText('Choose images, videos or text files').getAttribute('accept') ?? '';
    expect(accept.split(',')).toEqual(expect.arrayContaining(['text/*', '.md', '.json', '.log', '.ts']));
  });
});

it('keeps a text file inline before the session exists', async () => {
  const { result } = renderHook(() => useComposerImages('sandbox'));
  await act(() => result.current.attachFiles([new File(['hello\n'], 'notes.txt', { type: 'text/plain' })]));
  expect(result.current.attachments).toEqual([{ name: 'notes.txt', mimeType: 'text/plain', dataBase64: base64('hello\n') }]);
  expect(result.current.pendingUploads).toBe(0);
});

it('shows a text file in the transcript by name, without reading it', () => {
  const attachmentBlob = jest.fn();
  render(
    <MessageAttachments
      attachments={[{ name: 'notes.md', mimeType: 'text/plain', path: '.context/attachments/abc-notes.md' }]}
      ops={{ ...sandboxOps(workbench), attachmentBlob }}
    />,
  );
  expect(screen.getByText('notes.md')).toBeInTheDocument();
  expect(screen.queryByText(/unavailable/)).toBeNull();
  expect(attachmentBlob).not.toHaveBeenCalled();
});
