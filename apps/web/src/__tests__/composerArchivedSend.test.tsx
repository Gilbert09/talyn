import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { ARCHIVED_ATTACH_REFUSAL, Composer, restoresOnSend } from '../components/workbench/Composer';
import { sandboxOps } from '../lib/workbenchOps';
import { api } from '../lib/api';
import { toast } from '../stores/toast';
import { useWorkbenchStore } from '../stores/workbenches';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));

const archived = {
  id: 'wb-1',
  workspaceId: 'ws-1',
  runtime: 'sandbox',
  status: 'archived',
  sandboxId: 'box-1',
  sandboxState: 'deleted',
  archivedAt: '2026-11-20T10:00:00Z',
  agent: 'claude',
  settings: {},
} as unknown as Workbench;

const restored = {
  ...archived,
  status: 'provisioning',
  sandboxState: 'creating',
  archivedAt: null,
} as unknown as Workbench;

const chat = { id: 'chat-1', workbenchId: 'wb-1', status: 'idle', queuedMessages: [] } as unknown as WorkbenchChat;

function renderComposer(workbench: Workbench = archived) {
  render(<Composer workbench={workbench} chat={chat} ops={sandboxOps(workbench)} todos={null} contextUsage={null} slashCommands={null} />);
  return screen.getByRole('textbox', { name: 'Message the agent' });
}

function send(box: HTMLElement, text: string) {
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
}

beforeEach(() => {
  useWorkbenchStore.setState({ outgoingMessages: {}, drafts: {}, chatEvents: {}, extraWorkbenchIds: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('restoresOnSend', () => {
  it.each([
    ['archived status, owner', { status: 'archived' }, true, true],
    ['archivedAt set, owner', { status: 'ready', archivedAt: '2026-11-20T10:00:00Z' }, true, true],
    ['archived, not the owner', { status: 'archived' }, false, false],
    ['archived local session', { status: 'archived', runtime: 'local' }, true, false],
    ['live session', { status: 'ready', archivedAt: null }, true, false],
    ['provisioning session', { status: 'provisioning', archivedAt: null }, true, false],
    ['error session', { status: 'error', archivedAt: null }, true, false],
  ])('%s', (_name, patch, owner, expected) => {
    expect(restoresOnSend({ ...archived, ...patch } as Workbench, owner)).toBe(expected);
  });
});

describe('an archived session', () => {
  it('keeps the composer open for the owner and says a send restores it', () => {
    const box = renderComposer();
    expect(box).toBeEnabled();
    expect(box).toHaveAttribute('placeholder', 'This session is archived. Send a message to restore it.');
  });

  it('hides the attach button and tells the owner to send a message before a file', () => {
    const error = vi.spyOn(toast, 'error');
    const attach = vi.spyOn(api.workbenches, 'uploadAttachment');
    const box = renderComposer();
    expect(screen.queryByRole('button', { name: /^Attach/ })).not.toBeInTheDocument();

    const file = new File(['png'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(box, { clipboardData: { items: [{ kind: 'file', getAsFile: () => file }] } });

    expect(error).toHaveBeenCalledWith('Could not attach the file', ARCHIVED_ATTACH_REFUSAL);
    expect(attach).not.toHaveBeenCalled();
  });

  it('keeps the attach button for a live session', () => {
    renderComposer({ ...archived, status: 'ready', sandboxState: 'running', archivedAt: null } as unknown as Workbench);
    expect(screen.getByRole('button', { name: /^Attach/ })).toBeInTheDocument();
  });

  it('keeps the composer closed for a teammate', () => {
    useWorkbenchStore.setState({ extraWorkbenchIds: { 'wb-1': true } });
    const box = renderComposer();
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute('placeholder', 'This session is archived.');
  });

  it('restores the session, then sends the message', async () => {
    const calls: string[] = [];
    const restore = vi.spyOn(api.workbenches, 'restore').mockImplementation(async () => {
      calls.push('restore');
      return restored;
    });
    const sendMessage = vi.spyOn(api.workbenches, 'sendMessage').mockImplementation(async () => {
      calls.push('send');
      return { queued: true } as never;
    });
    const info = vi.spyOn(toast, 'info');
    const box = renderComposer();

    send(box, 'Pick this up again');

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(restore).toHaveBeenCalledWith('wb-1');
    expect(calls).toEqual(['restore', 'send']);
    expect(sendMessage).toHaveBeenCalledWith('chat-1', expect.objectContaining({ text: 'Pick this up again' }));
    expect(useWorkbenchStore.getState().workbenches['wb-1']).toMatchObject({ status: 'provisioning', archivedAt: null });
    await waitFor(() => expect(info).toHaveBeenCalledWith('Queued', 'It runs when the sandbox is ready.'));
  });

  it('blocks typing while the restore runs, so no typed text is lost', async () => {
    let finish!: (value: Workbench) => void;
    vi.spyOn(api.workbenches, 'restore').mockReturnValue(new Promise<Workbench>((resolve) => { finish = resolve; }) as never);
    const sendMessage = vi.spyOn(api.workbenches, 'sendMessage').mockResolvedValue({ queued: true } as never);
    const box = renderComposer();

    send(box, 'Pick this up again');

    await waitFor(() => expect(box).toBeDisabled());
    expect(box).toHaveValue('Pick this up again');
    expect(sendMessage).not.toHaveBeenCalled();
    await act(async () => finish(restored));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(box).toBeEnabled();
  });

  it('keeps the draft and sends nothing when the restore fails', async () => {
    vi.spyOn(api.workbenches, 'restore').mockRejectedValue(new Error('No box is free.'));
    const sendMessage = vi.spyOn(api.workbenches, 'sendMessage');
    const error = vi.spyOn(toast, 'error');
    const box = renderComposer();

    send(box, 'Pick this up again');

    await waitFor(() => expect(error).toHaveBeenCalledWith('Could not restore the session', 'No box is free.'));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(box).toHaveValue('Pick this up again');
    expect(useWorkbenchStore.getState().outgoingMessages['chat-1'] ?? []).toHaveLength(0);
  });

  it('does not restore a live session before a send', async () => {
    const live = { ...archived, status: 'ready', sandboxState: 'running', archivedAt: null } as unknown as Workbench;
    const restore = vi.spyOn(api.workbenches, 'restore');
    const sendMessage = vi.spyOn(api.workbenches, 'sendMessage').mockResolvedValue({ queued: false } as never);
    const box = renderComposer(live);

    send(box, 'Next step');

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(restore).not.toHaveBeenCalled();
  });
});
