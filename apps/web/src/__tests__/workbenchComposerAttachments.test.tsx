import { MessageAttachments } from '../components/workbench/MessageAttachments';
import { vi, it, expect, afterEach, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { Composer } from '../components/workbench/Composer';
import { sandboxOps } from '../lib/workbenchOps';
import { api, ApiError } from '../lib/api';
import { downscaleImage } from '../lib/imageDownscale';
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

beforeEach(() => {
  useWorkbenchStore.setState({ outgoingMessages: {}, drafts: {} });
});

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
  const chip = screen.getByText('shot.png');
  expect(chip.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,aGVsbG8=');
});

it('lets a surrounding drop zone attach images through attachRef', async () => {
  vi.mocked(downscaleImage).mockResolvedValue('data:image/png;base64,aGVsbG8=');
  const upload = vi.spyOn(api.workbenches, 'uploadAttachment').mockResolvedValue(attachment);
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
  expect(attachRef.current).toBeInstanceOf(Function);
  act(() => attachRef.current?.([new File(['image'], 'shot.png', { type: 'image/png' })]));
  await waitFor(() => expect(screen.getByText('shot.png')).toBeInTheDocument());
  expect(upload).toHaveBeenCalledWith('wb-1', expect.any(Blob), 'shot.png');
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

const waitingChat = (wait: object, extra: object = {}) => ({
  id: 'chat-1', status: 'running',
  queuedMessages: [{ id: 'q1', text: 'first message', queuedAt: '2026-11-03T10:00:00Z', capacityWait: { turn: 1, startedAt: '2026-11-03T10:00:00Z', retryAt: new Date(Date.now() + 20_000).toISOString(), attempts: 1, ...wait }, ...extra }],
}) as unknown as WorkbenchChat;

it.each([
  ['capacity', /^Waiting for a free sandbox… \(retrying in \d+s\)$/],
  ['waking', /^Waking the sandbox…$/],
])('shows a status line and no Queued chip for a %s wait', (reason, text) => {
  const ops = { ...sandboxOps(workbench), removeQueued: vi.fn() };
  render(<Composer workbench={workbench} chat={waitingChat({ reason })} ops={ops} todos={null} contextUsage={null} slashCommands={null} />);
  expect(screen.getByText(text)).toBeInTheDocument();
  expect(screen.queryByText('Queued')).not.toBeInTheDocument();
  expect(screen.queryByText('first message')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }));
  expect(ops.removeQueued).toHaveBeenCalledWith('chat-1', 'q1');
});

it('shows an ordinary queued message as a Queued chip', () => {
  const ordinary = { id: 'chat-1', status: 'running', queuedMessages: [{ id: 'q2', text: 'later', queuedAt: '2026-11-03T10:00:00Z' }] } as unknown as WorkbenchChat;
  render(<Composer workbench={workbench} chat={ordinary} ops={sandboxOps(workbench)} todos={null} contextUsage={null} slashCommands={null} />);
  expect(screen.getByText('Queued')).toBeInTheDocument();
  expect(screen.getByText('later')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Stop waiting' })).not.toBeInTheDocument();
});

it('switches the chat provider at the same model tier', async () => {
  const activeChat = { ...chat, agent: 'claude' as const, model: 'claude-opus-5-5' };
  const update = vi.spyOn(api.workbenches, 'updateChat').mockResolvedValue({
    ...activeChat,
    agent: 'codex',
    model: 'gpt-6-astra',
  });
  render(
    <Composer
      workbench={workbench}
      chat={activeChat}
      ops={sandboxOps(workbench)}
      todos={null}
      contextUsage={null}
      slashCommands={null}
    />,
  );

  fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'codex' } });
  await waitFor(() => expect(update).toHaveBeenCalledWith('chat-1', expect.objectContaining({
    agent: 'codex',
    model: 'gpt-6-astra',
  })));
});

it('stages a prompt before its send request finishes', async () => {
  let finishSend: (result: { queued: boolean }) => void = () => undefined;
  const send = vi.spyOn(api.workbenches, 'sendMessage').mockReturnValue(
    new Promise<{ queued: boolean }>((resolve) => { finishSend = resolve; }),
  );
  render(<Composer workbench={workbench} chat={chat} ops={sandboxOps(workbench)} todos={null} contextUsage={null} slashCommands={null} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message the agent' }), { target: { value: 'Check the cache' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send the message' }));

  expect(screen.getByRole('textbox', { name: 'Message the agent' })).toHaveValue('');
  await waitFor(() => expect(send).toHaveBeenCalledWith('chat-1', expect.objectContaining({ text: 'Check the cache' })));
  expect(useWorkbenchStore.getState().outgoingMessages['chat-1']).toEqual([expect.objectContaining({ text: 'Check the cache' })]);
  expect(useWorkbenchStore.getState().outgoingMessages['chat-1'][0].settledAt).toBeUndefined();

  await act(async () => finishSend({ queued: false }));
  // The prompt stays in the transcript until its own event arrives.
  expect(useWorkbenchStore.getState().outgoingMessages['chat-1']).toEqual([
    expect.objectContaining({ text: 'Check the cache', settledAt: expect.any(Number) }),
  ]);
});

it('keeps a failed prompt in the chat with its error, and empties the composer', async () => {
  vi.spyOn(api.workbenches, 'sendMessage').mockRejectedValue(new Error('Failed to fetch'));
  render(<Composer workbench={workbench} chat={chat} ops={sandboxOps(workbench)} todos={null} contextUsage={null} slashCommands={null} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message the agent' }), { target: { value: 'Check the cache' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send the message' }));
  });
  expect(useWorkbenchStore.getState().outgoingMessages['chat-1']).toEqual([
    expect.objectContaining({
      text: 'Check the cache',
      settledAt: undefined,
      failed: { error: 'Failed to fetch', input: expect.objectContaining({ text: 'Check the cache' }) },
    }),
  ]);
  expect(screen.getByRole('textbox', { name: 'Message the agent' })).toHaveValue('');
});

it('drops the staged prompt and restores the draft when a plan limit refuses it', async () => {
  vi.spyOn(api.workbenches, 'sendMessage').mockRejectedValue(new ApiError('Out of usage', 402, 'usage_exhausted'));
  render(<Composer workbench={workbench} chat={chat} ops={sandboxOps(workbench)} todos={null} contextUsage={null} slashCommands={null} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message the agent' }), { target: { value: 'Check the cache' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send the message' }));
  });
  expect(useWorkbenchStore.getState().outgoingMessages['chat-1']).toEqual([]);
  expect(screen.getByRole('textbox', { name: 'Message the agent' })).toHaveValue('Check the cache');
});

it('drops the pending copy of a queued message that is removed', () => {
  const queuedChat = { ...chat, status: 'running', queuedMessages: [{ id: 'q1', text: 'Check the cache', queuedAt: '2026-11-03T10:00:00Z' }] } as unknown as WorkbenchChat;
  useWorkbenchStore.getState().addOutgoingMessage('chat-1', { text: 'Check the cache', settled: true });
  useWorkbenchStore.getState().addOutgoingMessage('chat-1', { text: 'Something else', settled: true });
  const ops = { ...sandboxOps(workbench), removeQueued: vi.fn() };
  render(<Composer workbench={workbench} chat={queuedChat} ops={ops} todos={null} contextUsage={null} slashCommands={null} />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove the queued message' }));
  expect(ops.removeQueued).toHaveBeenCalledWith('chat-1', 'q1');
  expect(useWorkbenchStore.getState().outgoingMessages['chat-1']).toEqual([expect.objectContaining({ text: 'Something else' })]);
});
