import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
  tasks as tasksTable,
} from '../db/schema.js';

/**
 * Migration 0056 — unlink the pull requests a cloud run never opened.
 *
 * The migration has already run by the time `createTestDb` returns, against
 * empty tables. Seeding the damage and re-running it is the only way to
 * exercise it, and it is legitimate: the statement is a single idempotent
 * UPDATE whose second pass finds nothing left to do.
 */
const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '../db/migrations/0056_unlink_scraped_pull_requests.sql'),
  'utf8'
);

const TASK_AT = new Date('2026-09-14T15:27:00.000Z');
/** The real case: opened the day before the task, by the user, already merged. */
const OLD_PR_AT = '2026-09-13T17:02:33.000Z';
const NEW_PR_AT = '2026-09-14T15:41:00.000Z';

describe('migration 0056 — unlink scraped pull requests', () => {
  let db: Database;
  let pglite: PGlite;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    pglite = testDb.pglite;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db
      .insert(workspacesTable)
      .values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'PostHog/posthog',
      url: 'https://github.com/PostHog/posthog',
      defaultBranch: 'master',
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  // The two tables point at each other, so the back-pointer is a third step:
  // `pull_requests.task_id` and `tasks.pull_request_id` are both real FKs.
  const seedPr = async (id: string, number: number, createdAt: string | null) =>
    db.insert(pullRequestsTable).values({
      id,
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'PostHog',
      repo: 'posthog',
      number,
      state: 'open',
      lastPolledAt: new Date(),
      lastSummary: createdAt === null ? {} : { createdAt, title: 'x' },
    });

  const linkBack = async (prId: string, taskId: string) =>
    db.update(pullRequestsTable).set({ taskId }).where(eq(pullRequestsTable.id, prId));

  const seedTask = async (
    id: string,
    type: string,
    prId: string | null,
    metadata: Record<string, unknown> = {}
  ) =>
    db.insert(tasksTable).values({
      id,
      workspaceId: 'ws1',
      type,
      status: 'completed',
      title: 't',
      description: '',
      priority: 'medium',
      repositoryId: 'repo1',
      pullRequestId: prId,
      metadata,
      createdAt: TASK_AT,
      updatedAt: TASK_AT,
    });

  const run = () => pglite.exec(MIGRATION);
  const taskRow = async (id: string) =>
    (
      await db
        .select({ prId: tasksTable.pullRequestId, metadata: tasksTable.metadata })
        .from(tasksTable)
        .where(eq(tasksTable.id, id))
    )[0];
  const prTaskId = async (id: string) =>
    (
      await db
        .select({ taskId: pullRequestsTable.taskId })
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, id))
    )[0].taskId;

  it('unlinks a code_writing task from a PR that predates it, both ways', async () => {
    await seedPr('pr-old', 99835, OLD_PR_AT);
    await seedTask('task-loop', 'code_writing', 'pr-old', {
      posthogTaskId: 'ph-1',
      posthogPrUrl: 'https://github.com/PostHog/posthog/pull/99835',
      pullRequest: { id: 'pr-old', number: 99835 },
    });
    await linkBack('pr-old', 'task-loop');

    await run();

    const task = await taskRow('task-loop');
    expect(task.prId).toBeNull();
    // Both copies of the claim go, or the task detail still renders the link.
    expect(task.metadata).toEqual({ posthogTaskId: 'ph-1' });
    expect(await prTaskId('pr-old')).toBeNull();
  });

  it('keeps a PR the task actually opened', async () => {
    await seedPr('pr-new', 100303, NEW_PR_AT);
    await seedTask('task-real', 'code_writing', 'pr-new', {
      pullRequest: { id: 'pr-new', number: 100303 },
    });
    await linkBack('pr-new', 'task-real');

    await run();

    expect((await taskRow('task-real')).prId).toBe('pr-new');
    expect(await prTaskId('pr-new')).toBe('task-real');
  });

  it('never touches a pr_response task, whose PR predates it by definition', async () => {
    // The merge-queue executor and the auto-keep watcher both create these
    // WITH the PR. Unlinking one would break the thing it was made to fix.
    await seedPr('pr-mq', 500, OLD_PR_AT);
    await seedTask('task-mq', 'pr_response', 'pr-mq');
    await linkBack('pr-mq', 'task-mq');

    await run();

    expect((await taskRow('task-mq')).prId).toBe('pr-mq');
    expect(await prTaskId('pr-mq')).toBe('task-mq');
  });

  it('leaves a row alone when GitHub never told us when the PR was opened', async () => {
    // A placeholder the poller itself inserted has no real `createdAt`. With
    // nothing to compare, the link stands — this errs toward keeping a link,
    // never toward inventing one.
    for (const [id, summary] of [
      ['pr-empty', null],
      ['pr-junk', 'last tuesday'],
    ] as const) {
      await seedPr(id, id === 'pr-empty' ? 1 : 2, summary);
      await seedTask(`task-${id}`, 'code_writing', id);
    }

    await run();

    expect((await taskRow('task-pr-empty')).prId).toBe('pr-empty');
    expect((await taskRow('task-pr-junk')).prId).toBe('pr-junk');
  });

  it('leaves a back-pointer that a different task has since claimed', async () => {
    await seedPr('pr-old', 99835, OLD_PR_AT);
    await seedTask('task-loop', 'code_writing', 'pr-old');
    await seedTask('task-other', 'pr_response', null);
    await linkBack('pr-old', 'task-other');

    await run();

    expect((await taskRow('task-loop')).prId).toBeNull();
    expect(await prTaskId('pr-old')).toBe('task-other');
  });

  it('is idempotent', async () => {
    await seedPr('pr-old', 99835, OLD_PR_AT);
    await seedTask('task-loop', 'code_writing', 'pr-old', { posthogPrUrl: 'x' });
    await linkBack('pr-old', 'task-loop');

    await run();
    await run();

    expect((await taskRow('task-loop')).prId).toBeNull();
  });
});
