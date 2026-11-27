import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initializeTestDb, seedUser } from './helpers/testDb.js';
import { resetDbClient, setDbClient, type Database } from '../db/client.js';
import * as schema from '../db/schema.js';
import { claimOrEnqueue, getWorkbench, markArchive } from '../services/workbenches/store.js';
import { bulkArchiveGuard } from '../services/workbenches/idleArchive.js';
import { claimScript, finishScript } from '../services/workbenches/scriptStore.js';

const url = process.env.TALYN_TEST_POSTGRES_URL;

// PGlite has one connection. This test needs concurrent PostgreSQL transactions.
describe.skipIf(!url)('bulk archive against concurrent PostgreSQL work claims', () => {
  const databaseName = `archive_test_${randomUUID().replaceAll('-', '')}`;
  let admin: postgres.Sql;
  let pool: postgres.Sql;
  let db: Database;

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(url!);
    databaseUrl.pathname = `/${databaseName}`;
    pool = postgres(databaseUrl.toString(), {
      max: 3,
      onnotice: () => {},
      connection: { application_name: databaseName, statement_timeout: 10_000 },
    });
    await initializeTestDb({ exec: async (query) => { await pool.unsafe(query); } });
    db = drizzle(pool, { schema, casing: 'snake_case' });
    setDbClient(db);
    await seedUser(db, { id: 'owner' });
    await db.insert(schema.workspaces).values({ id: 'ws', ownerId: 'owner', name: 'Workspace' });
  }, 30_000);

  afterAll(async () => {
    resetDbClient();
    if (pool) await pool.end({ timeout: 1 });
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('sees a committed turn claim after waiting for its share lock', async () => {
    const canStart = true;
    const id = `wb-${canStart}`;
    const chatId = `chat-${canStart}`;
    await db.insert(schema.workbenches).values({
      id, workspaceId: 'ws', repoFullName: 'acme/app', name: id, branch: id, baseBranch: 'main',
      runtime: 'sandbox', status: 'ready', agent: 'claude',
    });
    await db.insert(schema.workbenchChats).values({ id: chatId, workbenchId: id, workspaceId: 'ws', title: 'Chat', agent: 'claude' });

    let claimed!: () => void;
    const claimReady = new Promise<void>((resolve) => { claimed = resolve; });
    let release!: () => void;
    const mayCommit = new Promise<void>((resolve) => { release = resolve; });
    const turn = db.transaction(async (tx) => {
      setDbClient(tx as unknown as Database);
      try {
        const result = await claimOrEnqueue(chatId, { id: 'message', text: 'Continue', queuedAt: new Date().toISOString() }, canStart);
        expect(Boolean(result?.started)).toBe(canStart);
      } finally {
        setDbClient(db);
      }
      claimed();
      await mayCommit;
    });

    let archive: ReturnType<typeof markArchive> | undefined;
    try {
      await Promise.race([claimReady, turn]);
      archive = markArchive(id, false, undefined, undefined, bulkArchiveGuard());
      await vi.waitFor(async () => {
        const waiting = await admin`
          SELECT pid FROM pg_stat_activity
          WHERE application_name = ${databaseName} AND wait_event_type = 'Lock'
            AND cardinality(pg_blocking_pids(pid)) > 0
        `;
        expect(waiting).toHaveLength(1);
      }, { timeout: 5000, interval: 20 });
    } finally {
      release();
      await turn;
    }
    expect(await archive).toBeNull();
    expect(await getWorkbench(id)).toMatchObject({ archivedAt: null, archivePendingAt: null });
  });

  it.each(['script', 'archive'] as const)('serializes an existing script restart when %s claims first', async (first) => {
    const id = `script-${first}`;
    await db.insert(schema.workbenches).values({
      id, workspaceId: 'ws', repoFullName: 'acme/app', name: id, branch: id, baseBranch: 'main',
      runtime: 'sandbox', status: 'ready', agent: 'claude', sandboxId: `box-${first}`,
    });
    const row = (await getWorkbench(id))!;
    const previous = (await claimScript(row, 'run'))!;
    expect(await finishScript(previous, 0)).toBe(true);

    let claimed!: () => void;
    const claimReady = new Promise<void>((resolve) => { claimed = resolve; });
    let release!: () => void;
    const mayCommit = new Promise<void>((resolve) => { release = resolve; });
    const firstClaim = db.transaction(async (tx) => {
      setDbClient(tx as unknown as Database);
      try {
        const result = first === 'script'
          ? await claimScript(row, 'run')
          : await markArchive(id, false, undefined, undefined, bulkArchiveGuard());
        expect(result).not.toBeNull();
      } finally {
        setDbClient(db);
      }
      claimed();
      await mayCommit;
    });

    let secondClaim: Promise<unknown> | undefined;
    try {
      await Promise.race([claimReady, firstClaim]);
      secondClaim = first === 'script'
        ? markArchive(id, false, undefined, undefined, bulkArchiveGuard())
        : claimScript(row, 'run');
      await vi.waitFor(async () => {
        const waiting = await admin`
          SELECT pid FROM pg_stat_activity
          WHERE application_name = ${databaseName} AND wait_event_type = 'Lock'
            AND cardinality(pg_blocking_pids(pid)) > 0
        `;
        expect(waiting).toHaveLength(1);
      }, { timeout: 5000, interval: 20 });
    } finally {
      release();
      await firstClaim;
    }
    expect(await secondClaim).toBeNull();
    const current = (await getWorkbench(id))!;
    if (first === 'script') {
      expect(current).toMatchObject({ archivedAt: null, archivePendingAt: null });
    } else {
      expect(current.archivedAt).not.toBeNull();
      expect(await claimScript(current, 'archive', true)).not.toBeNull();
    }
  });
});
