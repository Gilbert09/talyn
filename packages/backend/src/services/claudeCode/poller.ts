import { eq } from 'drizzle-orm';
import type {
  AgentEvent,
  CloudTaskMetadata,
  TaskResult,
  TaskStatus,
} from '@fastowl/shared';
import { readCloudTaskMeta } from '@fastowl/shared';
import { getDbClient } from '../../db/client.js';
import {
  tasks as tasksTable,
  repositories as repositoriesTable,
} from '../../db/schema.js';
import { captureWorkspaceEvent } from '../analytics.js';
import { patchTaskMetadata } from '../taskMetadataMutex.js';
import { emitTaskStatus, emitTaskUpdate, emitTaskEvent } from '../websocket.js';
import { linkTaskToPullRequest } from '../prCache.js';
import { clearWatched } from '../cloudProviders/taskWatch.js';
import type { CloudTaskRow } from '../cloudProviders/types.js';
import { getClaudeCodeClient } from './credentials.js';
import {
  managedAgentEventsToAgentEvents,
  findPullRequestUrl,
  type ManagedAgentEvent,
} from './converter.js';

const TRANSCRIPT_MAX_EVENTS = 2000;

/**
 * Reconciles FastOwl tasks delegated to Claude Managed Agents. Anthropic owns
 * the agent loop in its sandbox; we poll each in-flight session, ingest its
 * events into the task transcript, link the PR it opens, and drive the local
 * task to `completed` / `failed`.
 *
 * Poll-based (the `/events/stream` endpoint only replays + closes), so unlike
 * the PostHog streamer there's no long-lived connection — `reconcileTask` does
 * the full job each tick.
 */
class ClaudeCodePoller {
  /** taskId → count of transcript events already persisted+emitted (in-memory
   *  cursor; avoids re-writing/re-emitting an unchanged transcript each tick). */
  private emitted = new Map<string, number>();

  /** Entry point the generic cloud poller calls via the provider wrapper. */
  async reconcileTask(row: CloudTaskRow): Promise<void> {
    const cloud = readCloudTaskMeta({ metadata: row.metadata });
    if (!cloud || cloud.provider !== 'claude_routine' || !cloud.remoteTaskId) return;
    const sessionId = cloud.remoteTaskId;

    const client = await getClaudeCodeClient(row.workspaceId);
    if (!client) return; // credentials removed mid-run; leave as-is.

    const session = await client.getSession(sessionId);
    // Sessions have no "completed" status — a finished run sits `idle` with a
    // terminal `stop_reason`. A not-yet-started session is `idle` with no
    // stop_reason, so requiring end_turn avoids a false terminal.
    const terminal = session.status === 'idle' && session.stop_reason?.type === 'end_turn';

    // Fetch the event log (the transcript source) when the run is being watched
    // (live view) or has finished (one-shot backfill + PR detection). Skipping
    // it for unwatched in-flight runs keeps egress + token cost down.
    let prUrl = cloud.prUrl ?? null;
    if (terminal || row.watched) {
      let events: ManagedAgentEvent[] = [];
      try {
        events = await client.listEvents(sessionId);
      } catch (err) {
        console.warn(
          `[claudeCode] listEvents failed for task ${row.id.slice(0, 8)}:`,
          err instanceof Error ? err.message : err,
        );
      }
      prUrl = findPullRequestUrl(events) ?? prUrl;
      await this.syncTranscript(row.id, row.workspaceId, events);
    }

    await patchTaskMetadata(row.id, (existing) => {
      const prev = (existing.cloudTask as CloudTaskMetadata | undefined) ?? cloud;
      return {
        ...existing,
        cloudTask: {
          ...prev,
          status: session.status ?? prev.status,
          prUrl: prUrl ?? prev.prUrl,
        },
      };
    });
    emitTaskUpdate(row.workspaceId, row.id, {
      metadata: { cloudTask: { status: session.status, prUrl: prUrl ?? undefined } },
    });

    if (!terminal) return;

    if (prUrl && row.repositoryId) {
      await this.linkPr(row.workspaceId, row.repositoryId, row.id, prUrl);
    }
    const result: TaskResult = {
      success: true,
      summary: prUrl ? `Claude Code opened ${prUrl}` : 'Claude Code run completed',
    };
    await this.finalize(row.id, row.workspaceId, 'completed', result);
  }

