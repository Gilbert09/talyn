import { cloudProviders, workspaces as workspaceApi, type CloudProviderInfo } from '@talyn/client/native';
import type { FleetAccountsResponse, FleetAccountView, FleetAgent, Workspace } from '@talyn/shared';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { useMobileRuntime, useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { AppText, Button, Dot, EmptyState, Group, Pill, PromptSheet, Row, toneColor, useActionSheet, type SheetAction, type Tone } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { showActionError } from '../../lib/errors';
import { agentLabel } from '../../lib/models';
import { useNow } from '../../lib/time';
import { useTheme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import { Fact, Loading, Page, WebRow } from '../more/Page';
import { useRemote } from '../more/useRemote';
import { ConnectAgentSheet, loadFleetAccounts } from './connect/ConnectAgentSheet';
import { accountActions, agentAccounts, agentState, FLEET_AGENTS, movedOrder, type AccountAction } from './connect/model';
import { accountBadge, accountKindLabel, accountUsageText, defaultFleetModel, defaultOptions, defaultPatch, defaultProviderLabel,
  defaultValue, providerRows } from './model';

interface ConnectRequest { agent: FleetAgent; accountId?: string; add?: boolean }

const ACTION_LABEL: Record<AccountAction, string> = {
  reconnect: 'Reconnect', refresh: 'Refresh usage', up: 'Move up', down: 'Move down', rename: 'Rename', remove: 'Remove',
};

export function AgentsScreen() {
  const { workflow } = useMobileRuntime();
  const offline = useNetwork() === 'offline';
  const workspaceId = useWorkspace().selected;
  const providers = useResource<CloudProviderInfo[]>('providers');
  const workspace = useResource<Workspace>('workspace');
  const fleet = providers.data?.find((provider) => provider.type === 'selfhosted');
  // Only a workspace the fleet is offered to has accounts; null means an older backend.
  const accounts = useRemote<FleetAccountsResponse | null>(fleet && workspaceId ? `fleet-accounts:${workspaceId}` : null,
    () => loadFleetAccounts(workspaceId ?? ''), { intervalMs: 60_000 });
  const menu = useActionSheet();
  const [connect, setConnect] = useState<ConnectRequest | null>(null);
  const [renaming, setRenaming] = useState<FleetAccountView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = providerRows(providers.data ?? []);
  const refresh = () => { void providers.refresh(); void workspace.refresh(); void accounts.refresh(); };
  const changed = async () => {
    await Promise.allSettled([accounts.refresh(), workflow.load('providers'), workflow.load('readiness')]);
  };
  const run = async (key: string, title: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try { await action(); await changed(); }
    catch (error) { showActionError(title, error); }
    finally { setBusy(null); }
  };
  const loaded = providers.data !== undefined;

  const accountMenu = (account: FleetAccountView, list: FleetAccountView[], index: number) => {
    const ids = list.map((item) => item.id);
    const perform: Record<AccountAction, () => void> = {
      reconnect: () => setConnect({ agent: account.agent, accountId: account.id }),
      refresh: () => { void run(account.id, 'Could not refresh usage', () => cloudProviders.fleetAccounts.refreshUsage(account.id)); },
      up: () => { void run(account.id, 'Could not move the account', () => cloudProviders.fleetAccounts.reorder(workspaceId ?? '', account.agent, movedOrder(ids, index, -1))); },
      down: () => { void run(account.id, 'Could not move the account', () => cloudProviders.fleetAccounts.reorder(workspaceId ?? '', account.agent, movedOrder(ids, index, 1))); },
      rename: () => setRenaming(account),
      remove: () => Alert.alert(`Remove ${account.label}?`, 'Talyn stops using this account.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => { void run(account.id, 'Could not remove the account', () => cloudProviders.fleetAccounts.remove(account.id)); } },
      ]),
    };
    menu.open({ title: account.label, message: accountKindLabel(account.kind),
      actions: accountActions(account, index, list.length).map((action): SheetAction => ({
        label: ACTION_LABEL[action], destructive: action === 'remove', onPress: perform[action],
        detail: action === 'up' || action === 'down' ? 'Talyn uses accounts in this order.' : undefined,
      })) });
  };

  const options = defaultOptions(providers.data ?? []);
  const current = defaultValue(workspace.data?.settings);
  const currentLabel = options.find((option) => option.value === current)?.label ?? defaultProviderLabel(workspace.data?.settings, providers.data ?? []);
  const chooseDefault = () => menu.open({ title: 'New work goes to', message: 'Automatic prefers Talyn Fleet, then PostHog Code.',
    actions: options.map((option) => ({ label: option.label, selected: option.value === current, onPress: () => {
      if (option.value === current || !workspaceId) return;
      void run('default', 'Could not change the default', async () => {
        await workspaceApi.update(workspaceId, { settings: defaultPatch(option.value, workspace.data?.settings) as Workspace['settings'] });
        await workflow.load('workspace');
      });
    } })) });
  const fleetModel = defaultFleetModel(workspace.data?.settings);

  return <View style={{ flex: 1 }}>
    <Page refreshing={(providers.refreshing || accounts.refreshing) && loaded} onRefresh={refresh}>
      {!loaded && providers.status === 'loading' ? <Loading /> : <StateNotice resource={providers} offline={offline} refresh={refresh} />}
      {loaded && rows.length === 0 ? <EmptyState title="No agents available" detail="Connect an agent in Talyn on the web." /> : null}
      {rows.length ? <Group title="Providers">
        {rows.map((row, index) => <Row key={row.type} title={row.name} subtitle={row.detail} divider={index < rows.length - 1}
          leading={<ToneDot tone={row.tone} />}
          accessibilityLabel={`${row.name}: ${row.detail}`} />)}
      </Group> : null}
      {fleet ? <FleetAccounts accounts={accounts.data} status={accounts.status} fleet={fleet} busy={busy} offline={offline}
        retry={() => { void accounts.refresh(); }} onConnect={setConnect} onAccount={accountMenu} /> : null}
      {loaded && rows.length ? <Group title="Defaults">
        <Row title="New work goes to" divider={Boolean(fleetModel)} onPress={chooseDefault} disabled={busy === 'default' || offline}
          accessibilityLabel={`New work goes to: ${currentLabel}`}
          trailing={<AppText variant="meta" tone="muted" numberOfLines={2} style={{ maxWidth: '55%', textAlign: 'right' }}>{currentLabel}</AppText>} />
        {fleetModel ? <Fact label="Talyn Fleet model" value={fleetModel} divider={false} /> : null}
      </Group> : null}
      <Group footer="Change the Talyn Fleet model in Talyn on the web.">
        <Row title="PostHog Code and Trunk" subtitle="Connect keys and sign in" chevron href="/settings/integrations" divider />
        <WebRow title="Talyn Fleet model" path="/settings/integrations" />
      </Group>
    </Page>
    {menu.sheet}
    <ConnectAgentSheet visible={connect !== null} agent={connect?.agent} accountId={connect?.accountId} add={connect?.add}
      onClose={() => setConnect(null)} onConnected={() => { void changed(); }} />
    <PromptSheet visible={renaming !== null} title="Rename account" label="Account name" initialValue={renaming?.label ?? ''}
      onCancel={() => setRenaming(null)} onSubmit={(label) => {
        const account = renaming;
        setRenaming(null);
        if (!account || label === account.label) return;
        void run(account.id, 'Could not rename the account', () => cloudProviders.fleetAccounts.rename(account.id, label));
      }} />
  </View>;
}

function FleetAccounts({ accounts, status, fleet, busy, offline, retry, onConnect, onAccount }: {
  accounts: FleetAccountsResponse | null | undefined; status: string; fleet: CloudProviderInfo; busy: string | null; offline: boolean;
  retry(): void; onConnect(request: ConnectRequest): void; onAccount(account: FleetAccountView, list: FleetAccountView[], index: number): void;
}) {
  const now = useNow();
  if (accounts === undefined) {
    if (status === 'error') return <Group title="Talyn Fleet accounts"><Row title="Could not load accounts." divider={false}
      trailing={<AppText variant="meta" tone="primary" onPress={retry} accessibilityRole="button">Try again</AppText>} /></Group>;
    return status === 'loading' ? <Loading label="Loading accounts" /> : null;
  }
  return <>{FLEET_AGENTS.map((agent) => {
    const name = agentLabel(agent);
    // An older backend has no account list: say whether the agent is connected, and offer the one sign-in.
    if (accounts === null) {
      const state = agentState(agent, null, fleet);
      return <Group key={agent} title={name}>
        <Row title={state.label} leading={<ToneDot tone={state.tone} />} divider={false}
          trailing={state.connected && !state.reauth ? undefined : <Button size="sm" variant="secondary" disabled={offline}
            title={state.reauth ? 'Reconnect' : 'Connect'} accessibilityLabel={`${state.reauth ? 'Reconnect' : 'Connect'} ${name}`}
            onPress={() => onConnect({ agent })} />} />
      </Group>;
    }
    const list = agentAccounts(accounts.accounts, agent);
    const active = accounts.active[agent];
    return <Group key={agent} title={name}>
      {list.map((account, index) => {
        const badge = accountBadge(account, accounts.switchAtPercent, new Date(now));
        const kind = accountKindLabel(account.kind);
        return <Row key={account.id} title={account.label} leading={<ToneDot tone={badge.tone} />}
          subtitle={`${account.label.toLowerCase() === kind.toLowerCase() ? '' : `${kind} · `}${accountUsageText(account, new Date(now))}`}
          trailing={active === account.id ? <Pill label="Active" /> : undefined} chevron disabled={busy === account.id}
          onPress={() => onAccount(account, list, index)}
          accessibilityLabel={`${account.label}, ${badge.label}${active === account.id ? ', active' : ''}`}>
          {badge.label !== 'Connected' ? <Pill label={badge.label} tone={badge.tone} /> : null}
        </Row>;
      })}
      <Row title={list.length ? `Add another ${name} account` : `Connect ${name}`} divider={false} disabled={offline}
        leading={<PlusIcon />}
        onPress={() => onConnect({ agent, add: true })} />
    </Group>;
  })}</>;
}

function PlusIcon() {
  const c = useTheme();
  return <SymbolView name={{ ios: 'plus', android: 'add' }} size={16} tintColor={c.primaryAction} />;
}

function ToneDot({ tone }: { tone: Tone }) {
  const c = useTheme();
  return <Dot color={toneColor(c, tone)} size={8} />;
}
