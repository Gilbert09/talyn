/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentEvent, WorkbenchChat, WorkbenchEvent } from '@talyn/shared';
import { WorkbenchTranscript, type OlderHistory } from '../renderer/components/workbench/WorkbenchTranscript';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';
import { toast } from '../renderer/stores/toast';
import { useWorkbenchStore } from '../renderer/stores/workbenches';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));

const chat = { id: 'c1', workbenchId: 'wb1', status: 'idle' } as WorkbenchChat;
const ops = { unavailable: null } as unknown as WorkbenchOps;

beforeEach(() => useWorkbenchStore.setState({ outgoingMessages: {} }));

const userEvent = (seq: number, turn: number): WorkbenchEvent => ({
  chatId: 'c1',
  seq,
  turn,
  event: { seq, type: 'user', message: { role: 'user', content: [{ type: 'text', text: `message ${turn}` }] } } as AgentEvent,
});

/** One user message per turn, seqs counting from `first`. */
const turns = (first: number, count: number) => Array.from({ length: count }, (_, i) => userEvent(first + i, first + i));

const older = (over: Partial<OlderHistory> = {}): OlderHistory => ({
  hasOlder: true,
  loading: false,
  error: null,
  load: jest.fn(),
  ...over,
});

/** jsdom lays nothing out, so the scroll box gets a scripted geometry. */
function geometry(el: HTMLElement, box: { height: number; client: number; top: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box.client });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => box.top,
    set: (v: number) => {
      box.top = v;
    },
  });
  return box;
}

const scroller = (container: HTMLElement) => container.querySelector('.overflow-auto') as HTMLElement;

function setup(events: WorkbenchEvent[], o: OlderHistory) {
  const view = render(<WorkbenchTranscript chat={chat} events={events} loading={false} error={null} ops={ops} older={o} />);
  const box = geometry(scroller(view.container), { height: 2000, client: 500, top: 1500 });
  const rerender = (next: WorkbenchEvent[], nextOlder: OlderHistory = o) =>
    view.rerender(<WorkbenchTranscript chat={chat} events={next} loading={false} error={null} ops={ops} older={nextOlder} />);
  return { ...view, box, rerender };
}

it('shows an outgoing prompt while its request is in flight', () => {
  useWorkbenchStore.getState().addOutgoingMessage('c1', {
    id: 'outgoing-1',
    text: 'Check the cache',
    attachments: [],
  });
  render(<WorkbenchTranscript chat={chat} events={[]} loading={false} error={null} ops={ops} />);
  expect(screen.getByText('Check the cache')).toBeInTheDocument();
  expect(screen.getByText('Sending…')).toBeInTheDocument();
  expect(screen.queryByText('Send a message to start.')).not.toBeInTheDocument();
});

it('asks for older events when the scroll comes near the top', () => {
  const o = older();
  const { container, box } = setup(turns(10, 3), o);
  (o.load as jest.Mock).mockClear();
  box.top = 1000;
  fireEvent.scroll(scroller(container));
  expect(o.load).not.toHaveBeenCalled();
  box.top = 100;
  fireEvent.scroll(scroller(container));
  expect(o.load).toHaveBeenCalledTimes(1);
});

it.each([
  ['nothing is older', { hasOlder: false }],
  ['a load is running', { loading: true }],
  ['the last load failed', { error: 'timeout' }],
])('does not ask when %s', (_name, over) => {
  const o = older(over);
  const { container, box } = setup(turns(10, 3), o);
  box.top = 0;
  fireEvent.scroll(scroller(container));
  expect(o.load).not.toHaveBeenCalled();
});

it('asks at once when the first page does not fill the view', () => {
  const o = older();
  render(<WorkbenchTranscript chat={chat} events={turns(10, 1)} loading={false} error={null} ops={ops} older={o} />);
  // jsdom reports a zero-height box: the content fits, the top is in view.
  expect(o.load).toHaveBeenCalled();
});

it('keeps the view still when an older page lands above it', () => {
  const o = older();
  const { container, box, rerender } = setup(turns(10, 3), o);
  box.top = 600;
  fireEvent.scroll(scroller(container));
  box.height = 2900;
  act(() => rerender([...turns(5, 5), ...turns(10, 3)]));
  expect(box.top).toBe(600 + 900);
});

