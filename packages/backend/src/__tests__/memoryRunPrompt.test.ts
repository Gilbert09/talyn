import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { MAX_MEMORY_INDEX_BYTES, renderMemoryIndex, type Environment, type Task } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  environments,
  integrations,
  repositories,
  workspaceMemories,
  workspaces,
} from '../db/schema.js';

/**
 * Workspace memory in a task run: the fleet dispatch carries the read-only
 * index in its system prompt when memory is on, and nothing when it is off.
 * Loops create ordinary tasks, so this is their path too.
 */

const createSandbox = vi.fn();

vi.mock('../services/selfHosted/client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/selfHosted/client.js')>(
    '../services/selfHosted/client.js',
  );
  return { ...actual, FleetClient: class { createSandbox = createSandbox; } };
});

vi.mock('../services/github.js', () => ({
  githubService: { getVerifiedAccessToken: vi.fn(async () => 'gho_token') },
}));

const { dispatchTaskToFleet } = await import('../services/selfHosted/executor.js');
const { memoryIndexForRun, withMemoryIndex } = await import('../services/workbenches/memory.js');
const { TASK_SYSTEM_PROMPT } = await import('../services/selfHosted/systemPrompts.js');

const ENV = { id: 'fleet1', name: 'Talyn Fleet', type: 'selfhosted', status: 'connected', config: { type: 'selfhosted' } } as unknown as Environment;

