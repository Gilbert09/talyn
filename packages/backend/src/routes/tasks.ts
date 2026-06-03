import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { and, desc, eq, SQL, sql } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import {
  tasks as tasksTable,
  workspaces as workspacesTable,
  pullRequests as pullRequestsTable,
} from '../db/schema.js';
import { openPullRequestForTask } from '../services/taskPullRequest.js';
import { attachTaskToPullRequestRow } from '../services/prCache.js';
import { taskQueueService } from '../services/taskQueue.js';
import {
  emitTaskStatus,
  emitTaskDeleted,
  emitTaskEvent,
} from '../services/websocket.js';
import { patchTaskMetadata } from '../services/taskMetadataMutex.js';
import { getCloudProvider } from '../services/cloudProviders/registry.js';
import { getPostHogCodeClient } from '../services/posthogCode/credentials.js';
import { postHogCodeStreamer } from '../services/posthogCode/streamer.js';
import {
  assertUser,
  handleAccessError,
  requireEnvironmentAccess,
  requireTaskAccess,
  requireWorkspaceAccess,
} from '../middleware/auth.js';
import {
  readCloudTaskProvider,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
  type CreateTaskRequest,
  type ApiResponse,
  type GenerateTaskMetadataRequest,
  type GenerateTaskMetadataResponse,
  type AgentEvent,
  type PostHogCodeRuntimeAdapter,
} from '@fastowl/shared';

/**
 * Cloud-only task routes. Every task is delegated to a cloud provider
 * (PostHog Code today). There is no local agent, working tree, or
 * approve/reject flow — review happens on the provider's PR. The handlers
 * here create/list/inspect tasks, enqueue them, and proxy cloud follow-up
 * actions (refresh logs, send a message) to the provider.
 */
