import type {
  CreateTaskRequest,
  Task,
  TaskPriority,
  TaskType,
} from '@talyn/shared';
import { request, workspaceId as envWorkspaceId } from './client.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

function resolveWorkspace(args: Record<string, unknown>): string {
  const id = (args.workspace_id as string | undefined) ?? envWorkspaceId();
  if (!id) {
    throw new Error(
      'workspace_id is required (or set TALYN_WORKSPACE_ID in the MCP server env)'
    );
  }
  return id;
}

/**
 * All FastOwl MCP tools. Each one talks to the FastOwl backend HTTP API
 * (at TALYN_API_URL) using the same calling convention as the CLI.
 */
export const TOOLS: ToolDefinition[] = [
  {
    name: 'talyn_create_task',
    description:
      'Create a new task in FastOwl. Use this to queue follow-up work that another Claude should pick up, without interrupting the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'Prompt for the Claude agent. Plain english describing what to build.',
        },
        type: {
          type: 'string',
          enum: ['code_writing', 'pr_response', 'pr_review', 'manual'],
          description: 'Task type. Default: code_writing.',
        },
        title: {
          type: 'string',
          description: 'Short task title. Auto-derived from prompt if omitted.',
        },
        description: {
          type: 'string',
          description: 'Longer task description.',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'urgent'],
          description: 'Priority. Default: medium.',
        },
        repository_id: {
          type: 'string',
          description: 'FastOwl repository id to target.',
        },
        environment_id: {
          type: 'string',
          description: 'Preferred environment id.',
        },
        workspace_id: {
          type: 'string',
          description:
            'Workspace id. Defaults to $TALYN_WORKSPACE_ID from the MCP server env.',
        },
      },
      required: ['prompt'],
    },
    handler: async (args) => {
      const ws = resolveWorkspace(args);
      const body: CreateTaskRequest = {
        workspaceId: ws,
        type: (args.type as TaskType) ?? 'code_writing',
        title: (args.title as string) ?? deriveTitle(args.prompt as string),
        description: (args.description as string) ?? '',
        prompt: args.prompt as string,
        priority: (args.priority as TaskPriority) ?? 'medium',
        repositoryId: args.repository_id as string | undefined,
        assignedEnvironmentId: args.environment_id as string | undefined,
      };
      const task = await request<Task>('POST', '/tasks', body);
      return `Created task ${task.id}: "${task.title}" (${task.status})`;
    },
  },
  {
    name: 'talyn_list_tasks',
    description:
      'List tasks in a workspace. Useful for checking what is queued, in-flight, or finished.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'string',
          description: 'Workspace id. Defaults to $TALYN_WORKSPACE_ID.',
        },
        status: {
          type: 'string',
          description:
            'Filter by status: queued, in_progress, completed, failed, cancelled.',
        },
        type: {
          type: 'string',
          description: 'Filter by type.',
        },
      },
    },
    handler: async (args) => {
      const ws = resolveWorkspace(args);
      const params = new URLSearchParams({ workspaceId: ws });
      if (args.status) params.set('status', String(args.status));
      if (args.type) params.set('type', String(args.type));
      const tasks = await request<Task[]>('GET', `/tasks?${params.toString()}`);
      if (tasks.length === 0) return 'No tasks found.';
      return tasks
        .map((t) => `- ${t.id}  [${t.status}]  ${t.type}  ${t.title}`)
        .join('\n');
    },
  },
];

function deriveTitle(prompt: string | undefined): string {
  if (!prompt) return 'New task';
  const first = prompt.split('\n')[0].trim();
  return first.slice(0, 80);
}
