import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWorkbenchTitleArgv,
  FLEET_MODELS,
  sanitizeWorkbenchTitle,
  workbenchDisplayName,
  workbenchTitlePrompt,
  WORKBENCH_TITLE_MAX,
  WORKBENCH_TITLE_MODELS,
} from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, workspaces } from '../db/schema.js';

const emitted: Array<{ type: string; payload: unknown }> = [];

vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: (_workspaceId: string, event: { type: string; payload: unknown }) => {
    emitted.push({ type: event.type, payload: event.payload });
  },
}));

const { generateSandboxTitle, startTitleFromQueue, startTitleGeneration, resetTitleAttempts, MAX_TITLE_FAILURES } = await import(
  '../services/workbenches/title.js'
);
const { appendEvents, getWorkbench, insertChat, insertWorkbench, setGeneratedTitle, updateWorkbench } = await import(
  '../services/workbenches/store.js'
);
const { userMessageEvent } = await import('../services/workbenches/turns.js');

describe('sanitizeWorkbenchTitle', () => {
  it.each([
    ['a plain title', 'Explain Merge Queue', 'Explain Merge Queue'],
    ['a trailing newline', 'Explain Merge Queue\n', 'Explain Merge Queue'],
    ['CRLF at the end', 'Explain Merge Queue\r\n', 'Explain Merge Queue'],
    ['double quotes', '"Fix the login redirect"', 'Fix the login redirect'],
    ['curly quotes', '“Fix the login redirect”', 'Fix the login redirect'],
    ['single quotes round it', "'Fix the login redirect'", 'Fix the login redirect'],
    ['backticks', '`Fix flaky tests`', 'Fix flaky tests'],
    ['an apostrophe inside', "Fix the user's session", "Fix the user's session"],
    ['a trailing full stop', 'Add dark mode.', 'Add dark mode'],
    ['an ellipsis', 'Add dark mode...', 'Add dark mode'],
    ['a trailing colon', 'Add dark mode:', 'Add dark mode'],
    ['a quoted title with a full stop', '"Add dark mode."', 'Add dark mode'],
    ['inner whitespace', '  Add    dark\tmode  ', 'Add dark mode'],
    ['markdown bold', '**Add dark mode**', 'Add dark mode'],
    ['a heading', '# Add dark mode', 'Add dark mode'],
    ['a Title: label', 'Title: Add dark mode', 'Add dark mode'],
    ['snake_case kept', 'Rename user_id column', 'Rename user_id column'],
    ['sentence case kept', 'Speed up the PR list', 'Speed up the PR list'],
    ['non-ASCII kept', 'Café menu ünïcode fix', 'Café menu ünïcode fix'],
  ])('keeps %s', (_label, raw, expected) => {
    expect(sanitizeWorkbenchTitle(raw)).toBe(expected);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['only whitespace', '   \n  '],
    ['only quotes', '""'],
    ['only punctuation', '...'],
    ['two lines', 'Add dark mode\nTo the settings page'],
    ['a stream-json reply', '{"type":"system"}\n{"type":"result"}'],
    ['a reply far too long to be a title', `Sure! ${'here is a long explanation of what I would do '.repeat(4)}`],
  ])('refuses %s', (_label, raw) => {
    expect(sanitizeWorkbenchTitle(raw as string | null | undefined)).toBeNull();
  });

  it('cuts a long title at a word boundary', () => {
    const raw = 'Refactor the workbench provisioning flow to support multiple hosts';
    const title = sanitizeWorkbenchTitle(raw)!;
    expect(title.length).toBeLessThanOrEqual(WORKBENCH_TITLE_MAX);
    expect(raw.startsWith(title)).toBe(true);
    expect(raw[title.length]).toBe(' ');
  });

  it('hard-cuts one very long word', () => {
    const title = sanitizeWorkbenchTitle('x'.repeat(80))!;
    expect(title).toBe('x'.repeat(WORKBENCH_TITLE_MAX));
  });

  it('keeps a title of exactly the maximum length', () => {
    const raw = `${'a'.repeat(WORKBENCH_TITLE_MAX - 5)} bcde`;
    expect(sanitizeWorkbenchTitle(raw)).toBe(raw);
  });
});