export function taskRoutes(): Router {
  const router = Router();

  // Derive lightweight task metadata from a prompt. No LLM call — a clean
  // slug is enough; the cloud provider refines the title on its own run.
  router.post('/generate-metadata', async (req, res) => {
    const body = req.body as GenerateTaskMetadataRequest;
    if (!body.prompt) {
      return res.status(400).json({ success: false, error: 'Prompt is required' });
    }
    res.json({
      success: true,
      data: deriveTaskMetadata(body.prompt),
    } as ApiResponse<GenerateTaskMetadataResponse>);
  });

  // List tasks (with optional filters). Always scoped to the caller's
  // workspaces — the inner join on workspaces.owner_id enforces it even if
  // a workspaceId filter is omitted.
  router.get('/', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const { workspaceId, status, type } = req.query;

    if (workspaceId) {
      try {
        await requireWorkspaceAccess(req, workspaceId as string);
      } catch (err) {
        return handleAccessError(err, res);
      }
    }

    const conditions: SQL[] = [eq(workspacesTable.ownerId, user.id)];
    if (workspaceId) conditions.push(eq(tasksTable.workspaceId, workspaceId as string));
    if (status) conditions.push(eq(tasksTable.status, status as string));
    if (type) conditions.push(eq(tasksTable.type, type as string));

    const priorityCase = sql<number>`CASE ${tasksTable.priority}
      WHEN 'urgent' THEN 1
      WHEN 'high' THEN 2
      WHEN 'medium' THEN 3
      ELSE 4
    END`;

    const rows = await db
      .select({ task: tasksTable })
      .from(tasksTable)
      .innerJoin(workspacesTable, eq(tasksTable.workspaceId, workspacesTable.id))
      .where(and(...conditions))
      .orderBy(priorityCase, desc(tasksTable.createdAt));

    res.json({
      success: true,
      data: rows.map((r) => rowToTask(r.task)),
    } as ApiResponse<Task[]>);
  });

  // Get single task (includes the transcript).
  router.get('/:id', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const rows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    res.json({
      success: true,
      data: rowToTask(rows[0], { includeTranscript: true }),
    } as ApiResponse<Task>);
  });

  // Create task — queued immediately for the cloud scheduler to dispatch.
  router.post('/', async (req, res) => {
    const body = req.body as CreateTaskRequest;
    try {
      await requireWorkspaceAccess(req, body.workspaceId);
      if (body.assignedEnvironmentId) {
        await requireEnvironmentAccess(req, body.assignedEnvironmentId);
      }
    } catch (err) {
      return handleAccessError(err, res);
    }

    // Cloud tasks run against a repository (the provider clones it and
    // opens a PR), so a repo is required.
    if (!body.repositoryId) {
      return res.status(400).json({
        success: false,
        error:
          'repositoryId is required. Add a repository in Settings, then pick it when creating the task.',
      });
    }

    const db = getDbClient();
    const id = uuid();
    const now = new Date();

    // Stash cloud overrides (model / runtime adapter) on metadata — the
    // provider reads them at dispatch.
    const initialMetadata: Record<string, unknown> = {};
    if (body.runtimeAdapter) initialMetadata.runtimeAdapter = body.runtimeAdapter;
    if (body.model) initialMetadata.model = body.model;

    // When a task is started FROM a PR (e.g. "Get PR mergeable"), stash a
    // pullRequest pointer on metadata up front so the task screen renders
    // its PR pill immediately.
    if (body.pullRequestId) {
      const prRows = await db
        .select()
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, body.pullRequestId))
        .limit(1);
      const prRow = prRows[0];
      if (prRow && prRow.workspaceId === body.workspaceId) {
        initialMetadata.pullRequest = {
          id: prRow.id,
          number: prRow.number,
          url: (prRow.lastSummary as { url?: string } | null)?.url ?? '',
          createdAt: now.toISOString(),
        };
      }
    }

    await db.insert(tasksTable).values({
      id,
      workspaceId: body.workspaceId,
      type: body.type,
      // Auto-enqueue on create — the cloud scheduler picks up `queued`
      // tasks on its next tick (or immediately via runProcessQueue).
      status: 'queued',
      title: body.title,
      description: body.description,
      prompt: body.prompt ?? null,
      priority: body.priority || 'medium',
      repositoryId: body.repositoryId ?? null,
      assignedEnvironmentId: body.assignedEnvironmentId ?? null,
      metadata: Object.keys(initialMetadata).length > 0 ? initialMetadata : undefined,
      createdAt: now,
      updatedAt: now,
    });

    const rows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, id))
      .limit(1);
    res.status(201).json({ success: true, data: rowToTask(rows[0]) } as ApiResponse<Task>);

    // Link the task to the PR it was started from, so the GitHub screen
    // can show a live in-progress indicator that deep-links back here.
    if (body.pullRequestId) {
      void attachTaskToPullRequestRow({
        workspaceId: body.workspaceId,
        pullRequestId: body.pullRequestId,
        taskId: id,
      }).catch((err) => {
        console.error('[tasks] failed to link task to PR:', err);
      });
    }
  });

  // Update task
  router.patch('/:id', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const body = req.body as {
      status?: TaskStatus;
      priority?: TaskPriority;
      title?: string;
      description?: string;
      prompt?: string;
      assignedEnvironmentId?: string;
      result?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };

    const existing = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!existing[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    const updates: Record<string, unknown> = {};
    if (body.status !== undefined) updates.status = body.status;
    if (body.priority !== undefined) updates.priority = body.priority;
    if (body.title !== undefined) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description;
    if (body.prompt !== undefined) updates.prompt = body.prompt;
    if (body.assignedEnvironmentId !== undefined)
      updates.assignedEnvironmentId = body.assignedEnvironmentId;
    if (body.result !== undefined) updates.result = body.result;
    if (body.metadata !== undefined) updates.metadata = body.metadata;

    const now = new Date();
    if (
      body.status === 'completed' ||
      body.status === 'failed' ||
      body.status === 'cancelled'
    ) {
      updates.completedAt = now;
    }

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = now;
      await db
        .update(tasksTable)
        .set(updates)
        .where(eq(tasksTable.id, req.params.id));
    }

    const rows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    res.json({ success: true, data: rowToTask(rows[0]) } as ApiResponse<Task>);
  });

  // Retry/reset a task back to queued for re-dispatch.
  router.post('/:id/retry', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const existing = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!existing[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    // Clear the prior cloud run so dispatch starts a fresh one rather than
    // treating the task as already dispatched (idempotency short-circuit).
    await patchTaskMetadata(req.params.id, (meta) => {
      const next = { ...meta };
      delete next.posthogTaskId;
      delete next.posthogRunId;
      delete next.posthogStatus;
      delete next.cloudTask;
      return next;
    });
    await db
      .update(tasksTable)
      .set({ status: 'queued', result: null, completedAt: null, updatedAt: new Date() })
      .where(eq(tasksTable.id, req.params.id));
    void taskQueueService.processQueue();

    const rows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    res.json({ success: true, data: rowToTask(rows[0]) } as ApiResponse<Task>);
  });

  // Enqueue a task for dispatch (idempotent — already-running tasks are
  // left alone). The old local `/start` semantics collapse to "queue it".
  router.post('/:id/start', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const rows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    const task = rowToTask(rows[0]);
    if (task.status !== 'in_progress') {
      await taskQueueService.queueTask(task.id);
    }
    const updated = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, task.id))
      .limit(1);
    res.json({ success: true, data: rowToTask(updated[0]) } as ApiResponse<Task>);
  });

  // Stop a running cloud task — drop its transcript stream and mark failed.
  router.post('/:id/stop', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const rows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    const task = rowToTask(rows[0]);
    if (task.status !== 'in_progress') {
      return res.status(400).json({ success: false, error: 'Task is not running' });
    }

    const provider = getCloudProvider(readCloudTaskProvider(task));
    provider?.stopStreaming(task.id);

    const now = new Date();
    await db
      .update(tasksTable)
      .set({
        status: 'failed',
        result: { success: false, error: 'Stopped by user' },
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(tasksTable.id, task.id));
    emitTaskStatus(task.workspaceId, task.id, 'failed', {
      success: false,
      error: 'Stopped by user',
    });

    const updatedRows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, task.id))
      .limit(1);
    res.json({ success: true, data: rowToTask(updatedRows[0]) } as ApiResponse<Task>);
  });

  // Retry opening a PR for a task. Dormant for cloud providers that open
  // their own PR (PostHog Code); kept for a future branch-only provider.
  router.post('/:id/retry-pr', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const rows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    const task = rowToTask(rows[0]);
    await openPullRequestForTask(task.id);

    const updated = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, task.id))
      .limit(1);
    const updatedTask = rowToTask(updated[0]);
    const prState =
      (updatedTask.metadata as {
        pullRequest?: { number: number; url: string };
        pullRequestError?: string;
      } | undefined) ?? {};

    if (prState.pullRequest) {
      return res.json({ success: true, data: { pullRequest: prState.pullRequest } });
    }
    return res.status(502).json({
      success: false,
      error: prState.pullRequestError || 'PR creation is not available for this provider',
    });
  });

  // On-demand log fetch for a PostHog Code (cloud) task. The poller only
  // streams `in_progress` tasks, so opening a finished task — or a running
  // one before the first poll tick — would otherwise show a blank
  // transcript. Resolves the real run id, then kicks the streamer (live
  // SSE tail or one-shot S3 backfill). Events flow over `task:event`.
  router.post('/:id/refresh-logs', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    const rows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    const task = rowToTask(rows[0]);
    const meta = (task.metadata ?? {}) as Record<string, unknown>;
    const posthogTaskId = meta.posthogTaskId as string | undefined;
    if (!posthogTaskId) {
      return res.status(400).json({ success: false, error: 'Not a PostHog Code task.' });
    }
    const client = await getPostHogCodeClient(task.workspaceId);
    if (!client) {
      return res.status(400).json({
        success: false,
        error: 'PostHog Code is not configured for this workspace.',
      });
    }

    let runId: string | undefined;
    let terminal = false;
    try {
      const remote = await client.getTask(posthogTaskId);
      runId = remote.latest_run?.id;
      const status = remote.latest_run?.status;
      terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
    } catch (err) {
      return res.status(502).json({
        success: false,
        error: err instanceof Error ? err.message : 'Failed to reach PostHog Code.',
      });
    }
    if (!runId) {
      return res.status(409).json({ success: false, error: 'The run has not started yet.' });
    }

    if (runId !== meta.posthogRunId) {
      await patchTaskMetadata(task.id, (existing) => ({ ...existing, posthogRunId: runId }));
    }
    postHogCodeStreamer.ensure({
      taskId: task.id,
      workspaceId: task.workspaceId,
      posthogTaskId,
      posthogRunId: runId,
      backfillOnly: terminal,
    });
    await postHogCodeStreamer.flushNow(task.id);
    return res.json({ success: true });
  });

  // Send a follow-up message to a PostHog Code (cloud) task. Live run →
  // inject into the running session; finished run → resume into a fresh
  // run carrying the message. Task flips back to in_progress.
  router.post('/:id/message', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const message =
      typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required.' });
    }
    const model = typeof req.body?.model === 'string' ? req.body.model : undefined;
    const reasoningEffort =
      typeof req.body?.reasoningEffort === 'string' ? req.body.reasoningEffort : undefined;

    const db = getDbClient();
    const rows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, req.params.id))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    const task = rowToTask(rows[0], { includeTranscript: true });
    const meta = (task.metadata ?? {}) as Record<string, unknown>;
    const posthogTaskId = meta.posthogTaskId as string | undefined;
    if (!posthogTaskId) {
      return res.status(400).json({ success: false, error: 'Not a PostHog Code task.' });
    }
    const client = await getPostHogCodeClient(task.workspaceId);
    if (!client) {
      return res.status(400).json({
        success: false,
        error: 'PostHog Code is not configured for this workspace.',
      });
    }

    let runId: string | undefined;
    let runStatus: string | undefined;
    try {
      const remote = await client.getTask(posthogTaskId);
      runId = remote.latest_run?.id;
      runStatus = remote.latest_run?.status;
    } catch (err) {
      return res.status(502).json({
        success: false,
        error: err instanceof Error ? err.message : 'Failed to reach PostHog Code.',
      });
    }
    if (!runId) {
      return res.status(409).json({ success: false, error: 'No run to continue yet.' });
    }

    const runtimeAdapter =
      (meta.runtimeAdapter as PostHogCodeRuntimeAdapter | undefined) ?? 'claude';

    try {
      if (runStatus === 'in_progress') {
        await client.sendRunCommand(posthogTaskId, runId, {
          method: 'user_message',
          params: { content: message },
        });
        await patchTaskMetadata(task.id, (existing) => ({
          ...existing,
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        }));
        return res.json({ success: true });
      }

      const resumed = await client.resumeRun(posthogTaskId, {
        resumeFromRunId: runId,
        message,
        runtimeAdapter,
        model,
        reasoningEffort,
      });
      const newRunId = resumed.latest_run?.id ?? runId;

      const existing = Array.isArray(task.transcript)
        ? (task.transcript as AgentEvent[])
        : [];
      const nextSeq = existing.reduce((m, e) => Math.max(m, e.seq + 1), 0);
      const userEvent = {
        seq: nextSeq,
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: message }] },
      } as AgentEvent;
      const seeded = [...existing, userEvent];

      await db
        .update(tasksTable)
        .set({
          status: 'in_progress',
          transcript: seeded as unknown as object,
          completedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(tasksTable.id, task.id));
      await patchTaskMetadata(task.id, (existing2) => ({
        ...existing2,
        posthogRunId: newRunId,
        posthogStatus: resumed.latest_run?.status ?? 'queued',
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      }));
      emitTaskStatus(task.workspaceId, task.id, 'in_progress');
      emitTaskEvent(task.workspaceId, task.id, userEvent);

      postHogCodeStreamer.stop(task.id);
      postHogCodeStreamer.ensure({
        taskId: task.id,
        workspaceId: task.workspaceId,
        posthogTaskId,
        posthogRunId: newRunId,
        seedTranscript: seeded,
      });
      return res.json({ success: true });
    } catch (err) {
      return res.status(502).json({
        success: false,
        error: err instanceof Error ? err.message : 'PostHog Code rejected the message.',
      });
    }
  });

  // Delete task
  router.delete('/:id', async (req, res) => {
    try {
      await requireTaskAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const db = getDbClient();
    try {
      const rows = await db
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.id, req.params.id))
        .limit(1);
      const task = rows[0] ? rowToTask(rows[0]) : null;
      if (task && task.status === 'in_progress') {
        const provider = getCloudProvider(readCloudTaskProvider(task));
        provider?.stopStreaming(task.id);
      }

      const result = await db
        .delete(tasksTable)
        .where(eq(tasksTable.id, req.params.id))
        .returning({ id: tasksTable.id });
      if (result.length === 0) {
        return res.status(404).json({ success: false, error: 'Task not found' });
      }
      if (task) emitTaskDeleted(task.workspaceId, task.id);
      res.json({ success: true } as ApiResponse<void>);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[tasks] delete failed for ${req.params.id}:`, err);
      res.status(500).json({ success: false, error: `Delete failed: ${message}` });
    }
  });

  return router;
}

/** Derive a friendly-ish title/description/priority from a prompt. */
function deriveTaskMetadata(prompt: string): GenerateTaskMetadataResponse {
  const firstLine = prompt.split('\n')[0]?.trim() ?? '';
  const title = (firstLine || prompt).slice(0, 60).trim() || 'New Task';
  return {
    title,
    description: prompt.slice(0, 200).trim(),
    suggestedPriority: 'medium',
  };
}

function rowToTask(
  row: typeof tasksTable.$inferSelect,
  opts: { includeTranscript?: boolean } = {}
): Task {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type as TaskType,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    title: row.title,
    description: row.description,
    prompt: row.prompt ?? undefined,
    repositoryId: row.repositoryId ?? undefined,
    branch: row.branch ?? undefined,
    assignedEnvironmentId: row.assignedEnvironmentId ?? undefined,
    result: (row.result as Task['result']) ?? undefined,
    metadata: (row.metadata as Task['metadata']) ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : undefined,
    transcript: opts.includeTranscript
      ? ((row.transcript as Task['transcript']) ?? undefined)
      : undefined,
  };
}