it('stays at the bottom for a live event, wherever the older pages are', () => {
  const o = older({ hasOlder: false });
  const { box, rerender } = setup(turns(10, 3), o);
  box.height = 2300;
  act(() => rerender([...turns(10, 3), userEvent(13, 13)]));
  expect(box.top).toBe(2300);
});

it.each([
  ['a running load', older({ loading: true }), /Loading earlier messages/],
  ['a failed load', older({ error: 'timeout' }), /Could not load earlier messages/],
])('shows %s above the oldest turn', (_name, o, text) => {
  render(<WorkbenchTranscript chat={chat} events={turns(10, 2)} loading={false} error={null} ops={ops} older={o} />);
  expect(screen.getByText(text)).toBeInTheDocument();
});

it('retries a failed load from its row', () => {
  const o = older({ error: 'timeout' });
  render(<WorkbenchTranscript chat={chat} events={turns(10, 2)} loading={false} error={null} ops={ops} older={o} />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(o.load).toHaveBeenCalledTimes(1);
});

it('shows no paging row and full totals when the whole chat is loaded', () => {
  const result = (seq: number): WorkbenchEvent => ({
    chatId: 'c1', seq, turn: 1, event: { seq, type: 'result', total_cost_usd: 0.5, usage: {} } as AgentEvent,
  });
  const { rerender } = render(
    <WorkbenchTranscript chat={chat} events={[userEvent(1, 1), result(2)]} loading={false} error={null} ops={ops} older={older({ hasOlder: false })} />
  );
  expect(screen.queryByText(/earlier messages/)).not.toBeInTheDocument();
  expect(screen.getByText(/^1 turn$/)).toBeInTheDocument();
  rerender(
    <WorkbenchTranscript chat={chat} events={[userEvent(1, 1), result(2)]} loading={false} error={null} ops={ops} older={older({ loading: true })} />
  );
  expect(screen.getByText(/Last 1 turn/)).toBeInTheDocument();
});

it.each(['The agent stopped unexpectedly.', 'The tool connection failed.'])('shows an error result message: %s', (message) => {
  const events: WorkbenchEvent[] = [userEvent(1, 1), {
    chatId: 'c1', seq: 2, turn: 1,
    event: { seq: 2, type: 'result', is_error: true, result: message, subtype: 'error_during_execution' } as AgentEvent,
  }];
  render(<WorkbenchTranscript chat={chat} events={events} loading={false} error={null} ops={ops} />);
  expect(screen.getByText(message)).toBeInTheDocument();
});

const errorResult = (seq: number, turn: number, result = 'API 429'): WorkbenchEvent => ({
  chatId: 'c1', seq, turn,
  event: { seq, type: 'result', is_error: true, result, subtype: 'error_during_execution' } as AgentEvent,
});

const retryButton = () => document.querySelector('[data-attr="turn-retry"]') as HTMLButtonElement | null;

it('shows Retry under only the last error result of an idle chat', () => {
  render(<WorkbenchTranscript chat={chat} events={[userEvent(1, 1), errorResult(2, 1, 'old'), userEvent(3, 2), errorResult(4, 2)]}
    loading={false} error={null} ops={ops} />);
  expect(screen.getAllByText('Ended with error')).toHaveLength(2);
  expect(document.querySelectorAll('[data-attr="turn-retry"]')).toHaveLength(1);
  expect(retryButton()?.previousElementSibling).toHaveTextContent('API 429');
});

it.each([
  ['a running chat', { status: 'running' } as Partial<WorkbenchChat>, undefined],
  ['a queued message', { queuedMessages: [{ id: 'q1' }] } as unknown as Partial<WorkbenchChat>, undefined],
  ['a failed session', {}, false],
])('hides Retry for %s', (_name, patch, canRetry) => {
  render(<WorkbenchTranscript chat={{ ...chat, ...patch }} events={[userEvent(1, 1), errorResult(2, 1)]}
    loading={false} error={null} ops={ops} canRetry={canRetry} />);
  expect(retryButton()).not.toBeInTheDocument();
});

it('hides Retry when a later turn followed the error', () => {
  render(<WorkbenchTranscript chat={chat} events={[userEvent(1, 1), errorResult(2, 1), userEvent(3, 2)]}
    loading={false} error={null} ops={ops} />);
  expect(retryButton()).not.toBeInTheDocument();
});

it('hides Retry for a cancelled turn', () => {
  const cancelled = { ...errorResult(2, 1), event: { ...errorResult(2, 1).event, subtype: 'cancelled' } as AgentEvent };
  render(<WorkbenchTranscript chat={chat} events={[userEvent(1, 1), cancelled]}
    loading={false} error={null} ops={ops} />);
  expect(retryButton()).not.toBeInTheDocument();
});

it('does not add Retry to a thread session failure card', () => {
  const threadFailure: WorkbenchEvent = {
    chatId: 'c1', seq: 2, turn: 1,
    event: { seq: 2, type: 'talyn_thread', action: 'session_finished', sessionId: 's1', name: 'Fix', repo: 'owner/repo', status: 'error' } as AgentEvent,
  };
  render(<WorkbenchTranscript chat={chat} events={[userEvent(1, 1), threadFailure]}
    loading={false} error={null} ops={ops} />);
  expect(screen.getByText(/stopped with an error/)).toBeInTheDocument();
  expect(retryButton()).not.toBeInTheDocument();
});

it('sends the retry message once and disables Retry while sending', async () => {
  let resolveSend!: (value: { queued: boolean }) => void;
  const send = jest.fn(() => new Promise<{ queued: boolean }>((resolve) => { resolveSend = resolve; }));
  const reason = `  ${'x'.repeat(310)}  `;
  render(<WorkbenchTranscript chat={chat} events={[userEvent(1, 1), errorResult(2, 1, reason)]}
    loading={false} error={null} ops={{ ...ops, send }} />);
  fireEvent.click(retryButton()!);
  expect(retryButton()).toBeDisabled();
  fireEvent.click(retryButton()!);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(chat, { text: `Continue from where you stopped. The last turn ended with an error: ${'x'.repeat(300)}.` });
  await act(async () => resolveSend({ queued: false }));
  await waitFor(() => expect(retryButton()).not.toBeDisabled());
});

it('shows a toast when Retry fails', async () => {
  const errorToast = jest.spyOn(toast, 'error').mockImplementation(() => 'toast');
  const send = jest.fn().mockRejectedValue(new Error('offline'));
  render(<WorkbenchTranscript chat={chat} events={[userEvent(1, 1), errorResult(2, 1)]}
    loading={false} error={null} ops={{ ...ops, send }} />);
  fireEvent.click(retryButton()!);
  await waitFor(() => expect(errorToast).toHaveBeenCalledWith('Could not retry the turn', 'offline'));
  expect(retryButton()).not.toBeDisabled();
  errorToast.mockRestore();
});

it.each(['[Request interrupted by user]', '[Request interrupted by user for tool use]'])(
  'shows a quiet interruption instead of a user bubble for %s', (marker) => {
    const events: WorkbenchEvent[] = [userEvent(1, 1), {
      chatId: 'c1', seq: 2, turn: 2,
      event: { seq: 2, type: 'user', message: { role: 'user', content: [{ type: 'text', text: marker }] } } as AgentEvent,
    }, {
      chatId: 'c1', seq: 3, turn: 3,
      event: { seq: 3, type: 'user', message: { role: 'user', content: [{ type: 'text', text: marker }] } } as AgentEvent,
    }];
    render(<WorkbenchTranscript chat={chat} events={events} loading={false} error={null} ops={ops} />);
    expect(screen.queryByText(marker)).not.toBeInTheDocument();
    expect(screen.getAllByText('Interrupted')).toHaveLength(1);
    expect(screen.getByText('Interrupted')).toHaveClass('text-muted-foreground');
  },
);

it('shows an interruption system block as a quiet note without its subtype', () => {
  const events: WorkbenchEvent[] = [userEvent(1, 1), {
    chatId: 'c1', seq: 2, turn: 1,
    event: { seq: 2, type: 'system', subtype: 'talyn_interruption', text: 'Interrupted' } as AgentEvent,
  }];
  const { container } = render(<WorkbenchTranscript chat={chat} events={events} loading={false} error={null} ops={ops} />);
  expect(screen.getByText('Interrupted')).toHaveClass('text-xs', 'text-muted-foreground');
  expect(screen.getByText('Interrupted')).not.toHaveClass('border-l-2');
  expect(container).not.toHaveTextContent('TALYN_INTERRUPTION');
});

it('shows a stopped tool without its canned rejection text', () => {
  const rejection = "The user doesn't want to proceed with this tool use. STOP what you are doing.";
  const events: WorkbenchEvent[] = [userEvent(1, 1), {
    chatId: 'c1', seq: 2, turn: 1,
    event: { seq: 2, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Edit', input: { file_path: 'a.ts' } }] } } as AgentEvent,
  }, {
    chatId: 'c1', seq: 3, turn: 1,
    event: { seq: 3, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: rejection, is_error: true }] } } as AgentEvent,
  }];
  render(<WorkbenchTranscript chat={chat} events={events} loading={false} error={null} ops={ops} />);
  expect(screen.getByText('edit')).toBeInTheDocument();
  expect(screen.getByText('stopped')).toHaveClass('text-muted-foreground');
  expect(screen.getByText('Interrupted')).toHaveClass('text-muted-foreground');
  expect(screen.queryByText(rejection)).not.toBeInTheDocument();
});

