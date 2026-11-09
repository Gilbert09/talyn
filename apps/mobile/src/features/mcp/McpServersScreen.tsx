import { mcpServers } from '@talyn/client/native';
import { mcpServerToInput, mcpServersOffered, mcpToolCountLabel, type McpCatalogEntry, type McpServerDefinition } from '@talyn/shared';
import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { AppText, Button, EmptyState, Group, Input, Pill, SectionLabel, Toggle, useActionSheet, useToast } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { errorMessage } from '../../lib/errors';
import { useFeatures } from '../../lib/features';
import { useTheme } from '../../theme/tokens';
import { Intro, Loading, Page } from '../more/Page';
import { notifyMcpChanged, useMcpServerList } from './data';
import { McpServerLogo } from './McpServerLogo';
import { catalogMatches, connectedHandles, mcpRequest, serverStatus } from './model';

export const MCP_ROUTE = '/settings/mcp';
export const mcpEditorHref = (id: string, catalog?: string) =>
  (catalog ? `${MCP_ROUTE}/${id}?catalog=${encodeURIComponent(catalog)}` : `${MCP_ROUTE}/${id}`) as Href;

/**
 * The workspace's MCP servers, then the catalog. Mirrors web's MCP servers
 * panel: each row leads with whether the server answered, and has its on/off
 * switch. Web's "already on this machine" import reads local files, so it is
 * desktop-only and absent here, as it is on web.
 */
export function McpServersScreen() {
  const workspaceId = useWorkspace().selected ?? null;
  const offline = useNetwork() === 'offline';
  const features = useFeatures();
  const offered = mcpServersOffered(features);
  const list = useMcpServerList(offered ? workspaceId : null);
  const menu = useActionSheet();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  if (features === null) return <Page><Loading /></Page>;
  if (!offered) return <Page><EmptyState title="MCP servers are not available" detail="This account cannot connect MCP servers yet." /></Page>;
  if (!workspaceId) return <Page><EmptyState title="Choose a workspace" detail="MCP servers belong to a workspace." /></Page>;

  const servers = list.data;

  const setEnabled = async (server: McpServerDefinition, enabled: boolean) => {
    // Optimistic, like web: a switch must feel like a switch. A failure reads the list again.
    list.mutate((rows) => rows.map((row) => row.id === server.id ? { ...row, enabled } : row));
    try {
      const next = await mcpServers.update(server.id, mcpRequest({ ...mcpServerToInput(server), enabled }));
      list.mutate((rows) => rows.map((row) => row.id === next.id ? next : row));
    } catch (error) {
      void list.refresh();
      Alert.alert('Could not change that', errorMessage(error, 'Please try again.'));
    }
  };

  const doRemove = async (server: McpServerDefinition) => {
    setBusy(server.id);
    try {
      await mcpServers.remove(server.id);
      list.mutate((rows) => rows.filter((row) => row.id !== server.id));
      notifyMcpChanged();
      toast.show('MCP server removed');
    } catch (error) {
      Alert.alert('Could not remove', errorMessage(error, 'Please try again.'));
    } finally {
      setBusy(null);
    }
  };

  const confirmRemove = (server: McpServerDefinition) => Alert.alert('Remove this MCP server?',
    `Removing ${server.displayName || server.name} also deletes its stored key. Runs already holding it are untouched.`, [
      { text: 'Cancel', style: 'cancel', isPreferred: true },
      { text: 'Remove', style: 'destructive', onPress: () => { void doRemove(server); } },
    ]);

  const openMenu = (server: McpServerDefinition) => menu.open({ title: server.displayName || server.name, message: server.url, actions: [
    { label: 'Edit', onPress: () => router.push(mcpEditorHref(server.id)) },
    { label: server.enabled ? 'Turn off' : 'Turn on', disabled: offline, onPress: () => { void setEnabled(server, !server.enabled); } },
    { label: 'Remove', destructive: true, disabled: offline, onPress: () => confirmRemove(server) },
  ] });

  const connected = connectedHandles(servers ?? []);
  const entries = catalogMatches(query);

  return <View style={{ flex: 1 }}>
    <Page refreshing={list.refreshing} onRefresh={() => { void list.refresh(); }}>
      <Intro>Connect MCP servers to give your agents more tools.</Intro>
      <Button title="Add a server" icon={{ ios: 'plus', android: 'add' }} disabled={offline} onPress={() => router.push(mcpEditorHref('new'))} />
      {servers === undefined ? <StateNotice resource={list} offline={offline} refresh={() => { void list.refresh(); }} /> : <>
        {servers.length > 0 ? <Group title="Servers">
          {servers.map((server, index) => <ServerRow key={server.id} server={server} divider={index < servers.length - 1}
            disabled={offline || busy === server.id} onPress={() => router.push(mcpEditorHref(server.id))}
            onLongPress={() => openMenu(server)} onSetEnabled={(enabled) => { void setEnabled(server, enabled); }} />)}
        </Group> : null}
        <View style={{ gap: 8 }}>
          <SectionLabel title={servers.length === 0 ? 'Connect your first MCP server' : 'Add another'} uppercase={false} />
          <Intro>Pick one to fill in its address, or add any server by hand.</Intro>
          <Input accessibilityLabel="Search MCP servers" placeholder="Search servers…" value={query} onChangeText={setQuery}
            autoCapitalize="none" autoCorrect={false} returnKeyType="search" />
          {entries.length === 0 ? <AppText variant="meta" tone="muted">No servers match your search.</AppText> : <Group>
            {entries.map((entry, index) => <CatalogRow key={entry.handle} entry={entry} already={connected.has(entry.handle)}
              disabled={offline} divider={index < entries.length - 1} onPress={() => router.push(mcpEditorHref('new', entry.handle))} />)}
          </Group>}
        </View>
      </>}
    </Page>
    {menu.sheet}
    {toast.element}
  </View>;
}

