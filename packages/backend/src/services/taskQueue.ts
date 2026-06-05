import { EventEmitter } from 'events';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type {
  Environment,
  EnvironmentConfig,
  Task,
  TaskPriority,
} from '@fastowl/shared';
import { getCloudProvider } from './cloudProviders/registry.js';
import { rowToTask, taskColumnsNoTranscript } from './taskSerialize.js';
import { patchTaskMetadata } from './taskMetadataMutex.js';
import { emitTaskStatus } from './websocket.js';
import { getDbClient, type Database } from '../db/client.js';
import {
  tasks as tasksTable,
  environments as environmentsTable,
} from '../db/schema.js';

// Priority weights; referenced by the SQL CASE expressions below.
const PRIORITY_WEIGHTS: Record<TaskPriority, number> = {
  urgent: 1000,
  high: 100,
  medium: 10,
  low: 1,
};
// Silence unused warning: kept as canonical source of the priority order.
void PRIORITY_WEIGHTS;

/**
 * Cloud-only task scheduler. Every task is delegated to a cloud provider
 * (PostHog Code today). The queue's whole job is: pick up pending/queued
 * tasks, resolve the provider from the task's assigned cloud-marker env,
 * and call `provider.dispatch`. The provider flips the task to
 * `in_progress` and the cloud poller (cloudProviders/poller.ts) drives it
 * to a terminal state. There is no local agent loop, no working tree, and
 * no concurrency slots — the vendor hosts all of that.
 */
class TaskQueueService extends EventEmitter {
  private processingInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private shuttingDown = false;

  private get db(): Database {
    return getDbClient();
  }

