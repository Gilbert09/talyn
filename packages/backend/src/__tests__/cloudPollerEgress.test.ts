import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { TERMINAL_TASK_STATUSES } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { tasks as tasksTable, workspaces as workspacesTable } from '../db/schema.js';
import type { Database } from '../db/client.js';

/**
 * The cloud-task poller never selects the `transcript` jsonb (a multi-MB blob).
 * It used to compute the transcript's EMPTINESS server-side; it now reads a
 * marker off `metadata` instead, because emptiness turned out to answer a
 * different question (see transcriptStore.ts § TRANSCRIPT_FINAL_KEY). These
 * tests pin the marker's SQL to the JS check it has to agree with, using real
 * Postgres semantics via pglite.
 */

let db: Database;
let cleanup: () => Promise<void>;

/** The exact marker expression used in cloudProviders/poller.ts. */
const transcriptFinalExpr = sql<boolean>`COALESCE(${tasksTable.metadata} @> '{"transcriptFinal":true}'::jsonb, false)`;

async function seedTask(id: string, metadata: unknown): Promise<void> {
  await db.insert(tasksTable).values({
    id,
    workspaceId: 'ws1',
    type: 'code_writing',
    status: 'in_progress',
    priority: 'medium',
    title: 't',
    description: 'd',
    metadata: metadata as object | null,
  });
}

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  await seedUser(db, { id: 'owner1' });
  await db.insert(workspacesTable).values({ id: 'ws1', ownerId: 'owner1', name: 'ws', settings: {} });
});

afterEach(async () => {
  await cleanup();
});

describe('transcriptFinal marker SQL', () => {
  it.each([
    ['absent metadata', null, false],
    ['empty metadata', {}, false],
    ['marker true', { transcriptFinal: true }, true],
    ['marker false', { transcriptFinal: false }, false],
    ['marker alongside other keys', { posthogRunId: 'r1', transcriptFinal: true }, true],
    // Containment is typed: the string "true" is not the boolean, and reading
    // it as one would strand the task it belongs to.
    ['marker as a string', { transcriptFinal: 'true' }, false],
  ])('%s → final=%s, matching the JS check', async (label, metadata, expected) => {
    const id = `task-${label.replace(/\s+/g, '-')}`;
    await seedTask(id, metadata);

    const [row] = await db
      .select({ id: tasksTable.id, transcriptFinal: transcriptFinalExpr })
      .from(tasksTable)
      .where(eq(tasksTable.id, id));

    // The poller reads the same fact off the already-loaded `metadata` in JS;
    // the two must not be able to disagree.
    const js = (metadata as Record<string, unknown> | null)?.transcriptFinal === true;

    expect(row.transcriptFinal).toBe(expected);
    expect(row.transcriptFinal).toBe(js);
  });

  it('a NULL metadata column is false, not null — the poller branches on it', async () => {
    await seedTask('null-meta', null);
    const [row] = await db
      .select({ transcriptFinal: transcriptFinalExpr })
      .from(tasksTable)
      .where(eq(tasksTable.id, 'null-meta'));
    expect(row.transcriptFinal).toBe(false);
  });
});

/**
 * The cloud poller also loads revival candidates: `completed` tasks a provider
 * optimistically finalised (`metadata.reviveEligible`) within the revive window.
 * Pins the exact WHERE clause from cloudProviders/poller.ts against real
 * Postgres semantics — in particular that the jsonb-containment flag and the
 * completedAt window both gate the completed rows without pulling in others.
 */