function ServerRow({ server, divider, disabled, onPress, onLongPress, onSetEnabled }: {
  server: McpServerDefinition; divider: boolean; disabled: boolean; onPress(): void; onLongPress(): void; onSetEnabled(enabled: boolean): void;
}) {
  const c = useTheme();
  const title = server.displayName || server.name;
  const status = serverStatus(server);
  return <View style={[styles.row, { borderBottomColor: divider ? c.border : 'transparent', opacity: server.enabled ? 1 : 0.6 }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}. ${status?.label ?? mcpToolCountLabel(server)}`}
      accessibilityActions={[{ name: 'longpress', label: 'Show actions' }]}
      onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'longpress') onLongPress(); }}
      onPress={onPress} onLongPress={onLongPress} style={({ pressed }) => [styles.rowMain, pressed && { opacity: 0.7 }]}>
      <McpServerLogo url={server.url} catalogHandle={server.catalogHandle} />
      <View style={styles.text}>
        <AppText variant="rowTitle" numberOfLines={1}>{title}</AppText>
        <AppText variant="meta" tone="muted" numberOfLines={1}>{server.url}</AppText>
        <View style={styles.pills}>
          <Pill label={mcpToolCountLabel(server)} />
          {status ? <Pill label={status.label} tone={status.tone} /> : null}
          {server.enabled ? null : <Pill label="Off" />}
        </View>
        {status?.detail ? <AppText variant="meta" tone="muted" numberOfLines={2}>{status.detail}</AppText> : null}
      </View>
    </Pressable>
    <Toggle accessibilityLabel={`Use ${title}`} value={server.enabled} disabled={disabled} onValueChange={onSetEnabled} />
  </View>;
}

function CatalogRow({ entry, already, disabled, divider, onPress }: {
  entry: McpCatalogEntry; already: boolean; disabled: boolean; divider: boolean; onPress(): void;
}) {
  const c = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={already ? `${entry.title}. Connected` : `Add ${entry.title}`}
    accessibilityHint={entry.summary} accessibilityState={{ disabled: already || disabled }} disabled={already || disabled} onPress={onPress}
    style={({ pressed }) => [styles.row, styles.rowMain, { borderBottomColor: divider ? c.border : 'transparent',
      opacity: already ? 0.5 : pressed ? 0.7 : 1 }]}>
    <McpServerLogo logo={entry.logo} />
    <View style={styles.text}>
      <View style={styles.pills}>
        <AppText variant="rowTitle" numberOfLines={1} style={{ flexShrink: 1 }}>{entry.title}</AppText>
        {already ? <Pill label="Connected" /> : null}
      </View>
      <AppText variant="meta" tone="muted" numberOfLines={2}>{entry.summary}</AppText>
    </View>
  </Pressable>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 12, paddingHorizontal: 4 },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  text: { flex: 1, gap: 4 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
});