  /** Poll-based: rebuild the transcript from the full event log, persist + emit
   *  only what's new (seq = stable index). No-op when nothing changed. */
  private async syncTranscript(
    taskId: string,
    workspaceId: string,
    rawEvents: ManagedAgentEvent[],
  ): Promise<void> {
    const inputs = managedAgentEventsToAgentEvents(rawEvents);
    const prevCount = this.emitted.get(taskId) ?? 0;
    if (inputs.length <= prevCount) return; // nothing new — skip the write

    const transcript: AgentEvent[] = inputs.map((input, i) => ({ ...input, seq: i }) as AgentEvent);
    for (let i = prevCount; i < transcript.length; i += 1) {
      emitTaskEvent(workspaceId, taskId, transcript[i]);
    }
    this.emitted.set(taskId, transcript.length);
    await this.persist(taskId, transcript);
  }

  private async persist(taskId: string, full: AgentEvent[]): Promise<void> {
    let transcript = full;
    if (transcript.length > TRANSCRIPT_MAX_EVENTS) {
      const head = transcript.slice(0, 100);
      const tail = transcript.slice(transcript.length - (TRANSCRIPT_MAX_EVENTS - 101));
      const marker: AgentEvent = {
        seq: -1,
        type: 'system',
        subtype: 'truncated',
        dropped: transcript.length - (head.length + tail.length),
      } as AgentEvent;
      transcript = [...head, marker, ...tail];
    }
    await getDbClient()
      .update(tasksTable)
      .set({ transcript: transcript as unknown as object, updatedAt: new Date() })
      .where(eq(tasksTable.id, taskId));
  }

  /** Drop the in-memory transcript cursor for a task (stop/delete). */
  stopStreaming(taskId: string): void {
    this.emitted.delete(taskId);
  }

  private async linkPr(
    workspaceId: string,
    repositoryId: string,
    taskId: string,
    prUrl: string,
  ): Promise<void> {
    const parsed = parsePrUrl(prUrl);
    if (!parsed) return;
    const db = getDbClient();
    const repoRows = await db
      .select({ defaultBranch: repositoriesTable.defaultBranch })
      .from(repositoriesTable)
      .where(eq(repositoriesTable.id, repositoryId))
      .limit(1);
    const baseBranch = repoRows[0]?.defaultBranch || 'main';
    try {
      const rowId = await linkTaskToPullRequest({
        workspaceId,
        repositoryId,
        taskId,
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        url: prUrl,
        title: '',
        author: '',
        headBranch: '',
        baseBranch,
        headSha: '',
      });
      await patchTaskMetadata(taskId, (existing) => ({
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
        `[claudeCode] failed to link PR for task ${taskId.slice(0, 8)}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async finalize(
    taskId: string,
    workspaceId: string,
    status: TaskStatus,
    result: TaskResult,
  ): Promise<void> {
    this.emitted.delete(taskId);
    clearWatched(taskId);
    const now = new Date();
    await getDbClient()
      .update(tasksTable)
      .set({
        status,
        result,
        completedAt: status === 'completed' ? now : null,
        updatedAt: now,
      })
      .where(eq(tasksTable.id, taskId));
    emitTaskStatus(workspaceId, taskId, status, result);
    void this.captureOutcome(taskId, workspaceId, status, result, now);
  }

  private async captureOutcome(
    taskId: string,
    workspaceId: string,
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
        .where(eq(tasksTable.id, taskId))
        .limit(1);
      const row = rows[0];
      if (!row) return;
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const cloud = meta.cloudTask as CloudTaskMetadata | undefined;
      captureWorkspaceEvent(
        workspaceId,
        status === 'completed' ? 'task_completed' : 'task_failed',
        {
          task_id: taskId,
          task_type: row.type,
          provider: 'claude_routine',
          opened_pr: Boolean(meta.pullRequest || cloud?.prUrl),
          duration_total_ms: finishedAt.getTime() - new Date(row.createdAt).getTime(),
          ...(result.error ? { error_reason: result.error } : {}),
        },
      );
    } catch {
      // Analytics must never affect task processing.
    }
  }
}

function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const match = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

export const claudeCodePoller = new ClaudeCodePoller();
