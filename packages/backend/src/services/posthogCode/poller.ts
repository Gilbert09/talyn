import { eq } from 'drizzle-orm';
import type { TaskResult, TaskStatus } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import {
  tasks as tasksTable,
  repositories as repositoriesTable,
} from '../../db/schema.js';
import { captureWorkspaceEvent } from '../analytics.js';
import { patchTaskMetadata } from '../taskMetadataMutex.js';
import { emitTaskStatus, emitTaskUpdate } from '../websocket.js';
import { linkTaskToPullRequest } from '../prCache.js';
import { clearWatched } from '../cloudProviders/taskWatch.js';
import { getPostHogCodeClient } from './credentials.js';
import { postHogCodeStreamer } from './streamer.js';
import type { PostHogCodeClient, PostHogRun, PostHogRunStatus } from './client.js';
import type { AcpLogEntry } from './acpConverter.js';
import type { CloudTaskRow } from '../cloudProviders/types.js';

const TERMINAL: ReadonlySet<PostHogRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/**
 * A cloud run can finish its work yet sit in `in_progress` forever — the
 * PostHog API only flips to `completed` on certain finalisation paths, so a
 * background agent that reached end-of-turn just stays "running". We detect
 * that and auto-complete: the run's `updated_at` stops advancing once the
 * agent is idle (idle keepalive logs don't bump it), and we confirm the log
 * actually ended on a `turn_complete` so we never kill a long silent tool.
 */
const IDLE_FINALIZE_MS =
  Number(process.env.POSTHOG_CODE_IDLE_TIMEOUT_MS) || 10 * 60 * 1000;
/** Don't re-pull the log tail more often than this per task while stale. */
const IDLE_RECHECK_MS = 5 * 60 * 1000;
/** How far back from `updated_at` to read the log tail for confirmation. */
const IDLE_TAIL_WINDOW_MS = 5 * 60 * 1000;

/**
 * Reconciles FastOwl tasks that were delegated to PostHog Code. PostHog
 * owns the agent loop on its own sandbox; we poll each in-flight run and
 * drive the local task to `completed` or `failed`.
 *
 * Cloud tasks have no FastOwl agent — they're identified purely by a
 * `posthogRunId` on `task.metadata`. recoverStuckTasks() in taskQueue is
 * taught to leave them alone.
 */
class PostHogCodePoller {
  /** Per-task throttle for the idle-confirmation log fetch (taskId → ms). */
  private lastIdleCheck = new Map<string, number>();

  // NOTE: this poller no longer drives its own `setInterval` loop. The generic
  // cloud-task scheduler (`cloudProviders/poller.ts`) loads in-flight tasks and
  // calls `reconcileTask` via the provider wrapper. Keeping a second loop here
  // would re-introduce the `select()`-all transcript egress leak, so it's gone.

  /**
   * Reconcile one cloud task row — the entry point the generic cloud
   * poller (cloudProviders/poller.ts) calls via the provider wrapper.
   * Extracts the PostHog ids from metadata and delegates to the existing
   * per-task reconcile. No-op for a row that isn't a started PostHog run.
   */
  async reconcileTask(row: CloudTaskRow): Promise<void> {
    const posthogTaskId = row.metadata.posthogTaskId as string | undefined;
    const posthogRunId = row.metadata.posthogRunId as string | undefined;
    if (!posthogTaskId || !posthogRunId) return;
    await this.reconcile({
      id: row.id,
      workspaceId: row.workspaceId,
      title: row.title,
      repositoryId: row.repositoryId,
      posthogTaskId,
      lastStatus: row.metadata.posthogStatus as string | undefined,
      transcriptEmpty: row.transcriptEmpty,
      watched: row.watched,
    });
  }