it.each([
  ['restoring', 'Restoring the sandbox…', 'Working…'],
  [null, 'Working…', 'Restoring the sandbox…'],
  [undefined, 'Working…', 'Restoring the sandbox…'],
] as const)('shows the right spinner text for phase %s', (phase, shown, hidden) => {
  const running = { id: 'c1', workbenchId: 'wb1', status: 'running', phase } as WorkbenchChat;
  render(<WorkbenchTranscript chat={running} events={[]} loading={false} error={null} ops={{ unavailable: null } as unknown as WorkbenchOps} />);
  expect(screen.getByText(shown)).toBeInTheDocument();
  expect(screen.queryByText(hidden)).not.toBeInTheDocument();
  if (phase === 'restoring') expect(screen.getByText(/after a long idle/)).toBeInTheDocument();
  else expect(screen.queryByText(/after a long idle/)).not.toBeInTheDocument();
});

it.each(['No sandbox became free in 30 minutes', 'The sandbox did not wake in 30 minutes'])('hides Retry when the 30-minute wait ended: %s', (message) => {
  render(<WorkbenchTranscript chat={chat} events={[userEvent(1, 1), errorResult(2, 1, message)]} loading={false} error={null} ops={ops} />);
  expect(screen.getByText('Ended with error')).toBeInTheDocument();
  expect(retryButton()).not.toBeInTheDocument();
});