const task = (repositoryId = 'repo1'): Task =>
  ({
    id: 't1',
    workspaceId: 'ws1',
    type: 'code_writing',
    status: 'queued',
    priority: 'medium',
    title: 'work',
    description: 'd',
    prompt: 'do the thing',
    repositoryId,
    metadata: { model: 'claude-sonnet-5' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as unknown as Task;

const READ_ONLY = 'Memory from earlier sessions. You cannot change it in this run.';

describe('the memory index in a task run', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let priorTokenKey: string | undefined;
  let seq = 0;

  const remember = (over: Partial<typeof workspaceMemories.$inferInsert> = {}) =>
    db.insert(workspaceMemories).values({
      id: `mem-${++seq}`,
      workspaceId: 'ws1',
      ownerId: TEST_USER_ID,
      scope: 'workspace',
      type: 'project',
      name: `entry ${seq}`,
      description: `about ${seq}`,
      body: 'the body stays out',
      ...over,
    });
  const setMemory = (on: boolean) =>
    db.update(workspaces).set({ settings: { sessionMemory: on } }).where(eq(workspaces.id, 'ws1'));
  const sentSystemPrompt = () =>
    (createSandbox.mock.calls[0]![0] as { task: { systemPrompt: string } }).task.systemPrompt;

  beforeEach(async () => {
    priorTokenKey = process.env.TALYN_TOKEN_KEY;
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    process.env.FLEET_API_TOKEN = 'fleet-token';
    process.env.FLEET_PINNED_ENDPOINT = 'https://fleet.test';
    ({ db, cleanup } = await createTestDb());
    const { encryptString } = await import('../services/tokenCrypto.js');
    createSandbox.mockReset();
    createSandbox.mockResolvedValue({ sandbox: { id: 'sb1', status: 'running' }, host: 'h' });
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.com' });
    await db.insert(workspaces).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
    await db.insert(repositories).values([
      { id: 'repo1', workspaceId: 'ws1', name: 'a/b', url: 'https://github.com/a/b', defaultBranch: 'main' },
      { id: 'repo2', workspaceId: 'ws1', name: 'a/c', url: 'https://github.com/a/c', defaultBranch: 'main' },
    ]);
    await db.insert(environments).values({
      id: 'fleet1', ownerId: TEST_USER_ID, name: 'Talyn Fleet', type: 'selfhosted', status: 'connected', config: { type: 'selfhosted' },
    });
    await db.insert(integrations).values({
      id: 'int1', workspaceId: 'ws1', type: 'selfhosted', enabled: true, config: { anthropicKeyEnc: encryptString('sk-ant-api-test') },
    });
  });

  afterEach(async () => {
    await cleanup();
    if (priorTokenKey === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = priorTokenKey;
    delete process.env.FLEET_API_TOKEN;
    delete process.env.FLEET_PINNED_ENDPOINT;
  });

  it('sends the task prompt alone when the workspace has no entry', async () => {
    expect(await dispatchTaskToFleet(task(), ENV)).toEqual({ ok: true });
    expect(sentSystemPrompt()).toBe(TASK_SYSTEM_PROMPT);
  });

  it("appends the read-only index: the workspace's and the task repository's entries, no bodies", async () => {
    await remember({ name: 'pnpm only', description: 'Use pnpm, never npm', type: 'feedback' });
    await remember({ scope: 'repository', repositoryId: 'repo1', name: 'flaky e2e', description: 'e2e retries once' });
    await remember({ scope: 'repository', repositoryId: 'repo2', name: 'other repo', description: 'not this one' });
    await remember({ name: 'gone', description: 'forgotten', forgottenAt: new Date() });

    expect(await dispatchTaskToFleet(task(), ENV)).toEqual({ ok: true });

    const sent = sentSystemPrompt();
    expect(sent.startsWith(`${TASK_SYSTEM_PROMPT}\n\n# Talyn memory`)).toBe(true);
    expect(sent).toContain(READ_ONLY);
    expect(sent).toContain('- pnpm only (feedback, workspace): Use pnpm, never npm');
    expect(sent).toContain('- flaky e2e (project, repository): e2e retries once');
    for (const absent of ['other repo', 'forgotten', 'the body stays out', 'talyn_memory_']) {
      expect(sent).not.toContain(absent);
    }
  });

  it('omits the index when memory is off', async () => {
    await remember();
    await setMemory(false);
    expect(await dispatchTaskToFleet(task(), ENV)).toEqual({ ok: true });
    expect(sentSystemPrompt()).toBe(TASK_SYSTEM_PROMPT);
  });

  it.each([
    ['explicitly on', true],
    ['unset', undefined],
  ])('includes the index when the setting is %s', async (_label, value) => {
    await remember();
    await db.update(workspaces).set({ settings: value === undefined ? {} : { sessionMemory: value } }).where(eq(workspaces.id, 'ws1'));
    await dispatchTaskToFleet(task(), ENV);
    expect(sentSystemPrompt()).toContain(READ_ONLY);
  });

  it('still dispatches, with no index, when the memory read fails', async () => {
    await remember();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = { workspaceId: 'ws1', repositoryId: 'repo1' };
    // A repository id the query cannot bind makes the read throw.
    expect(await memoryIndexForRun({ ...failing, repositoryId: Symbol('bad') as unknown as string })).toBe('');
    expect(await withMemoryIndex('base', { ...failing, repositoryId: Symbol('bad') as unknown as string })).toBe('base');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('places the index after the prompt by default, or before it, with no trailing blank line', async () => {
    await remember({ name: 'only', description: 'one entry' });
    const after = await withMemoryIndex('base', { workspaceId: 'ws1', repositoryId: 'repo1' });
    expect(after.startsWith('base\n\n# Talyn memory')).toBe(true);
    expect(after.endsWith('- only (project, workspace): one entry')).toBe(true);
    const before = await withMemoryIndex('base', { workspaceId: 'ws1', repositoryId: 'repo1', placement: 'before' });
    expect(before.startsWith('# Talyn memory')).toBe(true);
    expect(before.endsWith('one entry\n\nbase')).toBe(true);
  });
});

describe('renderMemoryIndex, read-only', () => {
  const item = (i: number, description = `about ${i}`) => ({ name: `entry ${i}`, type: 'project' as const, scope: 'workspace' as const, description });

  it('names no memory tool, and says the run cannot change it', () => {
    const out = renderMemoryIndex([item(1)], MAX_MEMORY_INDEX_BYTES, { readOnly: true });
    expect(out).toContain(READ_ONLY);
    expect(out).not.toContain('talyn_memory_');
    expect(out).toContain('- entry 1 (project, workspace): about 1');
  });

  it('says how many entries it left out, within the cap, with no tool to find them', () => {
    const entries = Array.from({ length: 50 }, (_, i) => item(i, 'x'.repeat(150)));
    const max = 2048;
    const out = renderMemoryIndex(entries, max, { readOnly: true });
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(max);
    expect(out).toMatch(/\n\d+ more entries are not shown\.\n$/);
    expect(out).not.toContain('talyn_memory_');
  });

  it('keeps the session wording by default', () => {
    expect(renderMemoryIndex([item(1)])).toContain('talyn_memory_read');
    expect(renderMemoryIndex([item(1)])).not.toContain(READ_ONLY);
  });

  it('is empty with no entries', () => {
    expect(renderMemoryIndex([], MAX_MEMORY_INDEX_BYTES, { readOnly: true })).toBe('');
  });
});
