import { linear, posthog, slack, trunk, workspaces } from '@talyn/client/native';
import { INTEGRATION_CATALOG, integrationsOffered, type IntegrationKind, type Workspace } from '@talyn/shared';

import { useWorkspace } from '../../auth/AuthProvider';
import { EmptyState, Group, Pill, Row } from '../../components/UI';
import { useFeatures } from '../../lib/features';
import { useResource } from '../../workflow/hooks';
import { Intro, Loading, Page } from '../more/Page';
import { useRemote } from '../more/useRemote';
import { githubIssuesAvailable } from './model';

type ConnectionState = 'connected' | 'not_connected' | 'built_in' | 'unknown';

export function CatalogScreen() {
  const features = useFeatures();
  const workspaceId = useWorkspace().selected;
  const workspace = useResource<Workspace>('workspace', '', Boolean(workspaceId));
  const slackStatus = useRemote(features?.workbenches ? 'integration-slack' : null, () => slack.getStatus());
  const posthogStatus = useRemote(workspaceId ? `integration-posthog:${workspaceId}` : null, () => posthog.getStatus(workspaceId as string));
  const trunkStatus = useRemote(features?.trunkMergeEta && workspaceId ? `integration-trunk:${workspaceId}` : null,
    () => trunk.getStatus(workspaceId as string));
  const linearStatus = useRemote(features?.issueRules && workspaceId ? `integration-linear:${workspaceId}` : null,
    () => linear.getStatus(workspaceId as string));
  const tailscaleStatus = useRemote(features?.privateRoutes && workspaceId ? `integration-tailscale:${workspaceId}` : null,
    () => workspaces.privateConnector.get(workspaceId as string).then((connector) => connector.status === 'connected').catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404) return false;
      throw error;
    }));

  if (!features) return <Page><Loading /></Page>;
  if (!workspaceId) return <Page><EmptyState title="No Workspace Selected" detail="Choose a workspace to see integrations." /></Page>;

  const states: Record<IntegrationKind, ConnectionState> = {
    github: workspace.data?.id === workspaceId ? (workspace.data.integrations?.github?.enabled ? 'connected' : 'not_connected') : 'unknown',
    slack: slackStatus.data ? (slackStatus.data.installations.length > 0 ? 'connected' : 'not_connected') : 'unknown',
    github_issues: workspace.data?.id === workspaceId ? (workspace.data.integrations?.github?.enabled ? 'connected' : 'not_connected') : 'unknown',
    linear: linearStatus.data ? (linearStatus.data.connections.length > 0 ? 'connected' : 'not_connected') : 'unknown',
    webhook: 'built_in',
    schedule: 'built_in',
    tailscale: tailscaleStatus.data === undefined ? 'unknown' : tailscaleStatus.data ? 'connected' : 'not_connected',
    posthog: posthogStatus.data ? (posthogStatus.data.connected ? 'connected' : 'not_connected') : 'unknown',
    trunk: trunkStatus.data ? (trunkStatus.data.connected ? 'connected' : 'not_connected') : 'unknown',
  };
  return <Page>
    <Intro>Connect the places work comes from. Each integration holds its connection and automations.</Intro>
    {integrationsOffered(features).filter((kind) => kind !== 'github_issues' || githubIssuesAvailable(states.github === 'connected')).map((kind) => {
      const info = INTEGRATION_CATALOG[kind];
      const state = states[kind];
      return <Group key={kind}>
        <Row title={info.name} subtitle={kind === 'github' ? 'Track pull requests and run automations when a pull request changes.' : info.description} subtitleLines={3} chevron divider={false}
          href={{ pathname: '/integrations/[kind]', params: { kind } }} accessibilityLabel={`${info.name}. ${state === 'built_in' ? 'Built in' : state === 'unknown' ? 'Status unknown' : state === 'connected' ? 'Connected' : 'Not connected'}.`}
          trailing={state === 'unknown' ? undefined : <Pill label={state === 'built_in' ? 'Built in' : state === 'connected' ? 'Connected' : 'Not connected'}
            tone={state === 'connected' ? 'success' : 'muted'} />} />
      </Group>;
    })}
    <Group title="Agent accounts">
      <Row title="Agents" subtitle="Connect Claude or Codex" chevron href="/agents" divider={false} />
    </Group>
  </Page>;
}
