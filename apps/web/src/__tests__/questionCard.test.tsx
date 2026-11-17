import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkbenchChat, WorkbenchEvent } from '@talyn/shared';
import { WorkbenchTranscript } from '../components/workbench/WorkbenchTranscript';
import type { WorkbenchOps } from '../lib/workbenchOps';
import { toast } from '../stores/toast';
import { useWorkbenchStore } from '../stores/workbenches';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));

afterEach(cleanup);
beforeEach(() => {
  seq = 0;
  useWorkbenchStore.setState({ outgoingMessages: {}, chatEvents: {} });
});

const CHAT = { id: 'c1', workbenchId: 'wb1', status: 'awaiting_input', agent: 'claude' } as WorkbenchChat;

let seq = 0;
function ev(turn: number, event: Record<string, unknown>): WorkbenchEvent {
  seq += 1;
  return { chatId: 'c1', seq, turn, event: { seq, ...event } } as WorkbenchEvent;
}
const userMsg = (turn: number, text: string, talyn?: Record<string, unknown>) =>
  ev(turn, { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, ...(talyn ? { talyn } : {}) });
const reply = (turn: number, text: string) =>
  ev(turn, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const askCall = (turn: number) =>
  ev(turn, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__talyn__talyn_ask_user', input: {} }] } });
const askResult = (turn: number) =>
  ev(turn, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Talyn shows your question.' }] } });
const ask = (turn: number, questions: unknown[]) => ev(turn, { type: 'talyn_question', id: `q${turn}`, questions });

const DATABASE = {
  question: 'Which database?',
  header: 'Database',
  options: [
    { label: 'Postgres', description: 'The default.' },
    { label: 'SQLite' },
  ],
};
const FEATURES = {
  question: 'Which features?',
  options: [{ label: 'Search' }, { label: 'Export' }, { label: 'Billing' }],
  multiSelect: true,
};

function makeOps(over: Partial<WorkbenchOps> = {}): WorkbenchOps {
  return { runtime: 'sandbox', unavailable: null, send: vi.fn(async () => ({ queued: false })), ...over } as unknown as WorkbenchOps;
}

function renderTranscript(events: WorkbenchEvent[], ops = makeOps(), chat = CHAT) {
  render(<WorkbenchTranscript chat={chat} events={events} loading={false} error={null} ops={ops} />);
  return ops;
}

describe('the question card', () => {
  it('shows the question, its header, its options and an Other field, and hides the tool call', () => {
    renderTranscript([userMsg(1, 'Add storage'), askCall(1), askResult(1), ask(1, [DATABASE])]);
    expect(screen.getByText('Question')).toBeInTheDocument();
    expect(screen.getByText('Database')).toBeInTheDocument();
    expect(screen.getByText('Which database?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Postgres/ })).toHaveTextContent('The default.');
    expect(screen.getByRole('button', { name: /SQLite/ })).toBeEnabled();
    expect(screen.getByLabelText('Other answer 1')).toBeInTheDocument();
    expect(screen.queryByText(/talyn_ask_user/)).toBeNull();
    expect(screen.queryByText(/Talyn shows your question/)).toBeNull();
  });

  it('sends a single-select answer at once when there is one question', async () => {
    const ops = renderTranscript([userMsg(1, 'Add storage'), ask(1, [DATABASE])]);
    fireEvent.click(screen.getByRole('button', { name: /SQLite/ }));
    await waitFor(() => expect(ops.send).toHaveBeenCalledWith(CHAT, { text: 'Which database?\n→ SQLite' }));
    // Only the Other field's own send button: no separate submit.
    expect(screen.getAllByRole('button', { name: /Send answer/ })).toHaveLength(1);
  });

  it('sends the Other answer with its own button', async () => {
    const ops = renderTranscript([userMsg(1, 'Add storage'), ask(1, [DATABASE])]);
    const send = screen.getByRole('button', { name: 'Send answer' });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Other answer 1'), { target: { value: 'MySQL' } });
    fireEvent.click(send);
    await waitFor(() => expect(ops.send).toHaveBeenCalledWith(CHAT, { text: 'Which database?\n→ MySQL' }));
  });

  it('needs an answer to every question before it sends', async () => {
    const ops = renderTranscript([userMsg(1, 'Add storage'), ask(1, [DATABASE, FEATURES])]);
    expect(screen.getByText('Questions')).toBeInTheDocument();
    const send = screen.getByRole('button', { name: /Send answers/ });
    expect(send).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: /Postgres/ }));
    expect(screen.getByRole('radio', { name: /Postgres/ })).toHaveAttribute('aria-checked', 'true');
    expect(ops.send).not.toHaveBeenCalled();
    expect(send).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Search' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Billing' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Search' }));
    expect(send).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Other answer 2'), { target: { value: 'Audit log' } });
    fireEvent.click(send);
    await waitFor(() =>
      expect(ops.send).toHaveBeenCalledWith(CHAT, { text: 'Which database?\n→ Postgres\n\nWhich features?\n→ Billing, Audit log' }),
    );
  });

  it('lets a single-select Other answer replace the picked option', async () => {
    const ops = renderTranscript([userMsg(1, 'Add storage'), ask(1, [DATABASE, FEATURES])]);
    fireEvent.click(screen.getByRole('radio', { name: /SQLite/ }));
    fireEvent.change(screen.getByLabelText('Other answer 1'), { target: { value: 'MySQL' } });
    expect(screen.getByRole('radio', { name: /SQLite/ })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Export' }));
    fireEvent.click(screen.getByRole('button', { name: /Send answers/ }));
    await waitFor(() =>
      expect(ops.send).toHaveBeenCalledWith(CHAT, { text: 'Which database?\n→ MySQL\n\nWhich features?\n→ Export' }),
    );
  });

  it('takes a free-text answer for a question with no options', async () => {
    const ops = renderTranscript([userMsg(1, 'Add storage'), ask(1, [{ question: 'What is the table name?' }])]);
    fireEvent.change(screen.getByLabelText('Your answer 1'), { target: { value: 'orders' } });
    fireEvent.click(screen.getByRole('button', { name: /Send answer/ }));
    await waitFor(() => expect(ops.send).toHaveBeenCalledWith(CHAT, { text: 'What is the table name?\n→ orders' }));
  });

  it('shows the options read-only while the chat runs', () => {
    renderTranscript([userMsg(1, 'Add storage'), ask(1, [DATABASE])], makeOps(), { ...CHAT, status: 'running' });
    expect(screen.getByText('Postgres')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Postgres/ })).toBeNull();
    expect(screen.queryByLabelText('Other answer 1')).toBeNull();
  });

  it('disables the options when the chat is unavailable', () => {
    renderTranscript([userMsg(1, 'Add storage'), ask(1, [DATABASE])], makeOps({ unavailable: 'The sandbox is offline.' }));
    expect(screen.getByRole('button', { name: /Postgres/ })).toBeDisabled();
    expect(screen.getByText('The sandbox is offline.')).toBeInTheDocument();
  });

  it('marks the question answered by the thread, and labels the thread message', () => {
    renderTranscript([
      userMsg(1, 'Add storage'),
      ask(1, [DATABASE]),
      userMsg(2, 'Which database?\n→ Postgres', { kind: 'user_message', sender: { kind: 'thread', threadId: 't1', name: 'Storage plan' } }),
      reply(2, 'Using Postgres.'),
    ]);
    expect(screen.getByText('Answered by thread Storage plan')).toBeInTheDocument();
    expect(screen.getByText('From thread Storage plan')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Postgres/ })).toBeNull();
  });

  it('marks the question answered when the person replied', () => {
    renderTranscript([userMsg(1, 'Add storage'), ask(1, [DATABASE]), userMsg(2, 'Postgres'), reply(2, 'OK.')]);
    expect(screen.getByText('Answered')).toBeInTheDocument();
    expect(screen.queryByText(/From thread/)).toBeNull();
  });

  it('shows a toast when the answer cannot be sent', async () => {
    const errorToast = vi.spyOn(toast, 'error').mockImplementation(() => 'toast');
    const ops = makeOps({ send: vi.fn(async () => Promise.reject(new Error('Down'))) });
    renderTranscript([userMsg(1, 'Add storage'), ask(1, [DATABASE])], ops);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Postgres/ }));
    });
    expect(errorToast).toHaveBeenCalledWith('Could not send the answer', 'Down');
    expect(screen.getByRole('button', { name: /Postgres/ })).toBeEnabled();
    errorToast.mockRestore();
  });
});
