import type { SpacesTeam } from '@talyn/shared';
import { callApi } from '../api.js';
import type { McpToolDefinition } from './index.js';

export const SPACES: McpToolDefinition[] = [{
  name: 'talyn_list_spaces',
  description: 'List your teams and their live spaces.',
  feature: 'spaces',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  inputSchema: { type: 'object', properties: {} },
  handler: async (ownerId) => {
    const teams = await callApi<SpacesTeam[]>(ownerId, 'GET', '/teams');
    return teams.map((team) => [
      `${team.name} (${team.id}, ${team.role})`,
      ...team.spaces.map((space) => `  ${space.name} (${space.id})`),
    ].join('\n')).join('\n') || 'No teams or spaces.';
  },
}];
