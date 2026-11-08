import { describe, expect, it } from 'vitest';
import type { AgentEvent, WorkbenchEvent } from '@talyn/shared';
import { pendingMessageState, PENDING_MESSAGE_GRACE_MS, type PendingUserMessage } from '../lib/workbenchFormat';

const NOW = 1_000_000;

const userEvent = (seq: number, text: string): WorkbenchEvent => ({
  chatId: 'c1',
  seq,
  turn: seq,
  event: { seq, type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } } as AgentEvent,
});

const toolResult = (seq: number): WorkbenchEvent => ({
  chatId: 'c1',
  seq,
  turn: seq,
  event: { seq, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'Fix the login' }] } } as AgentEvent,
});

const failed = { error: 'Failed to fetch', input: { text: 'Fix the login' } };

const message = (over: Partial<PendingUserMessage> = {}): PendingUserMessage => ({
  id: 'outgoing-1',
  text: 'Fix the login',
  attachments: [],
  afterSeq: null,
  ...over,
});

describe('pendingMessageState', () => {
  it.each<[string, Partial<PendingUserMessage>, { events?: WorkbenchEvent[]; queued?: { text: string }[]; running?: boolean; now?: number }, 'show' | 'hide' | 'done']>([
    ['in flight, nothing else known', {}, {}, 'show'],
    ['in flight, even when the queue has the same text', {}, { queued: [{ text: 'Fix the login' }] }, 'show'],
    ['in flight, the chat idle long after', {}, { now: NOW + 60_000 }, 'show'],
    ['its event arrived', {}, { events: [userEvent(1, 'Fix the login')] }, 'done'],
    ['its event arrived while in flight', { settledAt: undefined }, { events: [userEvent(3, 'Fix the login')], running: true }, 'done'],
    ['its event arrived with other whitespace', { text: '  Fix the login\n' }, { events: [userEvent(1, 'Fix the login')] }, 'done'],
    ['an older message has the same text', { afterSeq: 5, settledAt: NOW }, { events: [userEvent(5, 'Fix the login')], running: true }, 'show'],
    ['a later message has the same text', { afterSeq: 5, settledAt: NOW }, { events: [userEvent(5, 'Fix the login'), userEvent(6, 'Fix the login')] }, 'done'],
    ['another message arrived', { settledAt: NOW }, { events: [userEvent(1, 'Something else')], running: true }, 'show'],
    ['a tool result is not its echo', { settledAt: NOW }, { events: [toolResult(1)], running: true }, 'show'],
    ['sent and queued', { settledAt: NOW - 60_000 }, { queued: [{ text: 'Fix the login' }] }, 'hide'],
    ['sent and queued with other whitespace', { settledAt: NOW }, { queued: [{ text: ' Fix the login ' }], running: true }, 'hide'],
    ['sent, its turn running', { settledAt: NOW - 60 * 60_000 }, { running: true }, 'show'],
    ['sent, the chat not yet updated', { settledAt: NOW - 1_000 }, {}, 'show'],
    ['sent, at the end of the grace', { settledAt: NOW - PENDING_MESSAGE_GRACE_MS }, {}, 'done'],
    ['sent, the chat idle after the grace', { settledAt: NOW - 60_000 }, {}, 'done'],
    ['failed, the chat idle long after', { failed }, { now: NOW + 60 * 60_000 }, 'show'],
    ['failed, the chat running', { failed }, { running: true }, 'show'],
    ['failed, the queue has the same text', { failed }, { queued: [{ text: 'Fix the login' }] }, 'show'],
    ['failed, its event arrived after all', { failed }, { events: [userEvent(1, 'Fix the login')] }, 'done'],
    ['failed, an older message has the same text', { afterSeq: 5, failed }, { events: [userEvent(5, 'Fix the login')] }, 'show'],
  ])('%s', (_name, over, ctx, expected) => {
    expect(
      pendingMessageState(message(over), {
        events: ctx.events ?? [],
        queued: ctx.queued ?? [],
        running: ctx.running ?? false,
        now: ctx.now ?? NOW,
      }),
    ).toBe(expected);
  });
});
