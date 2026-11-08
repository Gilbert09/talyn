import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchEvent } from '@talyn/shared';

const broadcast = vi.fn();
vi.mock('../services/websocket.js', () => ({ broadcastToWorkspace: (...args: unknown[]) => broadcast(...args) }));
vi.mock('../services/workbenches/prSessions.js', () => ({ emitPrSession: vi.fn() }));

const { emitWorkbenchEvents } = await import('../services/workbenches/emit.js');

const event = (seq: number, createdAt?: string): WorkbenchEvent => ({
  chatId: 'chat-1',
  seq,
  turn: 1,
  event: { seq, type: 'assistant' },
  ...(createdAt ? { createdAt } : {}),
});

function sentEvents(): WorkbenchEvent[] {
  expect(broadcast).toHaveBeenCalledTimes(1);
  return (broadcast.mock.calls[0][1] as { payload: { events: WorkbenchEvent[] } }).payload.events;
}

describe('emitWorkbenchEvents', () => {
  beforeEach(() => broadcast.mockReset());

  it('sends nothing for an empty batch', () => {
    emitWorkbenchEvents('ws-1', 'chat-1', []);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each([
    ['every event has a time', ['2026-11-08T10:00:00.000Z', '2026-11-08T10:00:01.000Z']],
    ['no event has a time', [undefined, undefined]],
    ['some events have a time', ['2026-11-08T10:00:00.000Z', undefined]],
  ])('gives each event a time when %s', (_name, times) => {
    const before = Date.now();
    const events = times.map((at, i) => event(i + 1, at));
    emitWorkbenchEvents('ws-1', 'chat-1', events);
    const sent = sentEvents();
    expect(sent.map((e) => e.seq)).toEqual([1, 2]);
    sent.forEach((e, i) => {
      if (times[i]) expect(e.createdAt).toBe(times[i]);
      else expect(new Date(e.createdAt!).getTime()).toBeGreaterThanOrEqual(before);
    });
    // The caller's objects are not changed.
    events.forEach((e, i) => expect(e.createdAt).toBe(times[i]));
  });

  it('sends the same array when every event already has a time', () => {
    const events = [event(1, '2026-11-08T10:00:00.000Z')];
    emitWorkbenchEvents('ws-1', 'chat-1', events);
    expect(sentEvents()).toBe(events);
  });
});