it.each(['API 429', 'The sandbox stopped', 'No sandbox was found'])('keeps Retry for another error: %s', (message) => {
  render(<WorkbenchTranscript chat={chat} events={[userEvent(1, 1), errorResult(2, 1, message)]} loading={false} error={null} ops={ops} />);
  expect(retryButton()).toBeInTheDocument();
});

it('shows the wait and lets the user resume now', async () => {
  const send = jest.fn(async () => ({ queued: false }));
  const waiting = { ...chat, status: 'error', resumeAt: '2026-11-06T13:10:00Z', resumeReason: 'The agent reached its limit' } as WorkbenchChat;
  render(<WorkbenchTranscript chat={waiting} events={[userEvent(1, 1), errorResult(2, 1)]}
    loading={false} error={null} ops={{ ...ops, send }} />);
  expect(screen.getByText(/Waiting for usage. Resumes at/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Resume now' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(waiting, {
    text: 'Continue from where you stopped. The last turn ended with an error: The agent reached its limit.',
  }));
});

// ---------------------------------------------------------------------------
// Tool rows: diffs, groups, failures
// ---------------------------------------------------------------------------

type Piece =
  | { use: string; name: string; input: Record<string, unknown> }
  | { result: string; content: string; error?: boolean }
  | { thinking: string };

/** One user message, then the pieces as consecutive events of turn 1. */
function toolTurn(pieces: Piece[]): WorkbenchEvent[] {
  const out: WorkbenchEvent[] = [userEvent(1, 1)];
  pieces.forEach((p, i) => {
    const seq = i + 2;
    const event =
      'use' in p
        ? { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: p.use, name: p.name, input: p.input }] } }
        : 'result' in p
          ? { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: p.result, content: p.content, is_error: p.error ?? false }] } }
          : { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: p.thinking }] } };
    out.push({ chatId: 'c1', seq, turn: 1, event: { seq, ...event } as unknown as AgentEvent });
  });
  return out;
}

const renderEvents = (events: WorkbenchEvent[]) =>
  render(<WorkbenchTranscript chat={chat} events={events} loading={false} error={null} ops={ops} />);
const renderTurn = (pieces: Piece[]) => renderEvents(toolTurn(pieces));

