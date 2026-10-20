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

const { generateSandboxTitle } = await import('../services/workbenches/title.js');
const { getWorkbench, insertWorkbench, setGeneratedTitle, updateWorkbench } = await import(
  '../services/workbenches/store.js'
);

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
});
