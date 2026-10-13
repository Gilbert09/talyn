/**
 * @jest-environment jsdom
 */
import type {
  AgentEventDraft,
  Workbench,
  WorkbenchChat,
  WorkbenchEvent,
  WorkbenchLocalBridge,
  WorkbenchTurnOutcome,
} from '@talyn/shared';
import { LocalTurnController } from '../renderer/lib/localWorkbench';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { userMessageText } from '../renderer/lib/workbenchFormat';

jest.mock('../renderer/lib/supabase', () => ({
  isSupabaseConfigured: () => false,
  supabase: null,
}));

type TurnEventCb = Parameters<WorkbenchLocalBridge['onTurnEvent']>[0];
type TurnEndCb = Parameters<WorkbenchLocalBridge['onTurnEnd']>[0];

function makeBridge() {
  let onEvent: TurnEventCb | null = null;
  let onEnd: TurnEndCb | null = null;
  const bridge = {
    startTurn: jest.fn(async () => {}),
    cancelTurn: jest.fn(async () => {}),
    exec: jest.fn(async (_path: string, steps: Array<{ argv: string[] }>) => {
      if (steps[0]?.argv.includes('--absolute-git-dir')) return { exitCode: 0, stdout: '/repo/.git\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    onTurnEvent: jest.fn((cb: TurnEventCb) => {
      onEvent = cb;
      return () => {
        onEvent = null;
      };
    }),
    onTurnEnd: jest.fn((cb: TurnEndCb) => {
      onEnd = cb;
      return () => {
        onEnd = null;
      };
    }),
    scripts: { onFrame: jest.fn(() => () => {}), run: jest.fn(), stop: jest.fn() },
  };
  return {
    bridge: bridge as unknown as WorkbenchLocalBridge & typeof bridge,
    emit: (chatId: string, turn: number, event: AgentEventDraft) => onEvent?.({ chatId, turn, event }),
    end: (chatId: string, turn: number, outcome: Partial<WorkbenchTurnOutcome> = {}) =>
      onEnd?.({ chatId, turn, sessionId: null, isError: false, resultText: '', cancelled: false, ...outcome }),
  };
}

function makeApi() {
  return {
    uploadLocalEvents: jest.fn(async (_chatId: string, events: WorkbenchEvent[]) => ({ stored: events.length })),
    updateLocalChat: jest.fn(async (chatId: string, input: { status: WorkbenchChat['status']; agentSessionId?: string | null }) => ({
      ...chat(),
      id: chatId,
      status: input.status,
      agentSessionId: input.agentSessionId ?? null,
    })),
  };
}

const WB: Workbench = {
  id: 'wb1',
  workspaceId: 'ws1',
  repositoryId: 'r1',
  repoFullName: 'acme/app',
  name: 'lisbon',
  branch: 'lisbon',
  baseBranch: 'main',
  runtime: 'local',
  agent: 'claude',
  deviceId: 'dev1',
  localPath: '/work/lisbon',
  sandboxId: null,
  sandboxState: 'none',
  status: 'ready',
  pullRequestId: null,
  settings: {},
  diffStat: null,
  archivedAt: null,
  createdAt: '2026-10-13T00:00:00Z',
  updatedAt: '2026-10-13T00:00:00Z',
};

function chat(over: Partial<WorkbenchChat> = {}): WorkbenchChat {
  return {
    id: 'c1',
    workbenchId: 'wb1',
    title: 'Chat',
    agent: 'claude',
    model: 'claude-sonnet-5-5',
    effort: 'high',
    planMode: false,
    agentSessionId: null,
    status: 'idle',
    queuedMessages: [],
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  };
}

const initial = useWorkbenchStore.getState();

function setup(history: WorkbenchEvent[] = []) {
  useWorkbenchStore.setState(initial, true);
  const store = useWorkbenchStore.getState();
  store.setWorkspace('ws1');
  store.upsertWorkbench(WB);
  store.upsertChat(chat());
  store.appendEvents('c1', history);
  const timers: Array<() => void> = [];
  const { bridge, emit, end } = makeBridge();
  const api = makeApi();
  const loadHistory = jest.fn(async () => {});
  const controller = new LocalTurnController({
    bridge,
    api,
    loadHistory,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
  });
  const stop = controller.start();
  const tick = async () => {
    const pending = timers.splice(0);
    for (const fn of pending) fn();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { controller, bridge, api, emit, end, tick, stop, loadHistory };
}

const seqs = () => (useWorkbenchStore.getState().chatEvents.c1?.events ?? []).map((e) => e.seq);
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('LocalTurnController', () => {
  it('numbers events after the stored history and starts the next turn', async () => {
    const history = [1, 2, 3].map((seq) => ({ chatId: 'c1', seq, turn: 1, event: { seq, type: 'assistant' } }));
    const { controller, bridge, loadHistory } = setup(history);

    await controller.send(WB, chat(), { text: 'next step' });

    expect(loadHistory).toHaveBeenCalledWith('c1');
    expect(seqs()).toEqual([1, 2, 3, 4]);
    const userEvent = useWorkbenchStore.getState().chatEvents.c1.events[3];
    expect(userEvent.turn).toBe(2);
    expect(userMessageText(userEvent.event)).toBe('next step');
    expect(bridge.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'c1', turn: 2, path: '/work/lisbon', prompt: 'next step', model: 'claude-sonnet-5-5', effort: 'high' })
    );
  });

  it('takes a checkpoint before the turn, outside the working tree', async () => {
    const { controller, bridge } = setup();
    await controller.send(WB, chat(), { text: 'go' });
    const calls = bridge.exec.mock.calls.map((c) => c[1] as Array<{ argv: string[]; env?: Record<string, string> }>);
    const create = calls.find((steps) => steps.some((s) => s.argv.includes('update-ref')));
    expect(create).toBeDefined();
    expect(create?.some((s) => s.argv.includes('refs/talyn/checkpoints/c1/1'))).toBe(true);
    expect(create?.find((s) => s.env?.GIT_INDEX_FILE)?.env?.GIT_INDEX_FILE).toBe('/repo/.git/talyn-checkpoint-index');
  });

  it('continues seq across turn events and batches the upload', async () => {
    const { controller, api, emit, tick } = setup();
    await controller.send(WB, chat(), { text: 'go' });
    emit('c1', 1, { type: 'system', subtype: 'init', session_id: 's1' } as AgentEventDraft);
    emit('c1', 1, { type: 'assistant', message: { content: [] } } as AgentEventDraft);
    expect(seqs()).toEqual([1, 2, 3]);
    expect(api.uploadLocalEvents).not.toHaveBeenCalled();

    await tick();
    expect(api.uploadLocalEvents).toHaveBeenCalledTimes(1);
    const [chatId, uploaded] = api.uploadLocalEvents.mock.calls[0];
    expect(chatId).toBe('c1');
    expect(uploaded.map((e: WorkbenchEvent) => e.seq)).toEqual([1, 2, 3]);
    expect(uploaded.every((e: WorkbenchEvent) => e.event.seq === e.seq)).toBe(true);
  });

  it('reports the session id once, when the stream first names it', async () => {
    const { controller, api, emit } = setup();
    await controller.send(WB, chat(), { text: 'go' });
    emit('c1', 1, { type: 'system', subtype: 'init', session_id: 's1' } as AgentEventDraft);
    emit('c1', 1, { type: 'assistant', session_id: 's1' } as AgentEventDraft);
    await settle();
    const withSession = api.updateLocalChat.mock.calls.filter((c) => c[1].agentSessionId === 's1');
    expect(withSession).toHaveLength(1);
  });

  it('queues a message sent while a turn runs, then drains it when the turn ends', async () => {
    const { controller, bridge, end } = setup();
    await controller.send(WB, chat(), { text: 'first' });
    const res = await controller.send(WB, chat({ status: 'running' }), { text: 'second' });
    expect(res.queued).toBe(true);
    expect(useWorkbenchStore.getState().localQueues.c1.map((m) => m.text)).toEqual(['second']);
    expect(bridge.startTurn).toHaveBeenCalledTimes(1);

    end('c1', 1, { sessionId: 's1' });
    await settle();
    await settle();

    expect(bridge.startTurn).toHaveBeenCalledTimes(2);
    expect(bridge.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'second', turn: 2, resumeSessionId: 's1' }));
    expect(useWorkbenchStore.getState().localQueues.c1).toEqual([]);
  });

  it.each([
    ['a clean end', { isError: false, cancelled: false }, 'idle'],
    ['an error', { isError: true, cancelled: false }, 'error'],
    ['a cancel', { isError: true, cancelled: true }, 'idle'],
  ])('flushes and reports the status after %s', async (_n, outcome, status) => {
    const { controller, api, emit, end } = setup();
    await controller.send(WB, chat(), { text: 'go' });
    emit('c1', 1, { type: 'result', subtype: 'success' } as AgentEventDraft);
    end('c1', 1, outcome);
    await settle();
    expect(api.uploadLocalEvents).toHaveBeenCalled();
    expect(api.updateLocalChat).toHaveBeenLastCalledWith('c1', expect.objectContaining({ status }));
    expect(controller.isRunning('c1')).toBe(false);
  });

  it('puts a failed upload back and retries it on the next tick', async () => {
    const { controller, api, emit, tick } = setup();
    api.uploadLocalEvents.mockRejectedValueOnce(new Error('offline'));
    await controller.send(WB, chat(), { text: 'go' });
    emit('c1', 1, { type: 'assistant' } as AgentEventDraft);
    await tick();
    emit('c1', 1, { type: 'assistant' } as AgentEventDraft);
    await tick();
    expect(api.uploadLocalEvents).toHaveBeenCalledTimes(2);
    expect(api.uploadLocalEvents.mock.calls[1][1].map((e: WorkbenchEvent) => e.seq)).toEqual([1, 2, 3]);
  });

  it('records a spawn failure in the transcript and ends the turn as an error', async () => {
    const { controller, bridge, api } = setup();
    bridge.startTurn.mockRejectedValueOnce(new Error('claude: command not found'));
    await controller.send(WB, chat(), { text: 'go' });
    const events = useWorkbenchStore.getState().chatEvents.c1.events;
    expect(events[events.length - 1].event).toMatchObject({ type: 'system', subtype: 'spawn_error', text: 'claude: command not found' });
    expect(api.updateLocalChat).toHaveBeenLastCalledWith('c1', expect.objectContaining({ status: 'error' }));
  });

  it('stops listening on teardown', () => {
    const { stop, emit } = setup();
    stop();
    emit('c1', 1, { type: 'assistant' } as AgentEventDraft);
    expect(seqs()).toEqual([]);
  });
});
