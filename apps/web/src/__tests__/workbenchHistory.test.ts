import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, WorkbenchEvent } from '@talyn/shared';
import { EVENTS_PAGE_SIZE, ensureChatHistory, loadOlderEvents } from '../lib/workbenchData';
import { useWorkbenchStore } from '../stores/workbenches';

const mockEvents = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', () => ({
  api: { workbenches: { events: (...args: unknown[]) => mockEvents(...args) } },
}));
const events = mockEvents;

const initial = useWorkbenchStore.getState();

const ev = (seq: number): WorkbenchEvent => ({ chatId: 'c1', seq, turn: 1, event: { seq, type: 'assistant' } as AgentEvent });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const page = (seqs: number[], marker?: { hasOlder: boolean; oldestSeq?: number | null }) => ({
  events: seqs.map(ev),
  cursor: seqs.length ? seqs[seqs.length - 1] : 0,
  ...(marker ? { oldestSeq: marker.oldestSeq ?? seqs[0] ?? null, hasOlder: marker.hasOlder } : {}),
});
const state = () => useWorkbenchStore.getState().chatEvents.c1;
const heldSeqs = () => state().events.map((e) => e.seq);

beforeEach(() => {
  useWorkbenchStore.setState(initial, true);
  events.mockReset();
});

describe('opening a chat', () => {
  it('loads only the newest page', async () => {
    events.mockResolvedValueOnce(page([40, 41, 42], { hasOlder: true }));
    await ensureChatHistory('c1');
    expect(events).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledWith('c1', { before: 'latest', limit: EVENTS_PAGE_SIZE });
    expect(heldSeqs()).toEqual([40, 41, 42]);
    expect(state()).toMatchObject({ loaded: true, loading: false, hasOlder: true, oldestSeq: 40 });
  });

  it('does not load again once loaded, and shares one load between callers', async () => {
    events.mockResolvedValueOnce(page([1], { hasOlder: false }));
    await Promise.all([ensureChatHistory('c1'), ensureChatHistory('c1')]);
    await ensureChatHistory('c1');
    expect(events).toHaveBeenCalledTimes(1);
  });

  it('falls back to the whole history from an older backend that ignores before', async () => {
    events
      .mockResolvedValueOnce(page(range(1, EVENTS_PAGE_SIZE)))
      .mockResolvedValueOnce(page(range(EVENTS_PAGE_SIZE + 1, EVENTS_PAGE_SIZE + 3)));
    await ensureChatHistory('c1');
    expect(events).toHaveBeenNthCalledWith(2, 'c1', { after: EVENTS_PAGE_SIZE, limit: EVENTS_PAGE_SIZE });
    expect(heldSeqs()).toEqual(range(1, EVENTS_PAGE_SIZE + 3));
    expect(state()).toMatchObject({ loaded: true, hasOlder: false, oldestSeq: 1 });
  });

  it('stops after a short first page from an older backend', async () => {
    events.mockResolvedValueOnce(page([1, 2]));
    await ensureChatHistory('c1');
    expect(events).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({ hasOlder: false, oldestSeq: 1 });
  });

  it('says why when the load fails', async () => {
    events.mockRejectedValueOnce(new Error('offline'));
    await ensureChatHistory('c1');
    expect(state()).toMatchObject({ loaded: false, loading: false, error: 'offline' });
  });
});

describe('the reconnect catch-up', () => {
  it('pages forward from the newest seq held and keeps the older marker', async () => {
    events.mockResolvedValueOnce(page([40, 41], { hasOlder: true }));
    await ensureChatHistory('c1');
    events.mockResolvedValueOnce(page([42, 43]));
    await ensureChatHistory('c1', { force: true });
    expect(events).toHaveBeenLastCalledWith('c1', { after: 41, limit: EVENTS_PAGE_SIZE });
    expect(heldSeqs()).toEqual([40, 41, 42, 43]);
    expect(state()).toMatchObject({ hasOlder: true, oldestSeq: 40 });
  });
});

describe('loading older events', () => {
  async function openAt(seqs: number[], hasOlder: boolean) {
    events.mockResolvedValueOnce(page(seqs, { hasOlder }));
    await ensureChatHistory('c1');
    events.mockReset();
  }

  it('prepends the page below the oldest seq held', async () => {
    await openAt([40, 41], true);
    events.mockResolvedValueOnce(page([30, 31, 39], { hasOlder: true }));
    await loadOlderEvents('c1');
    expect(events).toHaveBeenCalledWith('c1', { before: 40, limit: EVENTS_PAGE_SIZE });
    expect(heldSeqs()).toEqual([30, 31, 39, 40, 41]);
    expect(state()).toMatchObject({ hasOlder: true, oldestSeq: 30, loadingOlder: false });

    events.mockResolvedValueOnce(page([1, 2], { hasOlder: false }));
    await loadOlderEvents('c1');
    expect(events).toHaveBeenLastCalledWith('c1', { before: 30, limit: EVENTS_PAGE_SIZE });
    expect(state()).toMatchObject({ hasOlder: false, oldestSeq: 1 });
  });

  it('marks the load while it runs, and runs one at a time', async () => {
    await openAt([40], true);
    let resolve: (value: unknown) => void = () => undefined;
    events.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const first = loadOlderEvents('c1');
    const second = loadOlderEvents('c1');
    expect(state().loadingOlder).toBe(true);
    resolve(page([39], { hasOlder: false }));
    await Promise.all([first, second]);
    expect(events).toHaveBeenCalledTimes(1);
    expect(state().loadingOlder).toBe(false);
  });

  it.each([
    ['nothing is older', true, false],
    ['the chat is not loaded', false, true],
  ])('does nothing when %s', async (_name, loaded, hasOlder) => {
    if (loaded) await openAt([1, 2], hasOlder);
    await loadOlderEvents('c1');
    expect(events).not.toHaveBeenCalled();
  });

  it('keeps the error and stops until asked again', async () => {
    await openAt([40], true);
    events.mockRejectedValueOnce(new Error('timeout'));
    await loadOlderEvents('c1');
    expect(state()).toMatchObject({ loadingOlder: false, olderError: 'timeout', hasOlder: true });
    events.mockResolvedValueOnce(page([39], { hasOlder: false }));
    await loadOlderEvents('c1');
    expect(state()).toMatchObject({ olderError: null, hasOlder: false, oldestSeq: 39 });
  });

  it('falls back to the whole history when the backend stops paging backwards', async () => {
    await openAt([40, 41], true);
    events.mockResolvedValueOnce(page(range(1, 3)));
    await loadOlderEvents('c1');
    expect(heldSeqs()).toEqual([1, 2, 3, 40, 41]);
    expect(state()).toMatchObject({ hasOlder: false, oldestSeq: 1, loadingOlder: false });
  });
});
