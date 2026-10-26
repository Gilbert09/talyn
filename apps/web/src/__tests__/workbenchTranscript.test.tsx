import { afterEach, expect, it, vi, type Mock } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentEvent, WorkbenchChat, WorkbenchEvent } from '@talyn/shared';
import { WorkbenchTranscript, type OlderHistory } from '../components/workbench/WorkbenchTranscript';
import type { WorkbenchOps } from '../lib/workbenchOps';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));

afterEach(cleanup);

const chat = { id: 'c1', workbenchId: 'wb1', status: 'idle' } as WorkbenchChat;
const ops = { unavailable: null } as unknown as WorkbenchOps;

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
  load: vi.fn(),
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

it('asks for older events when the scroll comes near the top', () => {
  const o = older();
  const { container, box } = setup(turns(10, 3), o);
  (o.load as Mock).mockClear();
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