describe('workbenchTitlePrompt', () => {
  it('asks for a short title and carries the message', () => {
    const prompt = workbenchTitlePrompt('  explain how the merge queue works  ');
    expect(prompt).toMatch(/2 to 6 words/);
    expect(prompt).toMatch(/no quotes, no trailing full stop/);
    expect(prompt.endsWith('explain how the merge queue works')).toBe(true);
  });

  it('carries only the start of a very long message', () => {
    const prompt = workbenchTitlePrompt(`fix it ${'log line\n'.repeat(5000)}`);
    expect(prompt.length).toBeLessThan(2600);
    expect(prompt).toContain('fix it');
  });
});

describe('buildWorkbenchTitleArgv', () => {
  it('uses the haiku alias for claude', () => {
    expect(buildWorkbenchTitleArgv('claude', 'p')).toContain('haiku');
  });

  it('uses an OpenAI catalogue model for codex', () => {
    const model = WORKBENCH_TITLE_MODELS.codex;
    expect(FLEET_MODELS.find((m) => m.id === model)?.provider).toBe('openai');
    expect(buildWorkbenchTitleArgv('codex', 'p')).toContain(model);
  });

  it('runs claude with text output, no tools and no saved session, the prompt last', () => {
    expect(buildWorkbenchTitleArgv('claude', '- a prompt')).toEqual([
      'claude', '-p', '--output-format', 'text', '--model', 'haiku',
      '--no-session-persistence', '--tools', '', '--', '- a prompt',
    ]);
  });

  it('runs codex read-only and ephemeral, the prompt last', () => {
    const argv = buildWorkbenchTitleArgv('codex', '- a prompt');
    expect(argv.slice(0, 4)).toEqual(['codex', 'exec', '--ephemeral', '--skip-git-repo-check']);
    expect(argv).toContain('sandbox_mode="read-only"');
    expect(argv).toContain('approval_policy="never"');
    expect(argv.slice(-2)).toEqual(['--', '- a prompt']);
  });
});

describe('workbenchDisplayName', () => {
  it.each([
    [{ name: 'paris', title: 'Fix login' }, 'Fix login'],
    [{ name: 'paris', title: null }, 'paris'],
    [{ name: 'paris' }, 'paris'],
    [{ name: 'paris', title: '   ' }, 'paris'],
  ])('%j shows %s', (wb, expected) => {
    expect(workbenchDisplayName(wb)).toBe(expected);
  });
});

