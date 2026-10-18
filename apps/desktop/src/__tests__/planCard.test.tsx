/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PLAN_APPROVED_MESSAGE, type WorkbenchChat, type WorkbenchEvent } from '@talyn/shared';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';
import { FOCUS_COMPOSER_EVENT } from '../renderer/lib/shortcuts';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { WorkbenchTranscript } from '../renderer/components/workbench/WorkbenchTranscript';

const mockUpdateChat = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: { workbenches: { updateChat: (...a: unknown[]) => mockUpdateChat(...a) } },
}));
jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/stores/toast', () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }));

const CHAT = { id: 'c1', workbenchId: 'wb1', status: 'idle', planMode: true, agent: 'claude' } as WorkbenchChat;
const PLAN = '1. Add the route.\n2. Test it.';

let seq = 0;
function ev(turn: number, event: Record<string, unknown>): WorkbenchEvent {
  seq += 1;
  return { chatId: 'c1', seq, turn, event: { seq, ...event } } as WorkbenchEvent;
}
const userMsg = (turn: number, text: string) => ev(turn, { type: 'talyn_user_message', text });
const reply = (turn: number, text: string) =>
  ev(turn, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const planReply = (turn: number) => reply(turn, `Here is my plan.\n\n\`\`\`talyn-plan\n${PLAN}\n\`\`\``);

function makeOps(over: Partial<WorkbenchOps> = {}): WorkbenchOps {
  return { runtime: 'sandbox', unavailable: null, send: jest.fn(async () => ({ queued: false })), ...over } as unknown as WorkbenchOps;
}

function renderTranscript(events: WorkbenchEvent[], ops = makeOps(), chat = CHAT) {
  render(<WorkbenchTranscript chat={chat} events={events} loading={false} error={null} ops={ops} />);
  return ops;
}

describe('the plan card', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seq = 0;
    mockUpdateChat.mockImplementation(async (id: string, patch: Partial<WorkbenchChat>) => ({ ...CHAT, id, ...patch }));
    useWorkbenchStore.getState().setChats('wb1', [CHAT]);
  });

  it('draws the plan as a card, and the prose without the block', () => {
    renderTranscript([userMsg(1, 'Plan the route'), planReply(1)]);
    expect(screen.getByText('Here is my plan.')).toBeInTheDocument();
    expect(screen.getByText(/Add the route/)).toBeInTheDocument();
    expect(screen.queryByText(/talyn-plan/)).toBeNull();
    expect(screen.getByRole('button', { name: /Approve and build/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Keep planning' })).toBeEnabled();
  });

  it('Approve and build turns plan mode off and sends the approval', async () => {
    const ops = renderTranscript([userMsg(1, 'Plan the route'), planReply(1)]);
    fireEvent.click(screen.getByRole('button', { name: /Approve and build/ }));
    await waitFor(() => expect(ops.send).toHaveBeenCalledWith(CHAT, { text: PLAN_APPROVED_MESSAGE, planMode: false }));
    expect(mockUpdateChat).toHaveBeenCalledWith('c1', { planMode: false });
    await waitFor(() => expect(useWorkbenchStore.getState().chats.wb1?.[0]?.planMode).toBe(false));
  });

  it('Keep planning focuses the composer and leaves plan mode on', () => {
    const onFocus = jest.fn();
    window.addEventListener(FOCUS_COMPOSER_EVENT, onFocus);
    const ops = renderTranscript([userMsg(1, 'Plan the route'), planReply(1)]);
    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }));
    window.removeEventListener(FOCUS_COMPOSER_EVENT, onFocus);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(ops.send).not.toHaveBeenCalled();
    expect(mockUpdateChat).not.toHaveBeenCalled();
  });

  it('Keep planning turns plan mode back on when it was switched off', () => {
    renderTranscript([userMsg(1, 'Plan the route'), planReply(1)], makeOps(), { ...CHAT, planMode: false });
    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }));
    expect(mockUpdateChat).toHaveBeenCalledWith('c1', { planMode: true });
  });

  it('disables Approve while the turn runs', () => {
    renderTranscript([userMsg(1, 'Plan the route'), planReply(1)], makeOps(), { ...CHAT, status: 'running' });
    expect(screen.getByRole('button', { name: /Approve and build/ })).toBeDisabled();
  });

  it('marks an approved plan and drops its buttons once the build starts', () => {
    renderTranscript([userMsg(1, 'Plan the route'), planReply(1), userMsg(2, PLAN_APPROVED_MESSAGE), reply(2, 'Building.')]);
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve and build/ })).toBeNull();
  });

  it('a plan the chat moved past has no buttons and no Approved mark', () => {
    renderTranscript([userMsg(1, 'Plan the route'), planReply(1), userMsg(2, 'Use Postgres instead'), reply(2, 'Which table?')]);
    expect(screen.getByText(/Add the route/)).toBeInTheDocument();
    expect(screen.queryByText('Approved')).toBeNull();
    expect(screen.queryByRole('button', { name: /Approve and build/ })).toBeNull();
  });

  it('shows no card for a turn that asked a question', () => {
    renderTranscript([userMsg(1, 'Plan the route'), reply(1, 'Which database do you use?')]);
    expect(screen.queryByText('Plan')).toBeNull();
    expect(screen.queryByRole('button', { name: /Approve and build/ })).toBeNull();
  });

  it('leaves plan mode on when the approval cannot be sent', async () => {
    const ops = makeOps({ send: jest.fn(async () => Promise.reject(new Error('Down'))) });
    renderTranscript([userMsg(1, 'Plan the route'), planReply(1)], ops);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Approve and build/ }));
    });
    expect(ops.send).toHaveBeenCalled();
    expect(mockUpdateChat).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState().chats.wb1?.[0]?.planMode).toBe(true);
  });
});

describe('approving keeps the chat state current', () => {
  it('does not undo the running status the build turn set', async () => {
    seq = 0;
    mockUpdateChat.mockImplementation(async (id: string, patch: Partial<WorkbenchChat>) => ({ ...CHAT, id, ...patch }));
    useWorkbenchStore.getState().setChats('wb1', [CHAT]);
    const ops = makeOps({
      send: jest.fn(async () => {
        useWorkbenchStore.getState().upsertChat({ ...CHAT, status: 'running' });
        return { queued: false };
      }),
    });
    renderTranscript([userMsg(1, 'Plan the route'), planReply(1)], ops);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Approve and build/ }));
    });
    await waitFor(() => expect(mockUpdateChat).toHaveBeenCalled());
    const stored = useWorkbenchStore.getState().chats.wb1?.[0];
    expect(stored).toMatchObject({ status: 'running', planMode: false });
  });
});
