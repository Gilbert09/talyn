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
import { toast } from '../renderer/stores/toast';

jest.mock('../renderer/lib/supabase', () => ({
  isSupabaseConfigured: () => false,
  supabase: null,
}));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
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
    createPullRequest: jest.fn(async (_id: string, _input: unknown) => ({
      workbench: { ...WB, pullRequestId: 'pr-12' },
      pullRequest: { number: 12, url: 'https://github.com/acme/app/pull/12' },
      existing: false,
    })),
    adoptPullRequest: jest.fn(
      async (
        _id: string,
        _head?: { sha?: string; branch?: string }
      ): Promise<{ workbench: Workbench; pullRequest: { number: number; url: string; headRef: string } | null }> => ({
        workbench: WB,
        pullRequest: null,
      })
    ),
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

  it.each([
    ['an error end with text', { isError: true, cancelled: false, resultText: 'claude: auth failed' }, true],
    ['a cancel', { isError: true, cancelled: true, resultText: 'killed' }, false],
    ['a clean end', { isError: false, cancelled: false, resultText: 'done' }, false],
  ])('records a visible error event for %s: %s', async (_n, outcome, recorded) => {
    const { controller, end } = setup();
    await controller.send(WB, chat(), { text: 'go' });
    end('c1', 1, outcome);
    await settle();
    const events = useWorkbenchStore.getState().chatEvents.c1.events.map((e) => e.event as { type: string; subtype?: string; text?: string });
    const found = events.find((e) => e.type === 'system' && e.subtype === 'error');
    if (recorded) expect(found?.text).toBe('claude: auth failed');
    else expect(found).toBeUndefined();
  });

  it('stops listening on teardown', () => {
    const { stop, emit } = setup();
    stop();
    emit('c1', 1, { type: 'assistant' } as AgentEventDraft);
    expect(seqs()).toEqual([]);
  });
});