describe('generateSandboxTitle', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  const reply = (stdout: string, exitCode = 0) => async () => ({
    exitCode,
    stdout,
    stderr: '',
    stdoutBytes: Buffer.from(stdout),
  });

  beforeEach(async () => {
    emitted.length = 0;
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
    await testDb.db.insert(repositories).values({ id: 'repo-a', workspaceId: 'ws-a', name: 'o/r', url: 'https://github.com/o/r' });
    await insertWorkbench({
      id: 'wb-1', workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'o/r', name: 'explain-merge-queue',
      branch: 'tom/explain-merge-queue', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
      sandboxId: 'talyn-wb-wb-1',
    });
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  const row = async () => (await getWorkbench('wb-1'))!;
  const userMessage = (text: string, origin?: 'user' | 'talyn') => userMessageEvent({
    id: text, text, origin, queuedAt: new Date().toISOString(),
  });

  it('sets the title, keeps the name and branch, and broadcasts the update', async () => {
    const run = vi.fn(reply('"Explain the Merge Queue."\n'));
    const updated = await generateSandboxTitle(await row(), 'explain how the merge queue works', { run });
    expect(updated).toMatchObject({ title: 'Explain the Merge Queue', name: 'explain-merge-queue', branch: 'tom/explain-merge-queue' });
    const [, script, opts] = run.mock.calls[0] as unknown as [unknown, string, { cwd: string; timeoutMs: number; quiet: boolean }];
    expect(script.startsWith('claude -p --output-format text --model haiku')).toBe(true);
    expect(opts).toMatchObject({ cwd: '/tmp', timeoutMs: 30_000, quiet: true });
    const event = emitted.find((e) => e.type === 'workbench:updated');
    expect((event?.payload as { workbench: { title: string } }).workbench.title).toBe('Explain the Merge Queue');
  });

  it('runs codex for a codex session', async () => {
    await updateWorkbench('wb-1', { agent: 'codex' });
    const run = vi.fn(reply('Explain merge queue'));
    await generateSandboxTitle(await row(), 'explain it', { run });
    expect((run.mock.calls[0] as unknown as [unknown, string])[1].startsWith('codex exec --ephemeral')).toBe(true);
  });

  // A box started while Claude had no usable key holds only the Codex key.
  it.each([
    ['the session agent the box holds', 'claude', ['claude', 'codex'], undefined, 'claude'],
    ['the box key when the session agent has none', 'claude', ['codex'], undefined, 'codex'],
    ['the box key for a codex session in a claude box', 'codex', ['claude'], undefined, 'claude'],
    ['the preferred agent the box holds', 'claude', ['claude', 'codex'], 'codex', 'codex'],
    ['the box key when the preferred agent has none', 'codex', ['claude'], 'codex', 'claude'],
    ['the session agent when the box has no record', 'codex', null, undefined, 'codex'],
  ] as const)('runs %s', async (_label, sessionAgent, held, preferred, expected) => {
    await updateWorkbench('wb-1', {
      agent: sessionAgent,
      ...(held ? { settings: { sandboxAgents: { 'talyn-wb-wb-1': [...held] } } } : {}),
    });
    const run = vi.fn(reply('Explain Merge Queue'));
    await generateSandboxTitle(await row(), 'explain it', { run, agent: preferred });
    expect((run.mock.calls[0] as unknown as [unknown, string])[1].split(' ')[0]).toBe(expected);
    expect((await row()).title).toBe('Explain Merge Queue');
  });

  it.each([
    ['a non-zero exit', reply('Usage limit reached', 1)],
    ['empty output', reply('')],
    ['multi-line output', reply('Here is a title:\nExplain Merge Queue')],
    ['a fleet error', async () => { throw new Error('fleet down'); }],
  ])('keeps the name on %s', async (_label, run) => {
    expect(await generateSandboxTitle(await row(), 'explain it', { run })).toBeNull();
    expect((await row()).title).toBeNull();
    expect(emitted).toEqual([]);
  });

  it('keeps the name when the call never answers', async () => {
    const run = vi.fn(() => new Promise<never>(() => {}));
    const started = Date.now();
    expect(await generateSandboxTitle(await row(), 'explain it', { run, timeoutMs: 20, graceMs: 0 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await row()).title).toBeNull();
  });

  it('never replaces a title a person set, even one set while the call ran', async () => {
    const before = await row();
    await updateWorkbench('wb-1', { title: 'My own name' });
    expect(await generateSandboxTitle(before, 'explain it', { run: reply('Explain Merge Queue') })).toBeNull();
    expect((await row()).title).toBe('My own name');
    expect(emitted).toEqual([]);
  });

  it('writes a generated title only once', async () => {
    expect(await setGeneratedTitle('wb-1', 'First')).not.toBeNull();
    expect(await setGeneratedTitle('wb-1', 'Second')).toBeNull();
    expect((await row()).title).toBe('First');
  });

  it('skips an empty first message without a call', async () => {
    const run = vi.fn(reply('x'));
    expect(await generateSandboxTitle(await row(), '   ', { run })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  describe('startTitleGeneration', () => {
    beforeEach(() => resetTitleAttempts());

    it('titles a session whose first turn failed, on the retry turn', async () => {
      const failing = vi.fn(reply('', 1));
      await startTitleGeneration(await row(), 'turn one', { run: failing });
      expect((await row()).title).toBeNull();
      await startTitleGeneration(await row(), 'turn two', { run: reply('Fix Retry Titles') });
      expect((await row()).title).toBe('Fix Retry Titles');
    });

    it.each([
      ['a rate limit', 'Continue from where you stopped. The last turn ended with an error: API Error: Request rejected (429).', 'talyn'],
      ['an API outage', 'Continue from where you stopped. The last turn ended because the model API failed: overloaded.', 'talyn'],
      ['a later user message', 'Please continue', 'user'],
    ] as const)('retries the original task after %s', async (_label, retry, origin) => {
      await insertChat({ id: 'chat-1', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Chat', agent: 'claude' });
      await appendEvents('chat-1', [{ turn: 1, event: userMessage('Add missing warehouse endpoint tables') }]);
      await startTitleGeneration(await row(), 'Add missing warehouse endpoint tables', { run: reply('', 1) });
      await appendEvents('chat-1', [{ turn: 2, event: userMessage(retry, origin) }]);
      const run = vi.fn(reply('Add Missing Warehouse Tables'));
      await startTitleGeneration(await row(), retry, { run, agent: 'codex', origin });
      const script = (run.mock.calls[0] as unknown as [unknown, string])[1];
      expect(script).toContain('Add missing warehouse endpoint tables');
      expect(script).not.toContain(retry);
      expect((await row()).title).toBe('Add Missing Warehouse Tables');
    });

    it('ignores automatic and empty messages when it finds the original task', async () => {
      await insertChat({ id: 'chat-1', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Chat', agent: 'claude', closedAt: new Date() });
      await appendEvents('chat-1', [
        { turn: 1, event: userMessage('Background job exited', 'talyn') },
        { turn: 2, event: userMessage('   ') },
        { turn: 3, event: userMessage('Fix the login redirect') },
        { turn: 3, event: { type: 'assistant', message: { content: [{ type: 'text', text: 'Checking the redirect' }] } } },
      ]);
      await insertChat({ id: 'chat-2', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'New chat', agent: 'codex' });
      await appendEvents('chat-2', [{ turn: 1, event: userMessage('Continue the task', 'talyn') }]);
      const run = vi.fn(reply('Fix Login Redirect'));
      await startTitleGeneration(await row(), 'Continue the task', { run, origin: 'talyn' });
      expect((run.mock.calls[0] as unknown as [unknown, string])[1]).toContain('Fix the login redirect');
    });

    it('keeps the name when an automatic turn has no original task', async () => {
      const run = vi.fn(reply('Resume After Rate Limit'));
      await startTitleGeneration(await row(), 'Continue after a rate limit', { run, origin: 'talyn' });
      expect(run).not.toHaveBeenCalled();
      expect((await row()).title).toBeNull();
    });

    it('titles a recovered session on a later turn number', async () => {
      await updateWorkbench('wb-1', { sandboxId: 'talyn-wb-wb-1-r1' });
      await startTitleGeneration(await row(), 'turn five', { run: reply('Recovered Session') });
      expect((await row()).title).toBe('Recovered Session');
    });

    it('never replaces a title a person set', async () => {
      await updateWorkbench('wb-1', { title: 'My own name' });
      const run = vi.fn(reply('Generated'));
      await startTitleGeneration(await row(), 'later turn', { run });
      expect(run).not.toHaveBeenCalled();
      expect((await row()).title).toBe('My own name');
    });

    it('does not run again after the bound of failed tries', async () => {
      const run = vi.fn(reply('', 1));
      for (let i = 0; i < MAX_TITLE_FAILURES + 2; i++) await startTitleGeneration(await row(), 'msg', { run });
      expect(run).toHaveBeenCalledTimes(MAX_TITLE_FAILURES);
    });

    it('runs one call at a time per session', async () => {
      let release: (v: { exitCode: number; stdout: string; stderr: string; stdoutBytes: Buffer }) => void = () => {};
      const slow = vi.fn(() => new Promise<{ exitCode: number; stdout: string; stderr: string; stdoutBytes: Buffer }>((r) => { release = r; }));
      const first = startTitleGeneration(await row(), 'a', { run: slow });
      await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(1));
      await startTitleGeneration(await row(), 'b', { run: slow });
      expect(slow).toHaveBeenCalledTimes(1);
      release({ exitCode: 0, stdout: 'Slow Title', stderr: '', stdoutBytes: Buffer.from('Slow Title') });
      await first;
      expect((await row()).title).toBe('Slow Title');
    });
  });

  describe('startTitleFromQueue', () => {
    beforeEach(() => resetTitleAttempts());

    const queued = (text: string) => ({ text, queuedAt: new Date().toISOString() });
    const chat = (id: string, texts: string[], extra: { closedAt?: Date } = {}) =>
      insertChat({ id, workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Chat', agent: 'claude', queuedMessages: texts.map(queued), ...extra });

    it('titles the session from the first queued message, before any turn', async () => {
      await chat('chat-1', ['explain how the merge queue works']);
      const run = vi.fn(reply('Explain Merge Queue'));
      await startTitleFromQueue(await row(), { run });
      expect((await row()).title).toBe('Explain Merge Queue');
      expect((run.mock.calls[0] as unknown as [unknown, string])[1]).toContain('explain how the merge queue works');
    });

    it.each([
      ['no chat', [] as Array<{ texts: string[]; closed?: boolean }>],
      ['an empty queue', [{ texts: [] }]],
      ['only blank messages', [{ texts: ['   ', ''] }]],
      ['a message only in a closed chat', [{ texts: ['fix it'], closed: true }]],
    ])('makes no call with %s', async (_label, chats) => {
      for (const [i, c] of chats.entries()) await chat(`chat-${i}`, c.texts, c.closed ? { closedAt: new Date() } : {});
      const run = vi.fn(reply('Generated'));
      await startTitleFromQueue(await row(), { run });
      expect(run).not.toHaveBeenCalled();
      expect((await row()).title).toBeNull();
    });

    it('skips a blank message and uses the next one', async () => {
      await chat('chat-1', ['  ', 'add dark mode']);
      const run = vi.fn(reply('Add Dark Mode'));
      await startTitleFromQueue(await row(), { run });
      expect((run.mock.calls[0] as unknown as [unknown, string])[1]).toContain('add dark mode');
      expect((await row()).title).toBe('Add Dark Mode');
    });

    it('skips automatic messages in the queue', async () => {
      await insertChat({
        id: 'chat-1', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Chat', agent: 'codex',
        queuedMessages: [{ ...queued('Continue after a rate limit'), origin: 'talyn' }, queued('add dark mode')],
      });
      const run = vi.fn(reply('Add Dark Mode'));
      await startTitleFromQueue(await row(), { run });
      const script = (run.mock.calls[0] as unknown as [unknown, string])[1];
      expect(script).toContain('add dark mode');
      expect(script).not.toContain('Continue after a rate limit');
    });

    it('keeps the name when only automatic messages are queued', async () => {
      await insertChat({
        id: 'chat-1', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Chat', agent: 'codex',
        queuedMessages: [{ ...queued('Continue after a rate limit'), origin: 'talyn' }],
      });
      const run = vi.fn(reply('Resume After Rate Limit'));
      await startTitleFromQueue(await row(), { run });
      expect(run).not.toHaveBeenCalled();
      expect((await row()).title).toBeNull();
    });

    it('uses the original task when a later message is queued after recovery', async () => {
      await chat('chat-1', ['Please continue']);
      await appendEvents('chat-1', [{ turn: 1, event: userMessage('Fix the login redirect') }]);
      const run = vi.fn(reply('Fix Login Redirect'));
      await startTitleFromQueue(await row(), { run });
      const script = (run.mock.calls[0] as unknown as [unknown, string])[1];
      expect(script).toContain('Fix the login redirect');
      expect(script).not.toContain('Please continue');
    });

    it('never replaces a title a person set', async () => {
      await chat('chat-1', ['fix it']);
      await updateWorkbench('wb-1', { title: 'My own name' });
      const run = vi.fn(reply('Generated'));
      await startTitleFromQueue(await row(), { run });
      expect(run).not.toHaveBeenCalled();
    });

    it.each([
      ['codex', 'codex exec'],
      ['claude', 'claude -p'],
    ] as const)('asks the agent of the chat that holds the message (%s)', async (agent, command) => {
      await updateWorkbench('wb-1', { settings: { sandboxAgents: { 'talyn-wb-wb-1': ['claude', 'codex'] } } });
      await insertChat({ id: 'chat-1', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Chat', agent, queuedMessages: [queued('fix it')] });
      const run = vi.fn(reply('Fix It'));
      await startTitleFromQueue(await row(), { run });
      expect((run.mock.calls[0] as unknown as [unknown, string])[1].startsWith(command)).toBe(true);
    });

    it('titles a claude session whose box holds only the codex key', async () => {
      await updateWorkbench('wb-1', { settings: { sandboxAgents: { 'talyn-wb-wb-1': ['codex'] } } });
      await chat('chat-1', ['fix the scaffolding prompt']);
      const run = vi.fn(reply('Fix Scaffolding Prompt'));
      await startTitleFromQueue(await row(), { run });
      expect((run.mock.calls[0] as unknown as [unknown, string])[1].startsWith('codex exec')).toBe(true);
      expect((await row()).title).toBe('Fix Scaffolding Prompt');
    });

    it('lets the first turn try again after an early failure', async () => {
      await chat('chat-1', ['fix it']);
      await startTitleFromQueue(await row(), { run: reply('', 1) });
      expect((await row()).title).toBeNull();
      await startTitleGeneration(await row(), 'fix it', { run: reply('Fix It') });
      expect((await row()).title).toBe('Fix It');
    });
  });
});
