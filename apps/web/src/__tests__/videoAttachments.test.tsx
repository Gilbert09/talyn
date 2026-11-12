import { vi, it, expect, afterEach, beforeEach, describe } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { Composer } from '../components/workbench/Composer';
import { MessageAttachments } from '../components/workbench/MessageAttachments';
import { useComposerImages, videoUploadType } from '../components/workbench/useComposerImages';
import { sandboxOps } from '../lib/workbenchOps';
import { api } from '../lib/api';
import { downscaleImage } from '../lib/imageDownscale';
import { toast } from '../stores/toast';
import { useWorkbenchStore } from '../stores/workbenches';

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
const chat = { id: 'chat-1', status: 'idle', queuedMessages: [] } as unknown as WorkbenchChat;

function sized(file: File, size: number): File {
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

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
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:video'), revokeObjectURL: vi.fn() }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('videoUploadType', () => {
  it.each([
    ['clip.mp4', 'video/mp4', 'video/mp4'],
    ['clip.webm', 'video/webm', 'video/webm'],
    ['IMG_0001.MOV', 'video/quicktime', 'video/quicktime'],
    ['clip.m4v', 'video/x-m4v', 'video/mp4'],
    ['clip.mov', '', 'video/quicktime'],
    ['clip.m4v', 'application/octet-stream', 'video/mp4'],
    ['clip.mkv', 'video/x-matroska', null],
    ['clip.avi', '', null],
    ['clip', '', null],
    ['shot.png', 'image/png', null],
    ['notes.mp4', 'text/plain', null],
  ])('%s with type "%s" uploads as %s', (name, type, expected) => {
    expect(videoUploadType({ name, type })).toBe(expected);
  });
});

describe('attaching a video in a session', () => {
  it('uploads the file as it is and shows a video chip', async () => {
    const upload = vi.spyOn(api.workbenches, 'uploadAttachment').mockResolvedValue({
      name: 'clip.mp4', mimeType: 'video/mp4', path: '.context/attachments/abc-clip.mp4',
    });
    const attach = renderComposer();
    const video = new File(['video bytes'], 'clip.mp4', { type: 'video/mp4' });
    attach([video]);
    await waitFor(() => expect(screen.getByText('clip.mp4')).toBeInTheDocument());
    expect(downscaleImage).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledWith('wb-1', expect.any(Blob), 'clip.mp4');
    const sent = upload.mock.calls[0][1];
    expect(sent.type).toBe('video/mp4');
    expect(sent.size).toBe('video bytes'.length);
    expect(screen.getByLabelText('Video')).toBeInTheDocument();
    expect(screen.getByText('clip.mp4').querySelector('img')).toBeNull();
  });

  it('labels a .mov file that has no type as QuickTime', async () => {
    const upload = vi.spyOn(api.workbenches, 'uploadAttachment').mockResolvedValue({
      name: 'clip.mov', mimeType: 'video/quicktime', path: '.context/attachments/abc-clip.mov',
    });
    const attach = renderComposer();
    attach([new File(['mov'], 'clip.mov', { type: '' })]);
    await waitFor(() => expect(upload).toHaveBeenCalled());
    expect(upload.mock.calls[0][1].type).toBe('video/quicktime');
  });

  it('keeps the order of mixed images and videos', async () => {
    vi.mocked(downscaleImage).mockResolvedValue('data:image/png;base64,aGVsbG8=');
    const upload = vi.spyOn(api.workbenches, 'uploadAttachment').mockImplementation(async (_id, blob, name) => ({
      name, mimeType: blob.type, path: `.context/attachments/${name}`,
    }));
    const attach = renderComposer();
    attach([
      new File(['v'], 'first.mp4', { type: 'video/mp4' }),
      new File(['i'], 'second.png', { type: 'image/png' }),
    ]);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(upload.mock.calls.map((call) => call[2])).toEqual(['first.mp4', 'second.png']);
  });

  it.each([
    ['larger than 50 MB', sized(new File(['v'], 'long.mp4', { type: 'video/mp4' }), 50 * 1024 * 1024 + 1), 'The video is larger than 50 MB.'],
    ['of an unsupported type', new File(['v'], 'clip.mkv', { type: 'video/x-matroska' }), 'Only MP4, MOV and WebM videos can be attached.'],
    ['empty', new File([], 'empty.mp4', { type: 'video/mp4' }), 'The video is empty.'],
  ])('refuses a video %s without an upload', async (_label, file, reason) => {
    const error = vi.spyOn(toast, 'error');
    const upload = vi.spyOn(api.workbenches, 'uploadAttachment');
    const attach = renderComposer();
    attach([file]);
    await waitFor(() => expect(error).toHaveBeenCalledWith('Could not attach the video', reason));
    expect(upload).not.toHaveBeenCalled();
    expect(screen.queryByText('Uploading…')).toBeNull();
  });

  it('offers videos in the file picker', () => {
    renderComposer();
    expect(screen.getByLabelText('Choose images or videos')).toHaveAttribute('accept', expect.stringContaining('video/mp4'));
    expect(screen.getByRole('button', { name: 'Attach images or videos' })).toBeInTheDocument();
  });
});

it('refuses a video before the session exists, and keeps images inline', async () => {
  vi.mocked(downscaleImage).mockResolvedValue('data:image/png;base64,aGVsbG8=');
  const error = vi.spyOn(toast, 'error');
  const { result } = renderHook(() => useComposerImages('sandbox'));
  await act(() => result.current.attachFiles([
    new File(['v'], 'clip.mp4', { type: 'video/mp4' }),
    new File(['i'], 'shot.png', { type: 'image/png' }),
  ]));
  expect(error).toHaveBeenCalledWith('Could not attach the video', 'Videos can be attached once the session has started.');
  expect(result.current.attachments).toEqual([{ name: 'shot.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=' }]);
  expect(result.current.pendingUploads).toBe(0);
});

describe('a video in the transcript', () => {
  const video = { name: 'clip.mp4', mimeType: 'video/mp4', path: '.context/attachments/transcript-clip.mp4' };

  it('loads the video only when it is opened, then plays it', async () => {
    const attachmentBlob = vi.fn(async () => new Blob(['v'], { type: 'video/mp4' }));
    render(<MessageAttachments attachments={[video]} ops={{ ...sandboxOps(workbench), attachmentBlob }} />);
    expect(attachmentBlob).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Play clip.mp4' }));
    await waitFor(() => expect(document.querySelector('video')).toHaveAttribute('src', 'blob:video'));
    expect(attachmentBlob).toHaveBeenCalledWith(video.path, 'video/mp4');
  });

  it('says so when the video cannot be read', async () => {
    const attachmentBlob = vi.fn(async () => { throw new Error('404'); });
    render(<MessageAttachments attachments={[{ ...video, path: '.context/attachments/missing.mp4' }]} ops={{ ...sandboxOps(workbench), attachmentBlob }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play clip.mp4' }));
    await waitFor(() => expect(screen.getByText('Video unavailable.')).toBeInTheDocument());
    expect(document.querySelector('video')).toBeNull();
  });
});
