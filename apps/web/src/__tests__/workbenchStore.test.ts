import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { AgentEvent, Workbench, WorkbenchChat, WorkbenchEvent } from '@talyn/shared';
import {
  SCRIPT_OUTPUT_MAX_CHUNKS,
  lastSeq,
  lastTurn,
  mergeWorkbenchEvents,
  setChatFinishedListener,
  useWorkbenchStore,
  visibleChats,
} from '../stores/workbenches';

function ev(seq: number, turn = 1, type = 'assistant'): WorkbenchEvent {
  return { chatId: 'c1', seq, turn, event: { seq, type } as AgentEvent };
}

function chat(id: string, over: Partial<WorkbenchChat> = {}): WorkbenchChat {
  return {
    id,
    workbenchId: 'wb1',
    title: `Chat ${id}`,
    agent: 'claude',
    model: null,
    effort: null,
    planMode: false,
    agentSessionId: null,
    status: 'idle',
    queuedMessages: [],
    createdAt: `2026-10-13T00:00:0${id.length}Z`,
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  };
}

function workbench(id: string, over: Partial<Workbench> = {}): Workbench {
  return {
    id,
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/app',
    name: 'lisbon',
    branch: 'lisbon',
    baseBranch: 'main',
    runtime: 'sandbox',
    agent: 'claude',
    deviceId: null,
    localPath: null,
    sandboxId: null,
    sandboxState: 'running',
    status: 'ready',
    pullRequestId: null,
    settings: {},
    diffStat: null,
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  };
}

const initial = useWorkbenchStore.getState();

beforeEach(() => {
  useWorkbenchStore.setState(initial, true);
  setChatFinishedListener(null);
});

afterEach(() => vi.restoreAllMocks());

describe('mergeWorkbenchEvents', () => {
  const seqs = (list: WorkbenchEvent[]) => list.map((e) => e.seq);

  it.each([
    ['appends in order', [1, 2], [3, 4], [1, 2, 3, 4]],
    ['drops replayed seqs', [1, 2, 3], [2, 3, 4], [1, 2, 3, 4]],
    ['sorts an out-of-order arrival', [1, 4], [2, 3], [1, 2, 3, 4]],
    ['de-dupes within one incoming batch', [], [5, 5, 1], [1, 5]],
    ['merges into an empty list', [], [2, 1], [1, 2]],
  ])('%s', (_name, existing, incoming, expected) => {
    expect(seqs(mergeWorkbenchEvents(existing.map((s) => ev(s)), incoming.map((s) => ev(s))))).toEqual(expected);
  });

  it('returns the same array when nothing is new, so the store can skip a write', () => {
    const existing = [ev(1), ev(2)];
    expect(mergeWorkbenchEvents(existing, [ev(1)])).toBe(existing);
    expect(mergeWorkbenchEvents(existing, [])).toBe(existing);
  });

  it('keeps the first copy of a seq rather than the replay', () => {
    const first = ev(1, 1, 'assistant');
    const replay = ev(1, 1, 'result');
    expect(mergeWorkbenchEvents([first], [replay])[0].event.type).toBe('assistant');
  });

  it.each([
    [[], 0, 0],
    [[ev(1, 1), ev(2, 1)], 2, 1],
    [[ev(1, 1), ev(7, 3), ev(8, 2)], 8, 3],
  ])('lastSeq / lastTurn of %#', (events, seq, turn) => {
    expect(lastSeq(events)).toBe(seq);
    expect(lastTurn(events)).toBe(turn);
  });
});