  /** Run a processQueue without logging the "DB client reset" noise
   *  that floats in from afterEach in tests. Anything else still logs. */
  private runProcessQueue(): void {
    if (this.shuttingDown) return;
    this.processQueue().catch((err) => {
      if (this.shuttingDown) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('DATABASE_URL is not set')) return;
      console.error('[TaskQueue] processQueue error:', err);
    });
  }

  async init(): Promise<void> {
    this.processingInterval = setInterval(() => {
      this.runProcessQueue();
    }, 5000);
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
  }

  /** Tests re-use the singleton across describes — let them un-shutdown. */
  resetForTests(): void {
    this.shuttingDown = false;
  }

  async queueTask(taskId: string): Promise<void> {
    await this.db
      .update(tasksTable)
      .set({ status: 'queued', updatedAt: new Date() })
      .where(eq(tasksTable.id, taskId));

    const task = await this.getTask(taskId);
    if (task) emitTaskStatus(task.workspaceId, taskId, 'queued');

    this.runProcessQueue();
  }

  async cancelTask(taskId: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(tasksTable)
      .set({ status: 'cancelled', updatedAt: now, completedAt: now })
      .where(eq(tasksTable.id, taskId));

    const task = await this.getTask(taskId);
    if (task) emitTaskStatus(task.workspaceId, taskId, 'cancelled');
  }

  /**
   * Queued tasks ordered by priority weight then by creation time.
   */
  async getQueuedTasks(workspaceId?: string): Promise<Task[]> {
    const priorityCase = sql<number>`CASE ${tasksTable.priority}
      WHEN 'urgent' THEN 1
      WHEN 'high' THEN 2
      WHEN 'medium' THEN 3
      ELSE 4
    END`;

    const whereClause = workspaceId
      ? and(
          inArray(tasksTable.status, ['pending', 'queued']),
          eq(tasksTable.workspaceId, workspaceId)
        )
      : inArray(tasksTable.status, ['pending', 'queued']);

    const rows = await this.db
      .select(taskColumnsNoTranscript)
      .from(tasksTable)
      .where(whereClause)
      .orderBy(priorityCase, tasksTable.createdAt);

    return rows.map((row) => rowToTask(row));
  }

  async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const queuedTasks = await this.getQueuedTasks();
      if (queuedTasks.length === 0) return;

      console.log(`[TaskQueue] Processing ${queuedTasks.length} queued task(s)`);

      for (const task of queuedTasks) {
        const env = await this.resolveCloudEnv(task);
        if (!env) {
          // No cloud-marker env assigned — nothing can run it. The
          // composer always assigns a provider, so this only happens
          // for malformed rows. Leave it queued (visible, not lost).
          console.warn(
            `[TaskQueue] task "${task.title}" has no cloud provider env; skipping`
          );
          continue;
        }

        const provider = getCloudProvider(env.type);
        if (!provider) {
          console.warn(
            `[TaskQueue] no provider registered for env type "${env.type}"; skipping "${task.title}"`
          );
          continue;
        }

        console.log(
          `[TaskQueue] Dispatching task "${task.title}" to ${provider.displayName}`
        );
        const result = await provider.dispatch(task, env);
        if (!result.ok) {
          console.error(
            `[TaskQueue] dispatch failed for "${task.title}": ${result.error}`
          );
          await patchTaskMetadata(task.id, (existing) => ({
            ...existing,
            lastScheduleError: {
              at: new Date().toISOString(),
              reason: result.error,
            },
          }));
          await this.db
            .update(tasksTable)
            .set({ status: 'queued', updatedAt: new Date() })
            .where(eq(tasksTable.id, task.id));
          emitTaskStatus(task.workspaceId, task.id, 'queued');
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /** Resolve the cloud-marker env a task is assigned to, or null. */
  private async resolveCloudEnv(task: Task): Promise<Environment | null> {
    if (!task.assignedEnvironmentId) return null;
    const rows = await this.db
      .select(CLOUD_ENV_COLUMNS)
      .from(environmentsTable)
      .where(eq(environmentsTable.id, task.assignedEnvironmentId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return rowToCloudEnv(row);
  }

  async getTask(taskId: string): Promise<Task | null> {
    const rows = await this.db
      .select(taskColumnsNoTranscript)
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);
    return rows[0] ? rowToTask(rows[0]) : null;
  }
}

/**
 * Legacy single-slot guard, retained so `routes/tasks.ts` keeps compiling
 * until it's pruned (Phase 3 of the cloud-only refactor). Cloud tasks have
 * no working tree, so this no longer gates dispatch — it just answers
 * "does another task already claim this (env, repo)?" for the old `/start`
 * endpoint.
 */
export async function findTaskHoldingEnvRepoSlot(
  db: Database,
  envId: string,
  repoId: string,
  excludeTaskId?: string
): Promise<{ id: string; title: string; status: string } | null> {
  const conditions = [
    eq(tasksTable.assignedEnvironmentId, envId),
    eq(tasksTable.repositoryId, repoId),
    inArray(tasksTable.status, ['in_progress', 'awaiting_review']),
  ];
  if (excludeTaskId) conditions.push(ne(tasksTable.id, excludeTaskId));

  const rows = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      status: tasksTable.status,
    })
    .from(tasksTable)
    .where(and(...conditions))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Columns `rowToCloudEnv` actually reads. Projected (rather than `.select()`)
 * so the marker's `config` jsonb is the only blob shipped — and so a future
 * column added to `environments` can't silently leak into this hot dispatch
 * read. The `Pick` type makes `tsc` fail if `rowToCloudEnv` ever reads more.
 */
const CLOUD_ENV_COLUMNS = {
  id: environmentsTable.id,
  name: environmentsTable.name,
  type: environmentsTable.type,
  status: environmentsTable.status,
  config: environmentsTable.config,
} as const;

type CloudEnvRow = Pick<
  typeof environmentsTable.$inferSelect,
  keyof typeof CLOUD_ENV_COLUMNS
>;

/** Build a minimal Environment from a marker row for provider dispatch. */
function rowToCloudEnv(row: CloudEnvRow): Environment {
  return {
    id: row.id,
    name: row.name,
    type: row.type as Environment['type'],
    status: row.status as Environment['status'],
    config: (row.config as EnvironmentConfig) ?? { type: row.type as never },
    renderer: 'structured',
  } as unknown as Environment;
}

export const taskQueueService = new TaskQueueService();