  private async reconcile(task: {
    id: string;
    workspaceId: string;
    title: string;
    repositoryId: string | null;
    posthogTaskId: string;
    lastStatus?: string;
    transcriptEmpty: boolean;
    watched: boolean;
  }): Promise<void> {
    const client = await getPostHogCodeClient(task.workspaceId);
    if (!client) return; // credentials removed mid-run; leave as-is.

    const remote = await client.getTask(task.posthogTaskId);
    const run = remote.latest_run ?? null;
    const status = run?.status;
    if (!status) return;

    // The real run id lives on `latest_run.id`. Early FastOwl builds
    // mis-stored the task id here (the `run/` endpoint returns the task),
    // so trust the live value and self-heal the stored metadata below.
    const runId = run?.id;

    // Drive the log stream into the task transcript. `ensure` is
    // idempotent and self-heals across reconnects/backend restarts.
    // Live streaming is view-gated (taskWatch) — the SSE firehose plus
    // full-transcript persists are pure UI bytes, so nobody watching
    // means no stream.
    //   - terminal but no transcript yet (run finished unwatched, or
    //     while the backend was down): one-shot durable backfill from
    //     S3 — the stream self-terminates once drained.
    //   - running AND watched: keep a live SSE stream open.
    //   - otherwise (unwatched, or terminal with a transcript): tear
    //     down any lingering stream — `stop` persists what's buffered.
    const isTerminal = TERMINAL.has(status);
    if (runId && isTerminal && task.transcriptEmpty) {
      postHogCodeStreamer.ensure({
        taskId: task.id,
        workspaceId: task.workspaceId,
        posthogTaskId: task.posthogTaskId,
        posthogRunId: runId,
      });
    } else if (runId && !isTerminal && task.watched) {
      postHogCodeStreamer.ensure({
        taskId: task.id,
        workspaceId: task.workspaceId,
        posthogTaskId: task.posthogTaskId,
        posthogRunId: runId,
      });
    } else if (postHogCodeStreamer.isActive(task.id)) {
      postHogCodeStreamer.stop(task.id);
    }

    const prUrl = findPullRequestUrl(remote, run);

    // Keep metadata fresh (status + run id + PR url + log url) even while running.
    await patchTaskMetadata(task.id, (existing) => ({
      ...existing,
      posthogStatus: status,
      posthogRunId: runId ?? existing.posthogRunId,
      posthogLogUrl: run?.log_url ?? existing.posthogLogUrl,
      posthogPrUrl: prUrl ?? existing.posthogPrUrl,
    }));
    emitTaskUpdate(task.workspaceId, task.id, {
      metadata: { posthogStatus: status, posthogPrUrl: prUrl ?? undefined },
    });

    // A run that's done working but stuck in `in_progress` — auto-complete it.
    if (run && status === 'in_progress' && runId) {
      await this.maybeFinalizeIdle(task, client, run, runId, prUrl);
    }

    if (!TERMINAL.has(status)) return;

    if (status === 'completed') {
      if (prUrl && task.repositoryId) {
        await this.linkPr(task, run, prUrl);
      }
      // PostHog Code runs are reviewed in PostHog itself (the PR), so there's
      // nothing for FastOwl to approve — land straight in `completed`.
      const result: TaskResult = {
        success: true,
        summary: prUrl ? `PostHog Code opened ${prUrl}` : 'PostHog Code run completed',
        output: stringifyOutput(run?.output),
      };
      await this.finalize(task, 'completed', result);
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

  /**
   * Auto-complete a run that's done working but stuck in `in_progress`.
   * Gated on (a) the run's `updated_at` being stale past IDLE_FINALIZE_MS,
   * and (b) the session log having ended on a turn/task completion (not an
   * in-flight tool call) — so a long silent tool is never cut short. The
   * log-tail confirmation is throttled per task to avoid refetching every
   * tick while a run is stale-but-still-working.
   */
  private async maybeFinalizeIdle(
    task: { id: string; workspaceId: string; repositoryId: string | null; posthogTaskId: string },
    client: PostHogCodeClient,
    run: PostHogRun,
    runId: string,
    prUrl: string | null,
  ): Promise<void> {
    const updatedAtMs = run.updated_at ? Date.parse(run.updated_at) : NaN;
    if (Number.isNaN(updatedAtMs)) return;
    if (Date.now() - updatedAtMs < IDLE_FINALIZE_MS) {
      // Active recently — clear any throttle so a later idle spell re-checks.
      this.lastIdleCheck.delete(task.id);
      return;
    }

    const lastCheck = this.lastIdleCheck.get(task.id) ?? 0;
    if (Date.now() - lastCheck < IDLE_RECHECK_MS) return;
    this.lastIdleCheck.set(task.id, Date.now());

    let entries: AcpLogEntry[];
    try {
      entries = await client.getSessionLogs(task.posthogTaskId, runId, {
        after: new Date(updatedAtMs - IDLE_TAIL_WINDOW_MS).toISOString(),
        limit: 5000,
      });
    } catch {
      return; // can't confirm → leave it; we'll retry next window.
    }
    if (!lastFlowEventIsTurnComplete(entries)) return;

    const idleMin = Math.round((Date.now() - updatedAtMs) / 60_000);
    console.log(
      `[posthogCode] task ${task.id.slice(0, 8)}: run idle ${idleMin}m after turn_complete — auto-finalizing as completed`,
    );
    postHogCodeStreamer.stop(task.id);
    if (prUrl && task.repositoryId) await this.linkPr(task, run, prUrl);
    await this.finalize(task, 'completed', {
      success: true,
      summary: prUrl
        ? `PostHog Code went idle after opening ${prUrl}`
        : 'PostHog Code run went idle — auto-completed',
      output: stringifyOutput(run.output),
    });
  }

  private async finalize(
    task: { id: string; workspaceId: string },
    status: TaskStatus,
    result: TaskResult,
  ): Promise<void> {
    this.lastIdleCheck.delete(task.id);
    clearWatched(task.id);
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
    void this.captureOutcome(task, status, result, now);
  }

  /**
   * Server-side analytics for the terminal transition — the renderer can't
   * see runs that finish while the app is closed. One projected read (type,
   * createdAt, small cloud metadata — never the transcript) funds the
   * durations and PR linkage on the event. Best-effort.
   */
  private async captureOutcome(
    task: { id: string; workspaceId: string },
    status: TaskStatus,
    result: TaskResult,
    finishedAt: Date,
  ): Promise<void> {
    try {
      const rows = await getDbClient()
        .select({
          type: tasksTable.type,
          createdAt: tasksTable.createdAt,
          metadata: tasksTable.metadata,
        })
        .from(tasksTable)
        .where(eq(tasksTable.id, task.id))
        .limit(1);
      const row = rows[0];
      if (!row) return;
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const dispatchedAtMs = Date.parse(String(meta.dispatchedAt ?? ''));
      captureWorkspaceEvent(
        task.workspaceId,
        status === 'completed' ? 'task_completed' : 'task_failed',
        {
          task_id: task.id,
          task_type: row.type,
          provider: 'posthog_code',
          opened_pr: Boolean(meta.pullRequest || meta.posthogPrUrl),
          duration_total_ms: finishedAt.getTime() - new Date(row.createdAt).getTime(),
          ...(Number.isNaN(dispatchedAtMs)
            ? {}
            : { duration_run_ms: finishedAt.getTime() - dispatchedAtMs }),
          ...(result.error ? { error_reason: result.error } : {}),
        },
      );
    } catch {
      // Analytics must never affect task processing.
    }
  }
}

/**
 * Walk a session-log tail backwards and decide whether the run is sitting
 * at end-of-turn (vs mid-work). Returns true if the most recent meaningful
 * event is a `turn_complete`/`task_complete`; false if it's an in-flight
 * tool call, agent message, or error (still working / not a clean end), or
 * if no end-of-turn marker is present. Idle keepalives (`console`,
 * `usage_update`, `progress`) are skipped. Pure — exported for tests.
 */
export function lastFlowEventIsTurnComplete(entries: AcpLogEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const method = entries[i]?.notification?.method;
    if (method === '_posthog/turn_complete' || method === '_posthog/task_complete') {
      return true;
    }
    if (method === '_posthog/error') return false;
    if (method === 'session/update') {
      const su = (
        entries[i]?.notification?.params as
          | { update?: { sessionUpdate?: string } }
          | undefined
      )?.update?.sessionUpdate;
      if (
        su === 'tool_call' ||
        su === 'tool_call_update' ||
        su === 'agent_message' ||
        su === 'agent_message_chunk' ||
        su === 'agent_thought' ||
        su === 'agent_thought_chunk' ||
        su === 'user_message'
      ) {
        return false; // last real event was work, not a turn end
      }
    }
  }
  return false;
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
