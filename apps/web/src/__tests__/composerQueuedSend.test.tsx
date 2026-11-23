import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench, WorkbenchChat, WorkbenchQueuedMessage } from '@talyn/shared';
import { Composer } from '../components/workbench/Composer';
import { WorkbenchTranscript } from '../components/workbench/WorkbenchTranscript';
import { sandboxOps } from '../lib/workbenchOps';
import { api } from '../lib/api';
import { useWorkbenchStore } from '../stores/workbenches';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));

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

const chatWith = (status: WorkbenchChat['status'], queuedMessages: WorkbenchQueuedMessage[] = []) =>
  ({ id: 'chat-1', workbenchId: 'wb-1', status, queuedMessages }) as unknown as WorkbenchChat;

const queuedMessage = (text: string): WorkbenchQueuedMessage =>
  ({ id: 'q-1', text, queuedAt: new Date().toISOString() }) as WorkbenchQueuedMessage;

function Chat({ chat }: { chat: WorkbenchChat }) {
  const ops = sandboxOps(workbench);
  return (
    <>
      <WorkbenchTranscript chat={chat} events={[]} loading={false} error={null} ops={ops} />
      <Composer workbench={workbench} chat={chat} ops={ops} todos={null} contextUsage={null} slashCommands={null} />
    </>
  );
}

function send(text: string) {
  const box = screen.getByRole('textbox', { name: 'Message the agent' });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
}

const bubble = (text: string) => screen.queryAllByText(text).filter((el) => !el.closest('[data-attr="workbench-queuing-message"]'));
const queuingChip = (text: string) => screen.queryAllByText(text).filter((el) => el.closest('[data-attr="workbench-queuing-message"]'));

beforeEach(() => {
  useWorkbenchStore.setState({ outgoingMessages: {}, drafts: {}, chatEvents: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('shows a message sent during a running turn as queued, never in the transcript', async () => {
  let finish!: (value: { queued: boolean }) => void;
  vi.spyOn(api.workbenches, 'sendMessage').mockReturnValue(new Promise((resolve) => { finish = resolve; }) as never);
  const view = render(<Chat chat={chatWith('running')} />);

  send('Also fix the tests');
  // In flight: queued in the composer, not a bubble in the transcript.
  await waitFor(() => expect(queuingChip('Also fix the tests')).toHaveLength(1));
  expect(bubble('Also fix the tests')).toHaveLength(0);

  // The send returns before the chat update lists the queue.
  await act(async () => finish({ queued: true }));
  expect(queuingChip('Also fix the tests')).toHaveLength(1);
  expect(bubble('Also fix the tests')).toHaveLength(0);

  // The chat's queue lists it: one queued row, from the chat.
  view.rerender(<Chat chat={chatWith('running', [queuedMessage('Also fix the tests')])} />);
  expect(queuingChip('Also fix the tests')).toHaveLength(0);
  expect(screen.getAllByText('Also fix the tests')).toHaveLength(1);
});

it('moves a message to the transcript when the send says the turn already ended', async () => {
  vi.spyOn(api.workbenches, 'sendMessage').mockResolvedValue({ queued: false } as never);
  render(<Chat chat={chatWith('running')} />);

  send('Also fix the tests');
  await waitFor(() => expect(bubble('Also fix the tests')).toHaveLength(1));
  expect(queuingChip('Also fix the tests')).toHaveLength(0);
});

it('shows a message sent to an idle chat in the transcript at once', async () => {
  vi.spyOn(api.workbenches, 'sendMessage').mockReturnValue(new Promise(() => undefined) as never);
  render(<Chat chat={chatWith('idle')} />);

  send('Fix the login');
  await waitFor(() => expect(bubble('Fix the login')).toHaveLength(1));
  expect(queuingChip('Fix the login')).toHaveLength(0);
});

it('queues behind a waiting queue even when no turn runs', async () => {
  vi.spyOn(api.workbenches, 'sendMessage').mockReturnValue(new Promise(() => undefined) as never);
  render(<Chat chat={chatWith('idle', [queuedMessage('First')])} />);

  send('Second');
  await waitFor(() => expect(queuingChip('Second')).toHaveLength(1));
  expect(bubble('Second')).toHaveLength(0);
});