describe('LocalTurnController Create PR', () => {
  const CREATE_PR = { text: 'Create a pull request', intent: 'create_pr' as const };
  const REPLY =
    'Added the thing.\n\n```talyn-pr\n{"title":"feat: add the thing","body":"## Summary\\nAdds it.","commitMessage":"feat: wip","draft":false}\n```';
  const ok = (resultText = REPLY) => ({ sessionId: 's1', isError: false, resultText, cancelled: false });

  type Steps = Array<{ argv: string[] }>;
  const HEAD_SHA = 'a'.repeat(40);
  function gitWorld(
    bridge: ReturnType<typeof setup>['bridge'],
    over: { push?: { exitCode: number; stderr: string }; head?: string } = {}
  ) {
    bridge.exec.mockImplementation(async (_path: string, steps: Steps) => {
      const argv = steps.flatMap((s) => s.argv);
      if (argv.includes('--absolute-git-dir')) return { exitCode: 0, stdout: '/repo/.git\n', stderr: '' };
      if (argv.includes('--porcelain')) return { exitCode: 0, stdout: ' M a.ts\n', stderr: '' };
      if (argv.includes('rev-list')) return { exitCode: 0, stdout: '2\n', stderr: '' };
      if (argv.includes('push')) return { exitCode: 0, stdout: '', stderr: '', ...(over.push ?? {}) };
      if (argv.includes('--abbrev-ref')) return { exitCode: 0, stdout: over.head ?? `${HEAD_SHA}\nagent-branch\n`, stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    });
  }
  const gitArgvs = (bridge: ReturnType<typeof setup>['bridge']) =>
    bridge.exec.mock.calls.flatMap((c) => (c[1] as Steps).map((s) => s.argv));
  const prEvents = () =>
    useWorkbenchStore
      .getState()
      .chatEvents.c1.events.map((e) => e.event as { type: string })
      .filter((e) => e.type === 'talyn_pr');

  afterEach(() => jest.clearAllMocks());

  it('Claude: shows the short text, and hands the instructions over in the prompt and as a system prompt', async () => {
    const { controller, bridge } = setup();
    await controller.send({ ...WB, settings: { prompts: { create_pr: 'Mention the ticket.' } } }, chat(), CREATE_PR);
    const user = useWorkbenchStore.getState().chatEvents.c1.events[0];
    expect(userMessageText(user.event)).toBe('Create a pull request');
    expect(JSON.stringify(useWorkbenchStore.getState().chatEvents.c1.events)).not.toContain('Do not commit');
    const req = (bridge.startTurn.mock.calls[0] as unknown[])[0] as { prompt: string; appendSystemPrompt?: string };
    expect(req.prompt.startsWith(req.appendSystemPrompt ?? '')).toBe(true);
    expect(req.prompt.endsWith('---\n\nCreate a pull request')).toBe(true);
    expect(req.prompt).toContain(`Stay on branch \`${WB.branch}\``);
    expect(req.appendSystemPrompt).toContain('Do not commit, push or open the pull request');
    expect(req.appendSystemPrompt).toContain("override the repository's own pull-request instructions");
    expect(req.appendSystemPrompt).toContain('merged into `main`');
    expect(req.appendSystemPrompt).toContain('Mention the ticket.');
  });

  it('Codex: the instructions go in front of the prompt, and the transcript keeps the short text', async () => {
    const { controller, bridge } = setup();
    await controller.send(WB, chat({ agent: 'codex' }), CREATE_PR);
    const req = (bridge.startTurn.mock.calls[0] as unknown[])[0] as { prompt: string; appendSystemPrompt?: string };
    expect(req.appendSystemPrompt).toBeUndefined();
    expect(req.prompt).toContain('Do not commit, push or open the pull request');
    expect(req.prompt.endsWith('Create a pull request')).toBe(true);
    expect(userMessageText(useWorkbenchStore.getState().chatEvents.c1.events[0].event)).toBe('Create a pull request');
  });

  it('an ordinary message gets the standing PR instruction', async () => {
    const { controller, bridge } = setup();
    await controller.send(WB, chat(), { text: 'go' });
    expect(bridge.startTurn).toHaveBeenCalledWith(expect.objectContaining({ appendSystemPrompt: expect.stringContaining('```talyn-pr') }));
  });

  it('opens a PR after a successful ordinary turn', async () => {
    const { controller, bridge, api } = setup();
    gitWorld(bridge);
    await controller.send(WB, chat(), { text: 'go' });
    await controller.handleTurnEnd('c1', ok());
    expect(api.createPullRequest).toHaveBeenCalledTimes(1);
    expect(prEvents()).toEqual([expect.objectContaining({ ok: true, number: 12 })]);
  });

  it.each(['off', 'linked', 'invalid', 'cancelled', 'error', 'awaiting_input'] as const)('skips an ordinary PR when %s', async (reason) => {
    const { controller, bridge, api } = setup();
    gitWorld(bridge);
    const wb = reason === 'off' ? { ...WB, settings: { autoCreatePr: false } } :
      reason === 'linked' ? { ...WB, pullRequestId: 'pr-1' } : WB;
    useWorkbenchStore.getState().upsertWorkbench(wb);
    await controller.send(wb, chat(), { text: 'go' });
    if (reason === 'awaiting_input') useWorkbenchStore.getState().upsertChat(chat({ status: 'awaiting_input' }));
    await controller.handleTurnEnd('c1', {
      ...ok(reason === 'invalid' ? 'Done.\n```talyn-pr\n{broken}\n```' : REPLY),
      cancelled: reason === 'cancelled', isError: reason === 'error',
    });
    expect(api.createPullRequest).not.toHaveBeenCalled();
    expect(prEvents()).toEqual([]);
  });

  it('at the end of the turn commits, pushes and asks the backend to open the PR, then says so in the thread', async () => {
    const { controller, bridge, api } = setup();
    gitWorld(bridge);
    await controller.send(WB, chat(), CREATE_PR);
    await controller.handleTurnEnd('c1', ok());

    expect(gitArgvs(bridge)).toContainEqual(['git', 'commit', '-m', 'feat: wip']);
    expect(gitArgvs(bridge)).toContainEqual(['git', 'push', '-u', 'origin', 'HEAD']);
    expect(api.createPullRequest).toHaveBeenCalledWith('wb1', {
      title: 'feat: add the thing',
      body: '## Summary\nAdds it.',
      commitMessage: 'feat: wip',
      draft: false,
      base: 'main',
      pushed: true,
    });
    expect(prEvents()).toEqual([
      expect.objectContaining({ type: 'talyn_pr', ok: true, number: 12, url: 'https://github.com/acme/app/pull/12', existing: false }),
    ]);
    expect(useWorkbenchStore.getState().workbenches.wb1.pullRequestId).toBe('pr-12');
    expect(api.uploadLocalEvents.mock.calls.flatMap((c) => c[1]).some((e: WorkbenchEvent) => e.event.type === 'talyn_pr')).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
    expect(api.updateLocalChat).toHaveBeenLastCalledWith('c1', expect.objectContaining({ status: 'idle' }));
  });

  it('runs a queued Create PR with its intent', async () => {
    const { controller, bridge } = setup();
    await controller.send(WB, chat(), { text: 'first' });
    expect((await controller.send(WB, chat({ status: 'running' }), CREATE_PR)).queued).toBe(true);
    await controller.handleTurnEnd('c1', ok('done'));
    expect(bridge.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: expect.stringMatching(/```talyn-pr[\s\S]*Create a pull request$/),
        appendSystemPrompt: expect.stringContaining('```talyn-pr'),
      })
    );
  });

  it('records the missing block in the thread and opens nothing', async () => {
    const { controller, bridge, api } = setup();
    gitWorld(bridge);
    await controller.send(WB, chat(), CREATE_PR);
    await controller.handleTurnEnd('c1', ok('I could not work out what changed.'));
    expect(prEvents()).toEqual([
      expect.objectContaining({ ok: false, message: 'The agent did not return a pull request title. Press Create PR to try again.' }),
    ]);
    expect(gitArgvs(bridge).some((a) => a.includes('push'))).toBe(false);
    expect(api.createPullRequest).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'Could not open the pull request',
      'The agent did not return a pull request title. Press Create PR to try again.'
    );
    // It asked the backend for a PR the agent opened itself, by the worktree's HEAD.
    expect(api.adoptPullRequest).toHaveBeenCalledWith('wb1', { sha: HEAD_SHA, branch: 'agent-branch' });
  });

  it('links the PR the agent opened itself, and says so instead of the missing-block error', async () => {
    const { controller, bridge, api } = setup();
    gitWorld(bridge);
    api.adoptPullRequest.mockResolvedValueOnce({
      workbench: { ...WB, branch: 'agent-branch', pullRequestId: 'pr-77' },
      pullRequest: { number: 77, url: 'https://github.com/acme/app/pull/77', headRef: 'agent-branch' },
    });
    await controller.send(WB, chat(), CREATE_PR);
    await controller.handleTurnEnd('c1', ok('Opened https://github.com/acme/app/pull/999.'));
    expect(prEvents()).toEqual([
      expect.objectContaining({ ok: true, adopted: true, existing: true, number: 77, url: 'https://github.com/acme/app/pull/77' }),
    ]);
    expect(useWorkbenchStore.getState().workbenches.wb1).toMatchObject({ branch: 'agent-branch', pullRequestId: 'pr-77' });
    expect(api.createPullRequest).not.toHaveBeenCalled();
    expect(gitArgvs(bridge).some((a) => a.includes('push'))).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([
    ['the backend fails', { head: undefined, fail: true }],
    ['the worktree has no commit', { head: 'fatal: ambiguous argument HEAD\n', fail: false }],
  ])('keeps the missing-block error when %s', async (_name, over) => {
    const { controller, bridge, api } = setup();
    gitWorld(bridge, { head: over.head });
    if (over.fail) api.adoptPullRequest.mockRejectedValueOnce(new Error('offline'));
    await controller.send(WB, chat(), CREATE_PR);
    await controller.handleTurnEnd('c1', ok('No block here.'));
    expect(prEvents()).toEqual([
      expect.objectContaining({ ok: false, message: 'The agent did not return a pull request title. Press Create PR to try again.' }),
    ]);
    if (!over.fail) expect(api.adoptPullRequest).not.toHaveBeenCalled();
  });

  it('records a refused push in the thread and toasts it', async () => {
    const { controller, bridge, api } = setup();
    gitWorld(bridge, { push: { exitCode: 128, stderr: 'remote: Permission to acme/app.git denied to tom.' } });
    await controller.send(WB, chat(), CREATE_PR);
    await controller.handleTurnEnd('c1', ok());
    const [outcome] = prEvents() as unknown as Array<{ ok: boolean; message: string }>;
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/^GitHub refused the push\. Check that your git credentials can write to acme\/app\./);
    expect(api.createPullRequest).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Could not open the pull request', outcome.message);
  });

  it.each([
    ['a failed turn', { isError: true, cancelled: false }],
    ['a cancelled turn', { isError: false, cancelled: true }],
  ])('opens nothing after %s', async (_n, over) => {
    const { controller, bridge, api } = setup();
    gitWorld(bridge);
    await controller.send(WB, chat(), CREATE_PR);
    await controller.handleTurnEnd('c1', { ...ok(), ...over });
    expect(prEvents()).toEqual([]);
    expect(api.createPullRequest).not.toHaveBeenCalled();
  });

  it('opens one PR when the end of the turn is reported twice', async () => {
    const { controller, bridge, api } = setup();
    gitWorld(bridge);
    await controller.send(WB, chat(), CREATE_PR);
    await Promise.all([controller.handleTurnEnd('c1', ok()), controller.handleTurnEnd('c1', ok())]);
    expect(api.createPullRequest).toHaveBeenCalledTimes(1);
    expect(prEvents()).toHaveLength(1);
  });

  it('keeps the chat busy while the PR is opened, so a message sent meanwhile queues', async () => {
    const { controller, bridge, api } = setup();
    gitWorld(bridge);
    let release: () => void = () => {};
    api.createPullRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              workbench: { ...WB, pullRequestId: 'pr-12' },
              pullRequest: { number: 12, url: 'u' },
              existing: false,
            });
        })
    );
    await controller.send(WB, chat(), CREATE_PR);
    const ending = controller.handleTurnEnd('c1', ok());
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.isRunning('c1')).toBe(true);
    expect((await controller.send(WB, chat(), { text: 'next' })).queued).toBe(true);
    release();
    await ending;
    expect(bridge.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'next' }));
  });
});

