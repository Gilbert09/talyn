import type { Workspace } from '@talyn/shared';
import { callApi } from '../api.js';
import { bool, booleanSchema, defineTool, resolveWorkspace, workspaceSchema } from './helpers.js';
import type { McpToolDefinition } from './index.js';

export const WORKSPACES: McpToolDefinition[] = [
  {
    name: 'talyn_list_workspaces',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description:
      'List your Talyn workspaces (each groups GitHub repos + integrations). Use this to discover workspace ids for the other tools.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (ownerId) => {
      const workspaces = await callApi<Workspace[]>(ownerId, 'GET', '/workspaces');
      if (workspaces.length === 0) return 'No workspaces.';
      return workspaces
        .map((w) => {
          const repos = w.repos.map((r) => r.name).join(', ') || 'no repos';
          return `- ${w.id}  ${w.name}  (${repos})`;
        })
        .join('\n');
    },
  },
];

WORKSPACES.push(
  defineTool(
    'get_workspace',
    'Get repositories, connected integrations, and key workspace settings. Prompt text requires include_prompts.',
    { ...workspaceSchema, include_prompts: booleanSchema },
    [],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const id = await resolveWorkspace(ownerId, args);
      const workspace = await callApi<Workspace>(ownerId, 'GET', `/workspaces/${id}`);
      const settings = workspace.settings ?? {};
      const prompts = Object.entries(settings.prompts ?? {}).filter(([, value]) => value !== null);
      const lines = [
        `${workspace.id}  ${workspace.name}`,
        ...workspace.repos.map((repo) => `${repo.id}  ${repo.name}  ${repo.url}`),
        `integrations: ${
          Object.entries(workspace.integrations ?? {})
            .filter(([, value]) => value?.enabled)
            .map(([name]) => name)
            .join(', ') || 'none'
        }`,
        `default auto-keep: ${settings.defaultAutoKeepMergeable ?? false}`,
        `merge queue mode: ${settings.mergeQueueMode === 'eager' ? 'eager' : 'ordered'}`,
        `code-review auto review: ${settings.codeReview?.autoReview ?? false}`,
        `custom prompts: ${prompts.map(([name]) => name).join(', ') || 'none'}`,
      ];
      if (bool(args, 'include_prompts', false)) {
        for (const [name, prompt] of prompts)
          if (prompt) lines.push(`${name}:\n${prompt.template}`);
      }
      return lines.join('\n');
    }
  )
);