describe('cloud poller task selection (in-flight + revival candidates)', () => {
  const REVIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

  async function seedRow(
    id: string,
    status: string,
    opts: {
      completedAt?: Date | null;
      updatedAt?: Date;
      reviveEligible?: boolean;
      transcriptFinal?: boolean;
    } = {},
  ): Promise<void> {
    await db.insert(tasksTable).values({
      id,
      workspaceId: 'ws1',
      type: 'code_writing',
      status,
      priority: 'medium',
      title: 't',
      description: 'd',
      completedAt: opts.completedAt ?? null,
      ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
      metadata: {
        ...(opts.reviveEligible ? { reviveEligible: true } : {}),
        ...(opts.transcriptFinal ? { transcriptFinal: true } : {}),
      },
    });
  }

  it('selects in-flight tasks and revivable completed tasks in-window, nothing else', async () => {
    const now = Date.now();
    const inWindow = new Date(now - 60 * 60 * 1000); // 1h ago
    const stale = new Date(now - (REVIVE_WINDOW_MS + 60 * 60 * 1000)); // >24h ago

    await seedRow('inflight', 'in_progress');
    await seedRow('revivable', 'completed', { completedAt: inWindow, reviveEligible: true });
    await seedRow('done-no-flag', 'completed', { completedAt: inWindow, reviveEligible: false });
    await seedRow('revivable-stale', 'completed', { completedAt: stale, reviveEligible: true });
    await seedRow('failed-flag', 'failed', { completedAt: inWindow, reviveEligible: true });

    const reviveCutoff = new Date(now - REVIVE_WINDOW_MS);
    const rows = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(
        or(
          eq(tasksTable.status, 'in_progress'),
          and(
            eq(tasksTable.status, 'completed'),
            gte(tasksTable.completedAt, reviveCutoff),
            sql`${tasksTable.metadata} @> '{"reviveEligible":true}'::jsonb`,
          ),
        ),
      );

    expect(rows.map((r) => r.id).sort()).toEqual(['inflight', 'revivable']);
  });

  /**
   * The transcript-backfill window (services/cloudProviders/poller.ts).
   *
   * A provider's "terminal but the stored transcript is not the record → pull
   * the durable log" branch used to get one attempt, on the tick that saw the
   * run finish — which is the moment the provider's log is least likely to have
   * been flushed yet. Miss it and the task was never selected again. This clause
   * re-selects recently-finished tasks that have not yet stored the record.
   */
  it('re-selects every recently-finished status that has not stored the record', async () => {
    const BACKFILL_WINDOW_MS = 30 * 60 * 1000;
    const now = Date.now();
    const justNow = new Date(now - 60 * 1000); // 1m ago — inside the window
    const oldish = new Date(now - 2 * 60 * 60 * 1000); // 2h ago — outside it

    // Every terminal status, not just `completed`. A FAILED run is the one whose
    // log somebody actually needs, and `completedAt` is null on it — which is
    // why the window is measured from `updatedAt`.
    await seedRow('done-recent', 'completed', { completedAt: justNow, updatedAt: justNow });
    await seedRow('failed-recent', 'failed', { updatedAt: justNow });
    await seedRow('needshuman-recent', 'needs_human', { updatedAt: justNow });
    await seedRow('cancelled-recent', 'cancelled', { updatedAt: justNow });

    // Still running: covered by the in_progress clause, not this one.
    await seedRow('running', 'in_progress', { updatedAt: justNow });
    await seedRow('done-old', 'completed', { completedAt: oldish, updatedAt: oldish });
    await seedRow('done-final', 'completed', {
      completedAt: justNow,
      updatedAt: justNow,
      transcriptFinal: true,
    });

    // The case the marker exists for: a live stream torn down mid-run left a
    // fragment behind, so the transcript is NOT empty — and it is still not the
    // run's log. The old `jsonb_array_length(transcript) = 0` clause excluded
    // this row permanently; it has to be selected.
    await seedRow('partial-recent', 'completed', { completedAt: justNow, updatedAt: justNow });
    await db
      .update(tasksTable)
      .set({ transcript: [{ seq: 0, type: 'assistant' }] })
      .where(eq(tasksTable.id, 'partial-recent'));

    const backfillCutoff = new Date(now - BACKFILL_WINDOW_MS);
    const rows = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(
        and(
          inArray(tasksTable.status, [...TERMINAL_TASK_STATUSES]),
          gte(tasksTable.updatedAt, backfillCutoff),
          sql`NOT COALESCE(${tasksTable.metadata} @> '{"transcriptFinal":true}'::jsonb, false)`,
        ),
      );

    // `done-final` is excluded because it already has what we'd be fetching —
    // that is what stops this clause re-polling every finished task forever.
    // `done-old` is excluded by the window; opening it is its recovery path.
    expect(rows.map((r) => r.id).sort()).toEqual([
      'cancelled-recent',
      'done-recent',
      'failed-recent',
      'needshuman-recent',
      'partial-recent',
    ]);
  });
});