describe('workbench store', () => {
  it('appendEvents de-dupes and orders per chat, and leaves other chats alone', () => {
    const s = useWorkbenchStore.getState();
    s.appendEvents('c1', [ev(2), ev(1)]);
    s.appendEvents('c1', [ev(2), ev(3)]);
    s.appendEvents('c2', [{ ...ev(1), chatId: 'c2' }]);
    const state = useWorkbenchStore.getState().chatEvents;
    expect(state.c1.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(state.c2.events).toHaveLength(1);
  });

  it.each([
    ['no held events', [], [5, 6, 7], [5, 6, 7]],
    ['live events newer than the page', [8, 9], [5, 6, 7], [5, 6, 7, 8, 9]],
    ['live events across a gap below the page', [1, 2, 6], [5, 6, 7], [5, 6, 7]],
  ])('setLatestPage keeps %s at or above the page', (_name, held, page, seqs) => {
    const s = useWorkbenchStore.getState();
    s.appendEvents('c1', held.map((seq) => ev(seq)));
    s.setLatestPage('c1', page.map((seq) => ev(seq)), { hasOlder: true, oldestSeq: page[0] });
    const state = useWorkbenchStore.getState().chatEvents.c1;
    expect(state.events.map((e) => e.seq)).toEqual(seqs);
    expect(state).toMatchObject({ hasOlder: true, oldestSeq: 5, olderError: null });
  });

  it('setLatestPage with an empty page keeps what the socket brought', () => {
    const s = useWorkbenchStore.getState();
    s.appendEvents('c1', [ev(1)]);
    s.setLatestPage('c1', [], { hasOlder: false, oldestSeq: null });
    expect(useWorkbenchStore.getState().chatEvents.c1).toMatchObject({ hasOlder: false, oldestSeq: 1 });
  });

  it('prependOlderPage merges in front and moves the marker down', () => {
    const s = useWorkbenchStore.getState();
    s.setLatestPage('c1', [ev(5), ev(6)], { hasOlder: true, oldestSeq: 5 });
    s.setChatEventsState('c1', { olderError: 'boom' });
    s.prependOlderPage('c1', [ev(3), ev(4)], { hasOlder: true, oldestSeq: 3 });
    expect(useWorkbenchStore.getState().chatEvents.c1).toMatchObject({ hasOlder: true, oldestSeq: 3, olderError: null });
    s.prependOlderPage('c1', [ev(1), ev(2), ev(3)], { hasOlder: false, oldestSeq: 1 });
    const state = useWorkbenchStore.getState().chatEvents.c1;
    expect(state.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state).toMatchObject({ hasOlder: false, oldestSeq: 1 });
  });

  it('prependOlderPage leaves the other chats alone', () => {
    const s = useWorkbenchStore.getState();
    s.setLatestPage('c2', [{ ...ev(9), chatId: 'c2' }], { hasOlder: true, oldestSeq: 9 });
    s.prependOlderPage('c1', [ev(1)], { hasOlder: false, oldestSeq: 1 });
    expect(useWorkbenchStore.getState().chatEvents.c2).toMatchObject({ hasOlder: true, oldestSeq: 9 });
  });

  it('ignores a workbench from another workspace', () => {
    const s = useWorkbenchStore.getState();
    s.setWorkspace('ws1');
    s.upsertWorkbench(workbench('a'));
    s.upsertWorkbench(workbench('b', { workspaceId: 'ws2' }));
    expect(Object.keys(useWorkbenchStore.getState().workbenches)).toEqual(['a']);
  });

  it('drops a stale list for a workspace that is no longer current', () => {
    const s = useWorkbenchStore.getState();
    s.setWorkspace('ws2');
    s.setWorkbenches('ws1', [workbench('a')]);
    expect(useWorkbenchStore.getState().workbenches).toEqual({});
    expect(useWorkbenchStore.getState().listLoaded).toBe(false);
  });

  it('removeWorkbench clears the selection when it removes the selected one', () => {
    const s = useWorkbenchStore.getState();
    s.setWorkspace('ws1');
    s.upsertWorkbench(workbench('a'));
    s.selectWorkbench('a');
    s.removeWorkbench('a');
    expect(useWorkbenchStore.getState().selectedWorkbenchId).toBeNull();
  });

  describe('chat finishing', () => {
    it.each([
      ['running → idle', 'running', 'idle', true],
      ['running → error', 'running', 'error', true],
      ['idle → idle', 'idle', 'idle', false],
      ['idle → running', 'idle', 'running', false],
    ] as const)('%s calls the listener: %s', (_n, from, to, fires) => {
      const listener = vi.fn();
      setChatFinishedListener(listener);
      const s = useWorkbenchStore.getState();
      s.upsertChat(chat('c1', { status: from }));
      s.upsertChat(chat('c1', { status: to }));
      expect(listener).toHaveBeenCalledTimes(fires ? 1 : 0);
      expect(Boolean(useWorkbenchStore.getState().unread.c1)).toBe(fires);
    });

    it('does not mark the chat unread when it is open and the window is focused', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const s = useWorkbenchStore.getState();
      s.selectWorkbench('wb1');
      s.selectChat('wb1', 'c1');
      s.upsertChat(chat('c1', { status: 'running' }));
      s.upsertChat(chat('c1', { status: 'idle' }));
      expect(useWorkbenchStore.getState().unread.c1).toBeUndefined();
    });

    it('selecting a chat reads it', () => {
      const s = useWorkbenchStore.getState();
      s.upsertChat(chat('c1', { status: 'running' }));
      s.upsertChat(chat('c1', { status: 'idle' }));
      expect(useWorkbenchStore.getState().unread.c1).toBe(true);
      s.selectChat('wb1', 'c1');
      expect(useWorkbenchStore.getState().unread.c1).toBeUndefined();
    });
  });

  it('keeps chats in creation order', () => {
    const s = useWorkbenchStore.getState();
    s.upsertChat(chat('ccc'));
    s.upsertChat(chat('c'));
    s.upsertChat(chat('cc'));
    expect(useWorkbenchStore.getState().chats.wb1.map((c) => c.id)).toEqual(['c', 'cc', 'ccc']);
  });

  it('hideChat moves the selection to the newest remaining tab', () => {
    const s = useWorkbenchStore.getState();
    s.setChats('wb1', [chat('a'), chat('bb'), chat('ccc')]);
    s.selectChat('wb1', 'ccc');
    s.hideChat('wb1', 'ccc');
    const state = useWorkbenchStore.getState();
    expect(state.selectedChatByWorkbench.wb1).toBe('bb');
    expect(visibleChats(state, 'wb1').map((c) => c.id)).toEqual(['a', 'bb']);
  });

  describe('script output', () => {
    it('collects chunks, then records the exit', () => {
      const s = useWorkbenchStore.getState();
      s.markScriptStarted('wb1', 'run');
      s.appendScriptFrame({ workbenchId: 'wb1', name: 'run', stream: 'stdout', data: 'a' });
      s.appendScriptFrame({ workbenchId: 'wb1', name: 'run', stream: 'stderr', data: 'b' });
      s.appendScriptFrame({ workbenchId: 'wb1', name: 'run', stream: 'exit', exitCode: 1 });
      const out = useWorkbenchStore.getState().scriptOutput.wb1.run;
      expect(out).toEqual({ chunks: ['a', 'b'], total: 2, running: false, exitCode: 1 });
    });

    it('caps the chunks it keeps but keeps counting', () => {
      const s = useWorkbenchStore.getState();
      for (let i = 0; i < SCRIPT_OUTPUT_MAX_CHUNKS + 5; i++) {
        s.appendScriptFrame({ workbenchId: 'wb1', name: 'run', stream: 'stdout', data: String(i) });
      }
      const out = useWorkbenchStore.getState().scriptOutput.wb1.run;
      expect(out.chunks).toHaveLength(SCRIPT_OUTPUT_MAX_CHUNKS);
      expect(out.total).toBe(SCRIPT_OUTPUT_MAX_CHUNKS + 5);
      expect(out.chunks[out.chunks.length - 1]).toBe(String(SCRIPT_OUTPUT_MAX_CHUNKS + 4));
    });

    it('a restart clears the old output', () => {
      const s = useWorkbenchStore.getState();
      s.appendScriptFrame({ workbenchId: 'wb1', name: 'setup', stream: 'stdout', data: 'old' });
      s.markScriptStarted('wb1', 'setup');
      expect(useWorkbenchStore.getState().scriptOutput.wb1.setup).toEqual({ chunks: [], total: 0, running: true, exitCode: null });
    });
  });

  it.each([
    [50, 120],
    [300, 300],
    [260.6, 261],
  ])('terminal height %p clamps to %p', (input, expected) => {
    useWorkbenchStore.getState().setTerminalHeight(input);
    expect(useWorkbenchStore.getState().terminalHeight).toBe(expected);
  });

  it('drafts: an empty draft is removed rather than stored', () => {
    const s = useWorkbenchStore.getState();
    s.setDraft('c1', 'hello');
    expect(useWorkbenchStore.getState().drafts.c1).toBe('hello');
    s.setDraft('c1', '');
    expect('c1' in useWorkbenchStore.getState().drafts).toBe(false);
  });
});

it('replaces script output after reconnect and rejects repeated offsets', () => {
  const append = useWorkbenchStore.getState().appendScriptFrame;
  const frame = { workbenchId: 'wb1', name: 'run', generation: 'run-1', stream: 'stdout' as const };
  append({ ...frame, offset: 10, data: 'first\n' });
  append({ ...frame, offset: 20, snapshot: true, data: 'first\nsecond\n', running: true });
  append({ ...frame, offset: 20, data: 'second\n' });
  append({ ...frame, offset: 10, snapshot: true, data: 'first\n' });
  expect(useWorkbenchStore.getState().scriptOutput.wb1.run.chunks.join('')).toBe('first\nsecond\n');
  append({ ...frame, stream: 'exit', offset: 20, exitCode: 0 });
  expect(useWorkbenchStore.getState().scriptOutput.wb1.run.running).toBe(false);
});