describe('LocalTurnController session titles', () => {
  function withTitle(answer: string | null | Error) {
    const ctx = setup();
    const generateTitle = jest.fn(async (_input: { agent: string; message: string }) => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const update = jest.fn(async (id: string, patch: { generatedTitle?: string }) => ({
      ...WB,
      id,
      title: patch.generatedTitle ?? null,
    }));
    Object.assign(ctx.bridge, { generateTitle });
    Object.assign(ctx.api, { update });
    return { ...ctx, generateTitle, update };
  }

  it('asks for a title on the first turn and shows it, keeping the name and branch', async () => {
    const { controller, generateTitle, update } = withTitle('Explain Merge Queue');
    await controller.send(WB, chat(), { text: 'explain how the merge queue works' });
    await settle();
    expect(generateTitle).toHaveBeenCalledWith({ agent: 'claude', message: 'explain how the merge queue works' });
    expect(update).toHaveBeenCalledWith('wb1', { generatedTitle: 'Explain Merge Queue' });
    expect(useWorkbenchStore.getState().workbenches.wb1).toMatchObject({
      title: 'Explain Merge Queue',
      name: 'lisbon',
      branch: 'lisbon',
    });
  });

  it('does not ask after the first turn', async () => {
    const { controller, generateTitle } = withTitle('Explain Merge Queue');
    useWorkbenchStore.getState().appendEvents('c1', [{ chatId: 'c1', seq: 1, turn: 1, event: { seq: 1, type: 'user' } as never }]);
    await controller.send(WB, chat(), { text: 'next' });
    await settle();
    expect(generateTitle).not.toHaveBeenCalled();
  });

  it.each([
    ['no title', null],
    ['a failed call', new Error('spawn failed')],
  ])('keeps the name, and still runs the turn, on %s', async (_label, answer) => {
    const { controller, bridge, update } = withTitle(answer);
    await controller.send(WB, chat(), { text: 'explain it' });
    await settle();
    expect(bridge.startTurn).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState().workbenches.wb1.title).toBeUndefined();
  });

  it('never asks for a session that already has a title', async () => {
    const { controller, generateTitle } = withTitle('Explain Merge Queue');
    await controller.send({ ...WB, title: 'My own name' }, chat(), { text: 'explain it' });
    await settle();
    expect(generateTitle).not.toHaveBeenCalled();
  });

  it('does not send a title when a person set one while the call ran', async () => {
    const { controller, generateTitle, update } = withTitle('Explain Merge Queue');
    let release!: (v: string) => void;
    generateTitle.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const pending = controller.generateTitle(WB, 'claude', 'explain it');
    useWorkbenchStore.getState().upsertWorkbench({ ...WB, title: 'My own name' });
    release('Explain Merge Queue');
    await pending;
    expect(update).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState().workbenches.wb1.title).toBe('My own name');
  });

  it('asks once per session', async () => {
    const { controller, generateTitle } = withTitle(null);
    await controller.generateTitle(WB, 'claude', 'one');
    await controller.generateTitle(WB, 'claude', 'two');
    expect(generateTitle).toHaveBeenCalledTimes(1);
  });

  it('does nothing with an older main process that has no title call', async () => {
    const { controller, bridge, api } = setup();
    await controller.send(WB, chat(), { text: 'explain it' });
    await settle();
    expect(bridge.startTurn).toHaveBeenCalledTimes(1);
    expect('update' in api).toBe(false);
  });
});
