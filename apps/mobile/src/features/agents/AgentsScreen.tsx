import { cloudProviders, type CloudProviderInfo } from '@talyn/client/native';
import type { FleetAccountsResponse, Workspace } from '@talyn/shared';

import { useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { AppText, Dot, EmptyState, Group, Pill, Row, toneColor, type Tone } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { agentLabel } from '../../lib/models';
import { useNow } from '../../lib/time';
import { useTheme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import { Fact, Loading, Page, WebRow } from '../more/Page';
import { useRemote } from '../more/useRemote';
import { accountBadge, accountKindLabel, accountsFor, accountUsageText, defaultFleetModel, defaultProviderLabel, providerRows } from './model';

const FLEET_AGENTS = ['claude', 'codex'] as const;

export function AgentsScreen() {
  const offline = useNetwork() === 'offline';
  const workspaceId = useWorkspace().selected;
  const providers = useResource<CloudProviderInfo[]>('providers');
  const workspace = useResource<Workspace>('workspace');
  const fleet = providers.data?.find((provider) => provider.type === 'selfhosted');
  // Only a workspace the fleet is offered to has accounts; a 404 means an older backend.
  const accounts = useRemote<FleetAccountsResponse | null>(fleet && workspaceId ? `fleet-accounts:${workspaceId}` : null,
    async () => {
      try { return await cloudProviders.fleetAccounts.list(workspaceId ?? ''); }
      catch (error) { if ((error as { status?: number }).status === 404) return null; throw error; }
    }, { intervalMs: 60_000 });
  const rows = providerRows(providers.data ?? []);
  const refresh = () => { void providers.refresh(); void workspace.refresh(); void accounts.refresh(); };
  const loaded = providers.data !== undefined;
  return <Page refreshing={(providers.refreshing || accounts.refreshing) && loaded} onRefresh={refresh}>
    {!loaded && providers.status === 'loading' ? <Loading /> : <StateNotice resource={providers} offline={offline} refresh={refresh} />}
    {loaded && rows.length === 0 ? <EmptyState title="No agents available" detail="Connect an agent in Talyn on the web." /> : null}
    {rows.length ? <Group title="Providers">
      {rows.map((row, index) => <Row key={row.type} title={row.name} subtitle={row.detail} divider={index < rows.length - 1}
        leading={<ToneDot tone={row.tone} />}
        accessibilityLabel={`${row.name}: ${row.detail}`} />)}
    </Group> : null}
    {fleet ? <FleetAccounts accounts={accounts.data} status={accounts.status} connected={fleet.connectedAgents ?? []}
      reauth={fleet.reauthAgents ?? []} retry={() => { void accounts.refresh(); }} /> : null}
    {loaded && rows.length ? <Group title="Defaults">
      <Fact label="New work goes to" value={defaultProviderLabel(workspace.data?.settings, providers.data ?? [])} divider={Boolean(defaultFleetModel(workspace.data?.settings))} />
      {defaultFleetModel(workspace.data?.settings) ? <Fact label="Talyn Fleet model" value={defaultFleetModel(workspace.data?.settings)} divider={false} /> : null}
    </Group> : null}
    <Group footer="Connect, reconnect, reorder and remove accounts in Talyn on the web.">
      <WebRow title="Manage on the web" path="/settings/integrations" />
    </Group>
  </Page>;
}

function FleetAccounts({ accounts, status, connected, reauth, retry }: {
  accounts: FleetAccountsResponse | null | undefined; status: string; connected: string[]; reauth: string[]; retry(): void;
}) {
  const now = useNow();
  if (accounts === undefined) {
    if (status === 'error') return <Group title="Talyn Fleet accounts"><Row title="Could not load accounts." divider={false}
      trailing={<AppText variant="meta" tone="primary" onPress={retry} accessibilityRole="button">Try again</AppText>} /></Group>;
    return status === 'loading' ? <Loading label="Loading accounts" /> : null;
  }
  return <>{FLEET_AGENTS.map((agent) => {
    // An older backend has no account list: say whether the agent is connected.
    if (accounts === null) {
      const state = reauth.includes(agent) ? { label: 'Reconnect needed', tone: 'warning' as const }
        : connected.includes(agent) ? { label: 'Connected', tone: 'success' as const } : { label: 'Not connected', tone: 'muted' as const };
      return <Group key={agent} title={agentLabel(agent)}><Row title={state.label} leading={<ToneDot tone={state.tone} />} divider={false} /></Group>;
    }
    const list = accountsFor(accounts.accounts, agent);
    const active = accounts.active[agent];
    return <Group key={agent} title={agentLabel(agent)}>
      {list.length === 0 ? <Row title="Not connected" leading={<ToneDot tone="muted" />} divider={false} /> : list.map((account, index) => {
        const badge = accountBadge(account, accounts.switchAtPercent, new Date(now));
        const kind = accountKindLabel(account.kind);
        return <Row key={account.id} title={account.label} divider={index < list.length - 1} leading={<ToneDot tone={badge.tone} />}
          subtitle={`${account.label.toLowerCase() === kind.toLowerCase() ? '' : `${kind} · `}${accountUsageText(account, new Date(now))}`}
          trailing={active === account.id ? <Pill label="Active" /> : undefined}
          accessibilityLabel={`${account.label}, ${badge.label}${active === account.id ? ', active' : ''}`}>
          {badge.label !== 'Connected' ? <Pill label={badge.label} tone={badge.tone} /> : null}
        </Row>;
      })}
    </Group>;
  })}</>;
}

function ToneDot({ tone }: { tone: Tone }) {
  const c = useTheme();
  return <Dot color={toneColor(c, tone)} size={8} />;
}
