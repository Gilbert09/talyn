/** @jest-environment node */
import { promises as fs } from 'fs';
import path from 'path';
import { AgentProcesses } from '../agentProcess';
import { WorkbenchPaths } from '../paths';
import * as environment from '../environment';
import { temporaryRepo, testEnv } from '../testSupport';

let directory: string;
let repo: string;
let agents: AgentProcesses | undefined;
beforeEach(async () => {
  ({ directory, repo } = await temporaryRepo());
  jest.spyOn(environment, 'processEnv').mockResolvedValue(testEnv);
});
afterEach(async () => {
  await agents?.shutdown();
  jest.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

const input = {
  workbenchId: 'wb',
  chatId: 'chat',
  turn: 1,
  agent: 'claude' as const,
  prompt: 'hello',
  planMode: false,
};

test.each(['claude', 'codex'] as const)(
  'handles split lines, UTF-8, and an unterminated %s result',
  async (agent) => {
    const frames: Array<{ channel: string; payload: Record<string, unknown> }> =
      [];
    let ended = () => {};
    const done = new Promise<void>((resolve) => {
      ended = resolve;
    });
    const cli = path.join(directory, 'fake.cjs');
    const lines =
      agent === 'claude'
        ? [
            { type: 'system', subtype: 'init', session_id: 'session' },
            {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'hello 🌍' }] },
            },
            {
              type: 'result',
              subtype: 'success',
              result: 'done',
              is_error: false,
            },
          ]
        : [
            { type: 'thread.started', thread_id: 'session' },
            {
              type: 'item.completed',
              item: { id: 'm', type: 'agent_message', text: 'hello 🌍' },
            },
            {
              type: 'turn.completed',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          ];
    await fs.writeFile(
      cli,
      `const data = Buffer.from(${JSON.stringify(lines.map((line) => JSON.stringify(line)).join('\n'))});
let i = 0; const timer = setInterval(() => { process.stdout.write(data.subarray(i, i + 3)); i += 3; if (i >= data.length) clearInterval(timer); }, 1);`,
    );
    agents = new AgentProcesses(
      new WorkbenchPaths(path.join(directory, 'state')),
      (channel, payload) => {
        frames.push({ channel, payload: payload as Record<string, unknown> });
        if (channel === 'workbench:turn-end') ended();
      },
      () => [process.execPath, cli],
    );
    await agents.startTurn({ ...input, path: repo, agent });
    await done;
    expect(frames[0].channel).toBe('workbench:checkpoint');
    expect(frames[0].payload.sha).toMatch(/^[0-9a-f]{40}$/);
    const events = frames.filter(
      (frame) => frame.channel === 'workbench:turn-event',
    );
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.every(
        (frame) =>
          frame.payload.turn === 1 &&
          !('seq' in (frame.payload.event as object)),
      ),
    ).toBe(true);
    expect(JSON.stringify(events)).toContain('hello 🌍');
    expect(frames.at(-1)?.payload).toMatchObject({
      sessionId: 'session',
      isError: false,
      exitCode: 0,
      cancelled: false,
    });
  },
);

test('includes stderr when a CLI fails', async () => {
  let ended = (_payload: unknown) => {};
  const done = new Promise<unknown>((resolve) => {
    ended = resolve;
  });
  agents = new AgentProcesses(
    new WorkbenchPaths(path.join(directory, 'state')),
    (channel, payload) => {
      if (channel === 'workbench:turn-end') ended(payload);
    },
    () => [
      process.execPath,
      '-e',
      'process.stderr.write("failure detail"); process.exitCode = 3',
    ],
  );
  await agents.startTurn({ ...input, path: repo });
  expect(await done).toMatchObject({
    exitCode: 3,
    isError: true,
    error: expect.stringContaining('failure detail'),
  });
});

test('reserves the chat during checkpoint creation and cancels the process', async () => {
  const emit = jest.fn();
  agents = new AgentProcesses(
    new WorkbenchPaths(path.join(directory, 'state')),
    emit,
    () => [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
  );
  const first = agents.startTurn({ ...input, path: repo });
  await expect(agents.startTurn({ ...input, path: repo })).rejects.toThrow(
    'already running',
  );
  await first;
  await agents.cancelTurn('chat');
  expect(emit).toHaveBeenCalledWith(
    'workbench:turn-end',
    expect.objectContaining({ cancelled: true, isError: false }),
  );
});
