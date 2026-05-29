import { eq } from 'drizzle-orm';
import type { TaskResult, TaskStatus } from '@fastowl/shared';
import { getDbClient } from '../../db/client.js';
import {
  tasks as tasksTable,
  repositories as repositoriesTable,
} from '../../db/schema.js';
import { patchTaskMetadata } from '../taskMetadataMutex.js';
import { emitTaskStatus, emitTaskUpdate } from '../websocket.js';
import { linkTaskToPullRequest } from '../prCache.js';
import { getPostHogCodeClient } from './credentials.js';
import type { PostHogRun, PostHogRunStatus } from './client.js';

const POLL_INTERVAL_MS = 10_000;
const TERMINAL: ReadonlySet<PostHogRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/**
 * Reconciles FastOwl tasks that were delegated to PostHog Code. PostHog
 * owns the agent loop on its own sandbox; we poll each in-flight run and
 * drive the local task to `awaiting_review` (PR opened) or `failed`.
 *
 * Cloud tasks have no FastOwl agent — they're identified purely by a
 * `posthogRunId` on `task.metadata`. recoverStuckTasks() in taskQueue is
 * taught to leave them alone.
 */
class PostHogCodePoller {
  private interval: NodeJS.Timeout | null = null;
  private ticking = false;

  init(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  shutdown(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const db = getDbClient();
      const rows = await db
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.status, 'in_progress'));

      for (const row of rows) {
        const meta = (row.metadata as Record<string, unknown> | null) ?? {};
        const posthogTaskId = meta.posthogTaskId as string | undefined;
        const posthogRunId = meta.posthogRunId as string | undefined;
        if (!posthogTaskId || !posthogRunId) continue;

        try {
          await this.reconcile({
            id: row.id,
            workspaceId: row.workspaceId,
            title: row.title,
            repositoryId: row.repositoryId,
            posthogTaskId,
            lastStatus: meta.posthogStatus as string | undefined,
          });
        } catch (err) {
          // Transient API hiccups are fine — we retry next tick. Don't
          // fail the task on a single failed poll.
          console.warn(
            `[posthogCode] poll failed for task ${row.id.slice(0, 8)}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('DATABASE_URL is not set')) return;
      console.error('[posthogCode] poller tick error:', err);
    } finally {
      this.ticking = false;
    }
  }

  private async reconcile(task: {
    id: string;
    workspaceId: string;
    title: string;
    repositoryId: string | null;
    posthogTaskId: string;
    lastStatus?: string;
  }): Promise<void> {
    const client = await getPostHogCodeClient(task.workspaceId);
    if (!client) return; // credentials removed mid-run; leave as-is.

    const remote = await client.getTask(task.posthogTaskId);
    const run = remote.latest_run ?? null;
    const status = run?.status;
    if (!status) return;

    const prUrl = findPullRequestUrl(remote, run);

    // Keep metadata fresh (status + PR url + log url) even while running.
    await patchTaskMetadata(task.id, (existing) => ({
      ...existing,
      posthogStatus: status,
      posthogLogUrl: run?.log_url ?? existing.posthogLogUrl,
      posthogPrUrl: prUrl ?? existing.posthogPrUrl,
    }));
    emitTaskUpdate(task.workspaceId, task.id, {
      metadata: { posthogStatus: status, posthogPrUrl: prUrl ?? undefined },
    });

    if (!TERMINAL.has(status)) return;

    if (status === 'completed') {
      if (prUrl && task.repositoryId) {
        await this.linkPr(task, run, prUrl);
      }
      const nextStatus: TaskStatus = prUrl ? 'awaiting_review' : 'completed';
      const result: TaskResult = {
        success: true,
        summary: prUrl ? `PostHog Code opened ${prUrl}` : 'PostHog Code run completed',
        output: stringifyOutput(run?.output),
      };
      await this.finalize(task, nextStatus, result);
    } else {
      // failed | cancelled
      const result: TaskResult = {
        success: false,
        error:
          (run?.error_message ?? undefined) ||
          `PostHog Code run ${status}`,
      };
      await this.finalize(task, 'failed', result);
    }
  }

  private async linkPr(
    task: { id: string; workspaceId: string; repositoryId: string | null },
    run: PostHogRun | null,
    prUrl: string,
  ): Promise<void> {
    const parsed = parsePrUrl(prUrl);
    if (!parsed || !task.repositoryId) return;
    const db = getDbClient();
    const repoRows = await db
      .select({ defaultBranch: repositoriesTable.defaultBranch })
      .from(repositoriesTable)
      .where(eq(repositoriesTable.id, task.repositoryId))
      .limit(1);
    const baseBranch = repoRows[0]?.defaultBranch || 'main';

    try {
      const rowId = await linkTaskToPullRequest({
        workspaceId: task.workspaceId,
        repositoryId: task.repositoryId,
        taskId: task.id,
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        url: prUrl,
        title: '',
        author: '',
        headBranch: run?.branch ?? '',
        baseBranch,
        headSha: '',
      });
      await patchTaskMetadata(task.id, (existing) => ({
        ...existing,
        pullRequest: {
          id: rowId,
          number: parsed.number,
          url: prUrl,
          createdAt: new Date().toISOString(),
        },
      }));
    } catch (err) {
      console.warn(
        `[posthogCode] failed to link PR for task ${task.id.slice(0, 8)}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async finalize(
    task: { id: string; workspaceId: string },
    status: TaskStatus,
    result: TaskResult,
  ): Promise<void> {
    const now = new Date();
    await getDbClient()
      .update(tasksTable)
      .set({
        status,
        result,
        completedAt: status === 'completed' ? now : null,
        updatedAt: now,
      })
      .where(eq(tasksTable.id, task.id));
    emitTaskStatus(task.workspaceId, task.id, status, result);
  }
}

/** Scan the remote task + run for the first GitHub PR URL. */
function findPullRequestUrl(remote: unknown, run: PostHogRun | null): string | null {
  const fromRun = scanForPrUrl(run);
  if (fromRun) return fromRun;
  return scanForPrUrl(remote);
}

const PR_URL_RE = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

function scanForPrUrl(value: unknown): string | null {
  if (value == null) return null;
  const haystack = typeof value === 'string' ? value : JSON.stringify(value);
  const match = haystack.match(PR_URL_RE);
  return match ? match[0] : null;
}

function parsePrUrl(
  url: string,
): { owner: string; repo: string; number: number } | null {
  const match = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

function stringifyOutput(output: unknown): string | undefined {
  if (output == null) return undefined;
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return undefined;
  }
}

export const postHogCodePoller = new PostHogCodePoller();
