import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import { getScopedDb, runInScopedDb, type Database } from '../db/client.js';
import { workspaces as workspacesTable, repositories as repositoriesTable } from '../db/schema.js';
import { githubService } from '../services/github.js';
import { refreshWebhookIndex, _resetWebhookIndex } from '../services/webhookIndex.js';
import { refreshInBackground } from '../routes/repositories.js';

vi.mock('../services/github.js', async () => {
  const actual = await vi.importActual<typeof import('../services/github.js')>('../services/github.js');
  return { ...actual, githubService: { canAccessRepository: vi.fn() } };
});

/**
 * Work a request starts and does not wait for must run on the pool. In the
 * request's owner scope its queries reach the request transaction after the
 * transaction has ended. On 2026-11-12 the sandbox-size and preview refreshes
 * did that, held row locks on `repositories`, and filled the pool.
 */
describe('background work started by a request leaves the owner scope', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  // Stands in for the request transaction. Only its identity matters here.
  const requestTx = {} as Database;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'wsA', ownerId: TEST_USER_ID, name: 'A', settings: {} });
    await db.insert(repositoriesTable).values({
      id: 'rA', workspaceId: 'wsA', name: 'acme/widget', url: 'https://github.com/acme/widget', defaultBranch: 'main',
    });
    _resetWebhookIndex();
  });

  afterEach(async () => {
    _resetWebhookIndex();
    await cleanup();
    vi.restoreAllMocks();
  });

  it('sees the request scope inside runInScopedDb (control)', () => {
    expect(runInScopedDb(requestTx, () => getScopedDb())).toBe(requestTx);
  });

  it.each([
    ['before its first await', async () => getScopedDb()],
    ['after an await', async () => { await Promise.resolve(); return getScopedDb(); }],
    ['after a timer', async () => { await new Promise((r) => setTimeout(r, 1)); return getScopedDb(); }],
  ])('refreshInBackground sees no scope %s', async (label, read) => {
    const seen = await new Promise<Database | undefined>((resolve) => {
      runInScopedDb(requestTx, () => {
        refreshInBackground(`test:${label}`, async () => resolve(await read()));
      });
    });
    expect(seen).toBeUndefined();
  });

  it('refreshInBackground runs again once a refresh that failed has settled', async () => {
    const run = vi.fn(async () => { throw new Error('GitHub said no'); });
    runInScopedDb(requestTx, () => refreshInBackground('test:retry', run));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    runInScopedDb(requestTx, () => refreshInBackground('test:retry', run));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });

  it('refreshInBackground runs one refresh per key at a time', async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => { release = r; }));
    refreshInBackground('test:once', run);
    refreshInBackground('test:once', run);
    expect(run).toHaveBeenCalledTimes(1);
    release();
  });

  it('refreshWebhookIndex checks access on the pool when a request starts it', async () => {
    const scopes: Array<Database | undefined> = [];
    vi.mocked(githubService.canAccessRepository).mockImplementation(async () => {
      scopes.push(getScopedDb());
      return true;
    });

    await runInScopedDb(requestTx, () => refreshWebhookIndex());

    expect(scopes).toEqual([undefined]);
  });
});
