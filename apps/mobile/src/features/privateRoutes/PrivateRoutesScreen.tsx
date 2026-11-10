import { ApiError, workspaces } from '@talyn/client/native';
import { privateRoutesOffered, type PrivateConnector, type PrivatePeer, type PrivatePeersResponse, type PrivateRoute } from '@talyn/shared';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo, useState } from 'react';
import { Alert, View } from 'react-native';

import { useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { AppText, Banner, Button, EmptyState, Field, Group, IconButton, Input, Row } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { errorMessage } from '../../lib/errors';
import { useFeatures } from '../../lib/features';
import { Intro, Loading, Page } from '../more/Page';
import { useRemote } from '../more/useRemote';
import { FOOTER, POLL_MS, STATUS_COPY, addRoute, isPolling, mergeConnector, peerHosts, peerMatches, removeRoute, routeLabel } from './model';

const FAILED = 'The private-routes request failed.';

/** Settings → Private routes: a Tailscale connector and the exact TCP destinations a workspace may reach. Mirrors web. */
export function PrivateRoutesScreen() {
  const features = useFeatures();
  const workspaceId = useWorkspace().selected;
  const offline = useNetwork() === 'offline';
  const offered = privateRoutesOffered(features);
  const remote = useRemote<PrivateConnector | null>(offered && workspaceId ? `private-connector:${workspaceId}` : null, async () => {
    try {
      return await workspaces.privateConnector.get(workspaceId as string);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  });
  const connector = remote.data ?? null;
  const polling = isPolling(connector);
  const { refresh } = remote;

  useEffect(() => {
    if (!polling || offline) return undefined;
    const timer = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, offline, refresh]);

  if (!features) return <Page><Loading /></Page>;
  if (!offered) return <Page><EmptyState title="Not available" detail="Private routes are not available for this account." /></Page>;
  if (!workspaceId) return <Page><Intro>Choose a workspace first.</Intro></Page>;
  return <Page refreshing={remote.refreshing} onRefresh={() => { void refresh(); }}>
    <Intro>Add exact private TCP destinations without changing sandbox internet access.</Intro>
    <StateNotice resource={remote} offline={offline} refresh={() => { void refresh(); }} />
    {remote.data !== undefined ? <Body workspaceId={workspaceId} connector={connector} offline={offline} loading={remote.refreshing}
      onConnector={(next) => remote.mutate(() => next)} refresh={refresh} /> : null}
  </Page>;
}

function Body({ workspaceId, connector, offline, loading, onConnector, refresh }: {
  workspaceId: string; connector: PrivateConnector | null; offline: boolean; loading: boolean;
  onConnector(next: PrivateConnector | null): void; refresh(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const connected = connector?.status === 'connected';
  const disabled = busy || offline;
  const status = connector?.status ? STATUS_COPY[connector.status] : null;
  const peers = useRemote<PrivatePeersResponse>(connected ? `peers:${workspaceId}:${connector?.id}` : null, () => workspaces.privateConnector.peers(workspaceId));

  const connect = async () => {
    if (disabled) return;
    setBusy(true);
    setError('');
    try {
      const { loginUrl, ...safe } = await workspaces.privateConnector.start(workspaceId);
      onConnector(safe);
      if (!loginUrl && safe.status !== 'connected') throw new Error('Tailscale did not return a sign-in URL. Try again.');
      if (loginUrl) {
        if (!loginUrl.startsWith('https://')) throw new Error('The Tailscale sign-in address is not valid.');
        await WebBrowser.openBrowserAsync(loginUrl);
        await refresh();
      }
    } catch (err) {
      setError(errorMessage(err, FAILED));
    } finally {
      setBusy(false);
    }
  };

  const replaceRoutes = async (routes: PrivateRoute[]): Promise<boolean> => {
    if (disabled) return false;
    setBusy(true);
    setError('');
    try {
      const updated = await workspaces.privateConnector.replaceRoutes(workspaceId, { routes });
      onConnector(mergeConnector(connector, updated));
      return true;
    } catch (err) {
      setError(errorMessage(err, FAILED));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const result = addRoute(connector?.routes ?? [], host, port);
    if ('error' in result) { setError(result.error); return; }
    if (await replaceRoutes(result.routes)) { setHost(''); setPort(''); }
  };

  const disconnect = async () => {
    setBusy(true);
    setError('');
    try {
      await workspaces.privateConnector.disconnect(workspaceId);
      onConnector(null);
    } catch (err) {
      setError(errorMessage(err, FAILED));
    } finally {
      setBusy(false);
    }
  };

  const confirmDisconnect = () => Alert.alert('Disconnect Tailscale?', 'Sandboxes lose access to every private destination. Talyn reports success only after the connector is removed.', [
    { text: 'Cancel', style: 'cancel', isPreferred: true },
    { text: 'Disconnect', style: 'destructive', onPress: () => { void disconnect(); } },
  ]);

  return <>
    <Group title="Tailscale connector">
      <Row title={status?.label ?? (loading ? 'Checking connection' : 'Not connected')}
        subtitle={status?.detail ?? 'Connect this workspace to a tailnet before you add destinations.'} subtitleLines={4} divider={Boolean(connector)}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {!connector || connector.status === 'needs_login'
            ? <Button title="Connect Tailscale" size="sm" loading={busy} disabled={disabled} onPress={() => { void connect(); }} /> : null}
          {connector ? <Button title="Refresh" size="sm" variant="secondary" disabled={busy} onPress={() => { void refresh(); if (connected) void peers.refresh(); }} /> : null}
        </View>
      </Row>
      {connector ? <Row title="Disconnect" subtitle="Talyn reports success only after the connector is removed." subtitleLines={3} divider={false}>
        <View style={{ marginTop: 8, alignItems: 'flex-start' }}>
          <Button title="Disconnect" size="sm" variant="destructive" disabled={disabled} onPress={confirmDisconnect} />
        </View>
      </Row> : null}
    </Group>
    {connector ? <Intro>Tailscale does not redirect to Talyn. Complete sign-in in the browser, then return here. This page updates automatically.</Intro> : null}

    {connector && connected ? <Group title="Allowed destinations" footer="Each route allows one hostname or IP address and one TCP port.">
      {connector.routes.map((route) => <Row key={routeLabel(route)} title={routeLabel(route)} titleLines={1} trailing={
        <IconButton label={`Remove ${routeLabel(route)}`} symbol={{ ios: 'trash', android: 'delete' }} tone="destructive" disabled={disabled}
          onPress={() => { void replaceRoutes(removeRoute(connector.routes, route)); }} />} />)}
      {connector.routes.length === 0 ? <Row title="No destinations" subtitle="Add the first exact TCP destination below." /> : null}
      <View style={{ padding: 12, gap: 12 }}>
        <Field label="Hostname or IP">
          <Input accessibilityLabel="Hostname or IP" value={host} placeholder="db.corp or 10.0.0.8" autoCapitalize="none" autoCorrect={false}
            onChangeText={(text) => { setHost(text); setError(''); }} />
        </Field>
        <Field label="TCP port">
          <Input accessibilityLabel="TCP port" value={port} placeholder="5432" keyboardType="number-pad" onChangeText={(text) => { setPort(text); setError(''); }} />
        </Field>
        <Button title="Add destination" size="sm" disabled={disabled} onPress={() => { void add(); }} />
      </View>
    </Group> : null}

    {connected ? <Devices peers={peers} onPick={(address) => { setHost(address); setError(''); }} /> : null}

    <AppText variant="meta" tone="muted" style={{ paddingHorizontal: 4 }}>{FOOTER}</AppText>
    {error ? <Banner tone="destructive" message={error} /> : null}
  </>;
}

function Devices({ peers, onPick }: { peers: ReturnType<typeof useRemote<PrivatePeersResponse>>; onPick(address: string): void }) {
  const [query, setQuery] = useState('');
  const list: PrivatePeer[] | null = peers.data?.peers ?? null;
  const visible = useMemo(() => list?.filter((peer) => peerMatches(peer, query)) ?? null, [list, query]);
  return <Group title="Tailnet devices" footer="Devices that the connector can see. Select an address to put it in the hostname field.">
    {list === null && peers.status === 'error' ? <Row title="Devices unavailable" subtitle="Talyn could not read the tailnet. Refresh to try again." /> : null}
    {list === null && peers.status !== 'error' ? <Row title="Loading devices" subtitle="Talyn is reading the tailnet." /> : null}
    {list?.length === 0 ? <Row title="No devices" subtitle="The connector cannot see other devices on this tailnet." /> : null}
    {list && list.length > 0 ? <View style={{ padding: 12 }}>
      <Input accessibilityLabel="Filter tailnet devices" value={query} onChangeText={setQuery} placeholder="Filter by name, address or OS" autoCapitalize="none" autoCorrect={false} />
    </View> : null}
    {list && list.length > 0 && visible?.length === 0 ? <Row title="No matching devices" subtitle={`No device matches "${query.trim()}".`} /> : null}
    {visible?.map((peer) => <Row key={`${peer.name}|${peer.dnsName}|${peer.addresses.join(',')}`}
      title={`${peer.online ? 'Online' : 'Offline'}: ${peer.name}${peer.os ? ` (${peer.os})` : ''}`}
      subtitle={<View style={{ gap: 4, marginTop: 4, alignItems: 'flex-start' }}>
        {peerHosts(peer).map((address) => <Button key={address} title={address} size="sm" variant="secondary" accessibilityLabel={`Use ${address} as the hostname`} onPress={() => onPick(address)} />)}
        {peer.subnetRoutes.length > 0 ? <AppText variant="meta" tone="muted">{`Subnets: ${peer.subnetRoutes.join(', ')}`}</AppText> : null}
      </View>} />)}
  </Group>;
}
