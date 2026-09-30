import type { CreateTaskRequest, Task, TaskType } from '@talyn/shared';
import { callApi } from '../api.js';
import {
  str,
  requireId,
  trim,
  deriveTitle,
  resolveWorkspace,
  taskLine,
  pageLimit,
  fieldsText,
} from './helpers.js';
import type { McpToolDefinition } from './index.js';

export const TASKS: McpToolDefinition[] = [
  {
    name: 'talyn_create_task',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description:
      'Create a freeform cloud coding task on a repository (optionally linked to an existing PR). The agent runs on the workspace provider and opens a PR.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Defaults to your only workspace.' },
        repository_id: { type: 'string', description: 'Talyn repository id to target (required).' },
        prompt: { type: 'string', description: 'What the agent should build.' },
        title: { type: 'string', description: 'Auto-derived from the prompt if omitted.' },
        description: { type: 'string' },
        type: {
          type: 'string',
          enum: ['code_writing', 'pr_response', 'pr_review'],
          description: 'Default code_writing.',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'urgent'],
          description: 'Default medium.',
        },
        model: { type: 'string' },
        skill: {
          type: 'object',
          description: 'Skill reference only. Include the skill instructions in prompt.',
          properties: {
            key: { type: 'string' },
            name: { type: 'string' },
            source: { type: 'string', enum: ['repo', 'local', 'platform'] },
            repositoryId: { type: 'string' },
            platformSkillId: { type: 'string' },
          },
          required: ['key', 'name', 'source'],
        },
        pull_request_id: { type: 'string', description: 'Optionally link to an existing PR row.' },
      },
      required: ['repository_id', 'prompt'],
    },
    handler: async (ownerId, args) => {
      const ws = await resolveWorkspace(ownerId, args);
      const prompt = requireId(args, 'prompt');
      const body: CreateTaskRequest = {
        workspaceId: ws,
        type: (str(args.type) as TaskType | undefined) ?? 'code_writing',
        title: str(args.title) ?? deriveTitle(prompt),
        description: str(args.description) ?? '',
        prompt,
        priority: (str(args.priority) as CreateTaskRequest['priority']) ?? 'medium',
        repositoryId: requireId(args, 'repository_id'),
        pullRequestId: str(args.pull_request_id),
        model: str(args.model),
        skill: args.skill as CreateTaskRequest['skill'],
      };
      const task = await callApi<Task>(ownerId, 'POST', '/tasks', body);
      return `Created ${task.type} task ${task.id}: "${task.title}" (${task.status}).`;
    },
  },
  {
    name: 'talyn_list_tasks',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description: 'List cloud tasks in a workspace, optionally filtered by status or type.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        before: {
          type: 'string',
          format: 'date-time',
          description: 'The createdAt time of the last task on the previous page.',
        },
        status: {
          type: 'string',
          description:
            'Comma-separated statuses: queued | in_progress | completed | failed | needs_human | cancelled',
        },
        type: { type: 'string', description: 'code_writing | pr_response | pr_review' },
      },
    },
    handler: async (ownerId, args) => {
      const ws = await resolveWorkspace(ownerId, args);
      const limit = pageLimit(args, 100);
      const params = new URLSearchParams({ workspaceId: ws, limit: String(limit) });
      if (str(args.before)) params.set('before', str(args.before)!);
      if (str(args.status)) params.set('status', str(args.status)!);
      if (str(args.type)) params.set('type', str(args.type)!);
      const tasks = await callApi<Task[]>(ownerId, 'GET', `/tasks?${params.toString()}`);
      const lines = tasks.map(taskLine);
      if (tasks.length === limit)
        lines.push(`more: pass before=${tasks[tasks.length - 1].createdAt}`);
      return lines.join('\n') || 'No tasks.';
    },
  },
  {
    name: 'talyn_get_task',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description:
      "Get a cloud task's status, result summary, and linked PR. Set include_transcript to also return the raw run transcript (can be large).",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        include_transcript: { type: 'boolean', description: 'Default false.' },
      },
      required: ['task_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'task_id');
      const task = await callApi<Task>(ownerId, 'GET', `/tasks/${id}`);
      const meta = (task.metadata ?? {}) as Record<string, unknown>;
      const cloud = (meta.cloudTask ?? {}) as Record<string, unknown>;
      const prUrl = (cloud.prUrl as string) ?? (meta.posthogPrUrl as string) ?? null;
      const lines = [
        `${task.id}  [${task.status}]  ${task.type}  "${task.title}"`,
        task.branch ? `branch: ${task.branch}` : null,
        prUrl ? `PR: ${prUrl}` : null,
        task.result ? `result: ${trim(fieldsText(task.result), 600)}` : null,
      ].filter(Boolean) as string[];
      if (task.result?.needsHuman?.reason)
        lines.push(`needs human: ${task.result.needsHuman.reason}`);
      if (meta.quotaFailover) lines.push(`quota failover: ${fieldsText(meta.quotaFailover)}`);
      if (args.include_transcript === true && task.transcript) {
        lines.push('--- transcript ---', trim(fieldsText(task.transcript), 8000));
      }
      return lines.join('\n');
    },
  },
  {
    name: 'talyn_stop_task',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    description:
      'Cancel a running cloud task (best-effort remote cancel; the task lands in "cancelled").',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'task_id');
      const task = await callApi<Task>(ownerId, 'POST', `/tasks/${id}/stop`);
      return `Stopped task ${id} (${task.status}).`;
    },
  },
  {
    name: 'talyn_retry_task',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: 'Re-queue a failed or cancelled cloud task for another run.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'task_id');
      const task = await callApi<Task>(ownerId, 'POST', `/tasks/${id}/retry`);
      return `Re-queued task ${id} (${task.status}).`;
    },
  },
  {
    name: 'talyn_delete_task',
    description: 'Delete a task and its saved history. This does not cancel the remote agent.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
    annotations: { destructiveHint: true },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'task_id');
      await callApi(ownerId, 'DELETE', `/tasks/${id}`);
      return `${id} deleted.`;
    },
  },
];
