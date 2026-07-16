// Store-layer tests for merge queue v2: CAS transition semantics, membership
// helpers, the engine flag, position math, and the 0031 backfill mapping
// (re-run against seeded legacy blobs — the migration is idempotent by
// construction, so executing its INSERT again pins the exact shipped SQL).

import fs from 'fs';
import path from 'path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  mergeQueueEntries,
  mergeQueueEvents,
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  settings as settingsTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import {
  casTransition,
  closeActiveEntry,
  computeEntryPositions,
  ensureActiveEntry,
  getActiveEntryForPr,
  getMergeQueueEngine,
  loadActiveGroup,
} from '../../services/mergeQueue/store.js';

const MIGRATION_0031 = path.resolve(
  __dirname,
  '../../db/migrations/0031_merge_queue_entries.sql'
);

describe('mergeQueue store', () => {
  let db: Database;
  let pglite: Awaited<ReturnType<typeof createTestDb>>['pglite'];
  let cleanup: () => Promise<void>;
  let prSeq = 0;

  async function insertPr(opts: {
    queued?: boolean;
    state?: string;
    mergeQueueState?: Record<string, unknown> | null;
    lastSummary?: Record<string, unknown>;
  } = {}): Promise<string> {
    const id = `pr-${++prSeq}`;
    await db.insert(pullRequestsTable).values({
      id,
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      taskId: null,
      owner: 'a',
      repo: 'b',
      number: prSeq,
      state: opts.state ?? 'open',
      mergeQueued: opts.queued ?? false,
      mergeQueuedAt: opts.queued ? new Date() : null,
      mergeMethod: 'squash',
      mergeQueueState: opts.mergeQueueState ?? null,
      lastPolledAt: new Date(),
      lastSummary: opts.lastSummary ?? { baseBranch: 'main', headSha: 'sha1' },
    });
    return id;
  }

  function enqueueInput(prId: string) {
    return {
      pullRequestId: prId,
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      baseBranch: 'main',
      mergeMethod: 'squash' as const,
      headSha: 'sha1',
      trigger: 'user:enqueue',
    };
  }

  beforeEach(async () => {
    ({ db, pglite, cleanup } = await createTestDb());
    prSeq = 0;
    await seedUser(db);
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'ws1',
      settings: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'b',
      url: 'https://github.com/a/b',
      defaultBranch: 'main',
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  describe('engine flag', () => {
    it('defaults to v1 (seeded by the migration)', async () => {
      expect(await getMergeQueueEngine(db)).toBe('v1');
    });

    it('reads v2 after the flip', async () => {
      await db
        .update(settingsTable)
        .set({ value: 'v2' })
        .where(eq(settingsTable.key, 'merge_queue_engine'));
      expect(await getMergeQueueEngine(db)).toBe('v2');
    });
  });

  describe('membership', () => {
    it('creates a fresh entry with an enqueued audit event', async () => {
      const prId = await insertPr();
      const entryId = await ensureActiveEntry(enqueueInput(prId), db);
      const entry = await getActiveEntryForPr(prId, db);
      expect(entry?.id).toBe(entryId);
      expect(entry?.status).toBe('queued');
      expect(entry?.headSha).toBe('sha1');
      const events = await db
        .select()
        .from(mergeQueueEvents)
        .where(eq(mergeQueueEvents.entryId, entryId));
      expect(events).toHaveLength(1);
      expect(events[0]!.code).toBe('enqueued');
      expect(events[0]!.trigger).toBe('user:enqueue');
    });

    it('re-arms an existing active entry instead of duplicating (budgets reset, place kept)', async () => {
      const prId = await insertPr();
      const entryId = await ensureActiveEntry(enqueueInput(prId), db);
      await db
        .update(mergeQueueEntries)
        .set({
          status: 'blocked',
          blockedCode: 'attempts_exhausted',
          blockedReason: 'x',
          fixAttempts: 3,
          version: 5,
        })
        .where(eq(mergeQueueEntries.id, entryId));

      const again = await ensureActiveEntry(enqueueInput(prId), db);
      expect(again).toBe(entryId);
      const entry = await getActiveEntryForPr(prId, db);
      expect(entry?.status).toBe('queued');
      expect(entry?.blockedCode).toBeNull();
      expect(entry?.fixAttempts).toBe(0);
      expect(entry?.version).toBe(6); // CAS-visible bump
    });

    it('closes the active entry and is idempotent', async () => {
      const prId = await insertPr();
      await ensureActiveEntry(enqueueInput(prId), db);
      const closed = await closeActiveEntry(
        prId,
        'removed',
        { trigger: 'user:dequeue', message: 'gone' },
        db
      );
      expect(closed).not.toBeNull();
      expect(await getActiveEntryForPr(prId, db)).toBeNull();
      // second close is a no-op
      expect(
        await closeActiveEntry(prId, 'removed', { trigger: 'user:dequeue', message: 'gone' }, db)
      ).toBeNull();
    });

    it('a re-queue after close mints a FRESH entry (terminal row retained as history)', async () => {
      const prId = await insertPr();
      const first = await ensureActiveEntry(enqueueInput(prId), db);
      await closeActiveEntry(prId, 'removed', { trigger: 'user:dequeue', message: 'gone' }, db);
      const second = await ensureActiveEntry(enqueueInput(prId), db);
      expect(second).not.toBe(first);
      const all = await db
        .select({ id: mergeQueueEntries.id })
        .from(mergeQueueEntries)
        .where(eq(mergeQueueEntries.pullRequestId, prId));
      expect(all).toHaveLength(2);
    });
  });

  describe('casTransition', () => {
    it('applies the patch, bumps version, and appends the event atomically', async () => {
      const prId = await insertPr();
      const entryId = await ensureActiveEntry(enqueueInput(prId), db);
      const before = (await getActiveEntryForPr(prId, db))!;

      const ok = await casTransition(
        entryId,
        before.version,
        { status: 'fixing', fixTaskId: null, fixTaskAccounted: false },
        {
          trigger: 'webhook:pull_request',
          fromStatus: 'queued',
          toStatus: 'fixing',
          code: 'fix_run_fired',
          message: 'Fix run dispatched.',
        },
        db
      );
      expect(ok).toBe(true);
      const after = (await getActiveEntryForPr(prId, db))!;
      expect(after.status).toBe('fixing');
      expect(after.version).toBe(before.version + 1);
      const events = await db
        .select()
        .from(mergeQueueEvents)
        .where(eq(mergeQueueEvents.entryId, entryId));
      expect(events.map((e) => e.code)).toContain('fix_run_fired');
    });

    it('a stale version loses: no write, no event', async () => {
      const prId = await insertPr();
      const entryId = await ensureActiveEntry(enqueueInput(prId), db);
      const before = (await getActiveEntryForPr(prId, db))!;

      const ok = await casTransition(
        entryId,
        before.version + 41, // stale/wrong
        { status: 'merging' },
        {
          trigger: 'reconcile',
          fromStatus: 'queued',
          toStatus: 'merging',
          code: 'x',
          message: 'x',
        },
        db
      );
      expect(ok).toBe(false);
      const after = (await getActiveEntryForPr(prId, db))!;
      expect(after.status).toBe('queued');
      expect(after.version).toBe(before.version);
      const events = await db
        .select()
        .from(mergeQueueEvents)
        .where(eq(mergeQueueEvents.entryId, entryId));
      expect(events.map((e) => e.code)).not.toContain('x');
    });
  });

  describe('groups and positions', () => {
    it('loads a group FIFO and numbers positions per (repo, base) group', async () => {
      const a = await insertPr();
      const b = await insertPr();
      const c = await insertPr();
      await ensureActiveEntry(enqueueInput(a), db);
      await ensureActiveEntry(enqueueInput(b), db);
      await ensureActiveEntry({ ...enqueueInput(c), baseBranch: 'develop' }, db);

      const group = await loadActiveGroup('repo1', 'main', db);
      expect(group.map((e) => e.pullRequestId)).toEqual([a, b]);

      const positions = computeEntryPositions([
        ...group,
        ...(await loadActiveGroup('repo1', 'develop', db)),
      ]);
      expect([...positions.values()]).toEqual([1, 2, 1]);
    });
  });

  describe('0031 backfill (re-run against seeded legacy blobs)', () => {
    async function runBackfill(): Promise<void> {
      const sqlText = fs.readFileSync(MIGRATION_0031, 'utf-8');
      const backfill = sqlText
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .find((s) => s.includes('INSERT INTO "merge_queue_entries"'));
      expect(backfill).toBeTruthy();
      await pglite.exec(backfill!);
    }

    it('maps every legacy status × mergeForbidden variant', async () => {
      const waiting = await insertPr({
        queued: true,
        mergeQueueState: { status: 'waiting', attempts: 1, accounted: true },
      });
      const fixing = await insertPr({
        queued: true,
        mergeQueueState: { status: 'fixing', attempts: 2, accounted: false },
      });
      const merging = await insertPr({
        queued: true,
        mergeQueueState: { status: 'merging', attempts: 0, accounted: true },
      });
      const blockedPlain = await insertPr({
        queued: true,
        mergeQueueState: { status: 'blocked', attempts: 3, blockReason: 'merge conflicts' },
      });
      const blockedHard = await insertPr({
        queued: true,
        mergeQueueState: { status: 'blocked', mergeForbidden: 'hard', blockReason: 'refused' },
      });
      const blockedChecks = await insertPr({
        queued: true,
        mergeQueueState: {
          status: 'blocked',
          mergeForbidden: 'failing-checks',
          rerunAttempts: 3,
          blockReason: 'checks',
        },
      });
      const blockedUnsigned = await insertPr({
        queued: true,
        mergeQueueState: { status: 'blocked', mergeForbidden: 'unsigned-commits', resignAttempts: 3 },
      });
      const blockedDraft = await insertPr({
        queued: true,
        mergeQueueState: {
          status: 'blocked',
          blockReason: 'This PR is a draft — mark it ready for review and the merge queue will merge it automatically.',
        },
      });
      // Not eligible: unqueued, and queued-but-closed.
      await insertPr({ queued: false });
      await insertPr({ queued: true, state: 'merged' });

      await runBackfill();

      const byPr = new Map(
        (await db.select().from(mergeQueueEntries)).map((e) => [e.pullRequestId, e])
      );
      expect(byPr.size).toBe(8);
      expect(byPr.get(waiting)).toMatchObject({ status: 'queued', fixAttempts: 1, headSha: 'sha1', baseBranch: 'main' });
      expect(byPr.get(fixing)).toMatchObject({ status: 'fixing', fixAttempts: 2, fixTaskAccounted: false });
      expect(byPr.get(merging)).toMatchObject({ status: 'merging' });
      expect(byPr.get(blockedPlain)).toMatchObject({
        status: 'blocked',
        blockedCode: 'attempts_exhausted',
        blockedReason: 'merge conflicts',
        fixAttempts: 3,
      });
      expect(byPr.get(blockedHard)).toMatchObject({ status: 'blocked_manual', blockedCode: 'app_refused_hard' });
      expect(byPr.get(blockedChecks)).toMatchObject({
        status: 'blocked',
        blockedCode: 'app_refused_checks',
        rerunAttempts: 3,
      });
      expect(byPr.get(blockedUnsigned)).toMatchObject({
        status: 'blocked',
        blockedCode: 'unsigned_commits',
        resignAttempts: 3,
      });
      expect(byPr.get(blockedDraft)).toMatchObject({ status: 'blocked', blockedCode: 'draft' });
    });

    it('is idempotent — a re-run adds nothing on top of existing active entries', async () => {
      const prId = await insertPr({
        queued: true,
        mergeQueueState: { status: 'waiting', attempts: 0, accounted: true },
      });
      await runBackfill();
      await runBackfill();
      const rows = await db
        .select({ id: mergeQueueEntries.id })
        .from(mergeQueueEntries)
        .where(eq(mergeQueueEntries.pullRequestId, prId));
      expect(rows).toHaveLength(1);
    });
  });
});
