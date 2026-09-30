import type {
  BillingStatus,
  CloudProviderType,
  FleetAgent,
  ReleaseNoteEntry,
  Workspace,
} from '@talyn/shared';
import { callApi } from '../api.js';
import { defineTool, resolveWorkspace, str, textSchema, workspaceSchema } from './helpers.js';

interface CloudProviderInfo {
  type: CloudProviderType;
  connected: boolean;
  connectedAgents?: FleetAgent[];
  reauthAgents?: FleetAgent[];
}

export const ACCOUNT = [
  defineTool(
    'get_billing_status',
    'Get your plan and current usage against task, merge queue, workflow, and loop limits.',
    {},
    [],
    { readOnlyHint: true },
    async (ownerId) => {
      const status = await callApi<BillingStatus>(ownerId, 'GET', '/billing/status');
      return [
        `plan: ${status.plan}`,
        `tasks: ${status.activeTasks}/${status.activeTaskLimit ?? 'unlimited'}`,
        `merge queue: ${status.queuedPrs}/${status.mergeQueueLimit ?? 'unlimited'}`,
        `workflows: ${status.workflows}/${status.workflowLimit ?? 'unlimited'}`,
        `loops: ${status.loops}/${status.loopLimit ?? 'unlimited'}`,
      ].join('\n');
    }
  ),
  defineTool(
    'list_cloud_providers',
    'List cloud providers, connected agents, agents that need sign-in, and the workspace default.',
    workspaceSchema,
    [],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const id = await resolveWorkspace(ownerId, args);
      const params = new URLSearchParams({ workspaceId: id });
      const [providers, workspace] = await Promise.all([
        callApi<CloudProviderInfo[]>(ownerId, 'GET', `/cloud-providers?${params}`),
        callApi<Workspace>(ownerId, 'GET', `/workspaces/${id}`),
      ]);
      return [
        ...providers.map(
          (provider) =>
            `${provider.type}  connected: ${provider.connected}  agents: ${provider.connectedAgents?.join(', ') || 'none'}  reauth needed: ${provider.reauthAgents?.join(', ') || 'none'}`
        ),
        `default provider: ${workspace.settings?.defaultCloudProvider ?? 'auto'}`,
      ].join('\n');
    }
  ),
  defineTool(
    'whats_new',
    'Get the latest release notes, or all releases after the version given in since.',
    { since: textSchema },
    [],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const since = str(args.since);
      const entries = since
        ? await callApi<ReleaseNoteEntry[]>(
            ownerId,
            'GET',
            `/release-notes?${new URLSearchParams({ since })}`
          )
        : [await callApi<ReleaseNoteEntry | null>(ownerId, 'GET', '/release-notes/latest')];
      return (
        entries
          .filter((entry): entry is ReleaseNoteEntry => entry !== null)
          .map((entry) =>
            [
              `${entry.version}  ${entry.publishedAt}`,
              ...entry.highlights.map(
                (highlight) => `${highlight.title}: ${highlight.description}`
              ),
            ].join('\n')
          )
          .join('\n') || 'No release notes.'
      );
    }
  ),
];