const call = (id: string, name: string, input: Record<string, unknown>, content = 'ok', error = false): Piece[] => [
  { use: id, name, input },
  { result: id, content, error },
];

describe('edit rows', () => {
  it('shows +N −M and expands to the diff lines', () => {
    renderTurn(
      call('t1', 'Edit', { file_path: 'src/a.ts', old_string: 'keep\nold line', new_string: 'keep\nnew line\nextra line' }, 'The file src/a.ts has been updated successfully.'),
    );
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByText('−1')).toBeInTheDocument();
    expect(screen.queryByText(/updated successfully/)).not.toBeInTheDocument();
    expect(screen.queryByText('new line')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('new line').parentElement).toHaveClass('bg-success/10');
    expect(screen.getByText('old line').parentElement).toHaveClass('bg-destructive/10');
    expect(screen.getByText('keep').parentElement).toHaveClass('text-muted-foreground');
  });

  it('collapses a large diff behind a Show more toggle', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `row ${i}`).join('\n');
    renderTurn(call('t1', 'Write', { file_path: 'big.ts', content: lines }));
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('row 11')).toBeInTheDocument();
    expect(screen.queryByText('row 12')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show 8 more lines' }));
    expect(screen.getByText('row 19')).toBeInTheDocument();
  });

  it('still shows the error of a failed edit', () => {
    renderTurn(call('t1', 'Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }, 'String to replace not found', true));
    expect(screen.getByText('String to replace not found')).toBeInTheDocument();
  });

  it.each([
    ['add', 'A'],
    ['update', 'M'],
    ['delete', 'D'],
  ])('shows a %s badge for a Codex per-file edit', (kind, badge) => {
    renderTurn(call('t1', 'Edit', { file_path: 'src/a.ts', kind }, ''));
    expect(screen.getByText(badge)).toBeInTheDocument();
    expect(screen.queryByText(/^\+\d/)).not.toBeInTheDocument();
  });
});

describe('tool groups', () => {
  const groupButton = () => screen.getAllByRole('button').find((b) => b.hasAttribute('aria-expanded')) as HTMLElement;

  it('stays closed and counts a failure that is not the last call', () => {
    renderTurn([
      ...call('t1', 'Bash', { command: 'npm test' }, 'boom', true),
      ...call('t2', 'Read', { file_path: 'a.ts' }, 'contents'),
    ]);
    expect(groupButton()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('· 1 failed')).toHaveClass('text-destructive');
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
  });

  it('opens when the last call failed and the transcript ends there', () => {
    renderTurn([
      ...call('t1', 'Read', { file_path: 'a.ts' }, 'contents'),
      ...call('t2', 'Bash', { command: 'npm test' }, 'boom', true),
    ]);
    expect(groupButton()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('stays closed when prose follows the failed call', () => {
    const events = toolTurn([
      ...call('t1', 'Read', { file_path: 'a.ts' }, 'contents'),
      ...call('t2', 'Bash', { command: 'npm test' }, 'boom', true),
    ]);
    events.push({
      chatId: 'c1', seq: 20, turn: 1,
      event: { seq: 20, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I will try again.' }] } } as unknown as AgentEvent,
    });
    renderEvents(events);
    expect(groupButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows thinking between calls as a Thought line inside the group', () => {
    renderTurn([
      ...call('t1', 'Read', { file_path: 'a.ts' }),
      { thinking: 'The file looks fine so I will search next.' },
      ...call('t2', 'Grep', { pattern: 'foo' }),
    ]);
    expect(screen.queryByText('Thought')).not.toBeInTheDocument();
    fireEvent.click(groupButton());
    fireEvent.click(screen.getByText('Thought'));
    expect(screen.getByText('The file looks fine so I will search next.')).toBeInTheDocument();
  });
});

it('renders a Bash search command as a search row', () => {
  renderTurn(call('t1', 'Bash', { command: "bash -lc 'rg foo'" }, 'src/a.ts:1:foo'));
  expect(screen.getByText('grep')).toBeInTheDocument();
  expect(screen.getByText('foo')).toBeInTheDocument();
  expect(screen.queryByText('bash')).not.toBeInTheDocument();
});

it('does not render a lone todo tool', () => {
  renderTurn(call('t1', 'TodoWrite', { todos: [{ content: 'x', status: 'pending' }] }));
  expect(screen.queryByText('todo')).not.toBeInTheDocument();
});
