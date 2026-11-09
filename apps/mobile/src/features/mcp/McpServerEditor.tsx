import { mcpServers, type WatchedRepo } from '@talyn/client/native';
import {
  MCP_DISPLAY_NAME_MAX, SLACK_INTERNAL_APP_MANIFEST, mcpCatalogEntry, mcpServerFromCatalog, mcpServerInputProblem, mcpServerNameProblem,
  mcpServersOffered, type McpAuthDiscovery, type McpAuthMethod, type McpProbeResult, type McpServerDefinition, type McpServerInput,
} from '@talyn/shared';
import * as Clipboard from 'expo-clipboard';
import { SymbolView } from 'expo-symbols';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, View } from 'react-native';

import { useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { PickerSheet, type PickerItem } from '../../components/PickerSheet';
import {
  AppText, Button, Card, Disclosure, EmptyState, Field, Group, Input, Notice, Row, SectionHeader, Toggle, useActionSheet, useToast,
} from '../../components/UI';
import { StateNotice, openExternal } from '../../components/Workflow';
import { errorMessage } from '../../lib/errors';
import { useFeatures } from '../../lib/features';
import { openReturnFlow } from '../../lib/returnTo';
import { type, useTheme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import { Loading, Page } from '../more/Page';
import { useUnsavedGuard } from '../settings/editors/useUnsavedGuard';
import { notifyMcpChanged, startSignInWithReturn, useMcpServerList, usePrivateRoutes } from './data';
import {
  AUTH_LABELS, DISCOVERY_DELAY_MS, MANUAL_METHODS, addressEdit, addressProblem, addressHint, allToolsChange, availableMethods,
  credentialStored as storedCredential, discoveredMethod, hostOf, identifierFromTyping, initialEditorInput, isSlackAddress, mcpRequest,
  methodEdit, onlySelectedRepositories, otherNames, probeSummary, sameRequest, scopeSummary, selectedTools, signedInLine, toggleId,
  toggleTool, toolNames, toolRow,
} from './model';
import { runMcpSignIn } from './signIn';

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** The editor route: `id` is a server id, or `new` with an optional catalog handle. */
export function McpServerEditorScreen({ id, catalog }: { id: string; catalog?: string }) {
  const workspaceId = useWorkspace().selected ?? null;
  const offline = useNetwork() === 'offline';
  const features = useFeatures();
  const offered = mcpServersOffered(features);
  const list = useMcpServerList(offered ? workspaceId : null);
  const isNew = id === 'new';
  const initial = useMemo(() => {
    const entry = isNew && catalog ? mcpCatalogEntry(catalog) : undefined;
    return entry ? mcpServerFromCatalog(entry) : undefined;
  }, [isNew, catalog]);

  if (features === null) return <Page><Loading /></Page>;
  if (!offered) return <Page><EmptyState title="MCP servers are not available" detail="This account cannot connect MCP servers yet." /></Page>;
  if (!workspaceId) return <Page><EmptyState title="Choose a workspace" detail="MCP servers belong to a workspace." /></Page>;
  if (list.data === undefined) return <Page><StateNotice resource={list} offline={offline} refresh={() => { void list.refresh(); }} /></Page>;
  const server = isNew ? null : list.data.find((item) => item.id === id) ?? null;
  if (!isNew && !server) return <Page><EmptyState title="This MCP server was removed" detail="Go back to see your MCP servers." /></Page>;
  return <McpServerEditor key={id} workspaceId={workspaceId} servers={list.data} server={server} initial={initial} offline={offline} />;
}

/**
 * The MCP server editor, ported from web's `McpServerEditorPage`: the address
 * first, then authentication, then name, repository access and tools once the
 * server connects. Save probes the server, because the key lives on the
 * server and there is nothing to test until the server exists.
 */
export function McpServerEditor({ workspaceId, servers, server, initial, offline }: {
  workspaceId: string; servers: McpServerDefinition[]; server: McpServerDefinition | null; initial?: McpServerInput; offline: boolean;
}) {
  const [editing, setEditing] = useState<McpServerDefinition | null>(server);
  const existingNames = useMemo(() => otherNames(servers, editing?.id), [servers, editing?.id]);
  const [input, setInput] = useState<McpServerInput>(() => initialEditorInput(server, initial, existingNames));
  const [baseline, setBaseline] = useState<McpServerInput>(input);
  const existingNamesRef = useRef(existingNames);
  existingNamesRef.current = existingNames;
  const savedId = useRef(server?.id);
  const connectionVersion = useRef(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Cleared by the next edit, so the message never stays up while the person fixes it.
  const [submitProblem, setSubmitProblem] = useState<string | null>(null);
  const [probe, setProbe] = useState<McpProbeResult | null>(server?.lastProbe ?? null);
  const [probing, setProbing] = useState(false);
  const privateRoutes = usePrivateRoutes(workspaceId);
  const repositoriesResource = useResource<WatchedRepo[]>('repositories');
  const repositories = useMemo(() => (repositoriesResource.data ?? []).filter((repo) => repo.workspaceId === workspaceId),
    [repositoriesResource.data, workspaceId]);
  const [method, setMethod] = useState<McpAuthMethod>(server?.oauth ? 'oauth' : input.authKind);
  const [discovery, setDiscovery] = useState<McpAuthDiscovery | null>(null);
  const [oauthConnected, setOauthConnected] = useState(server?.oauth?.status === 'connected');
  const [checking, setChecking] = useState(false);
  const [manual, setManual] = useState(false);
  const [picker, setPicker] = useState<'repositories' | 'tools' | null>(null);
  const [pickerQuery, setPickerQuery] = useState('');
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const menu = useActionSheet();
  const toast = useToast();
  const dirty = !sameRequest(input, baseline);
  const guard = useUnsavedGuard(dirty && !saving);

  useEffect(() => {
    let cancelled = false;
    setDiscovery(null);
    setChecking(false);
    if (manual || addressProblem(input.url, privateRoutes)) return undefined;
    if (isSlackAddress(input.url) && !(editingRef.current?.url === input.url && editingRef.current.oauth)) {
      setDiscovery({ methods: ['bearer'], source: 'catalog', credentialLabel: 'Slack User OAuth Token (xoxp-)' });
      setMethod('bearer');
      setInput((prev) => ({ ...prev, authKind: 'bearer', inject: undefined }));
      setBaseline((prev) => ({ ...prev, authKind: 'bearer', inject: undefined }));
      return undefined;
    }
    setChecking(true);
    const timer = setTimeout(() => {
      mcpServers.discoverAuth(workspaceId, input.url)
        .then((result) => {
          if (cancelled) return;
          setDiscovery(result);
          const next = discoveredMethod(result, editingRef.current, input.url);
          if (!next) return;
          setMethod(next.method);
          // Discovery's own change is not an edit, so it does not make the form dirty.
          if (next.patch) {
            setInput((prev) => ({ ...prev, ...next.patch }));
            setBaseline((prev) => ({ ...prev, ...next.patch }));
          }
        })
        .catch(() => {
          if (cancelled) return;
          setDiscovery({ methods: [], source: 'unknown', detail: 'Authentication could not be checked. Use manual setup.' });
        })
        .finally(() => { if (!cancelled) setChecking(false); });
    }, DISCOVERY_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [input.url, workspaceId, manual, privateRoutes]);

  const credentialStored = storedCredential(editing, input);
  const manualFields = manual || discovery?.methods.length === 0;
  const methods = availableMethods(method, discovery);
  const authReady = manual || (!checking && discovery !== null);
  const nameProblem = useMemo(() => mcpServerNameProblem(input.name, existingNames), [input.name, existingNames]);
  const problem = useMemo(() => mcpServerInputProblem(input, privateRoutes) ?? nameProblem, [input, privateRoutes, nameProblem]);
  const catalog = input.catalogHandle ? mcpCatalogEntry(input.catalogHandle) : undefined;
  const connected = probe?.ok === true || oauthConnected;
  const validAddress = !addressProblem(input.url, privateRoutes);
  const hint = addressHint(input.url, privateRoutes);
  const slack = validAddress && isSlackAddress(input.url);

  const edit = useCallback((patch: Partial<McpServerInput>) => {
    if ('secret' in patch || 'inject' in patch || 'url' in patch || 'authKind' in patch) {
      connectionVersion.current += 1;
      setProbe(null);
      setOauthConnected(false);
    }
    setSubmitProblem(null);
    setSaveError(null);
    setInput((prev) => ({ ...prev, ...patch }));
  }, []);

  const chooseMethod = (next: McpAuthMethod) => {
    setProbe(null);
    setMethod(next);
    setOauthConnected(false);
    edit(methodEdit(next, discovery));
  };

  const persist = useCallback(async (body: McpServerInput) => {
    const request = mcpRequest(body);
    const current = editingRef.current;
    const saved = current ? await mcpServers.update(current.id, request) : await mcpServers.create(workspaceId, request);
    savedId.current = saved.id;
    setEditing(saved);
    setBaseline({ ...body, secret: undefined });
    // The key is never kept after it is saved.
    setInput((prev) => prev.url === body.url && prev.secret === body.secret ? { ...prev, secret: undefined } : prev);
    notifyMcpChanged();
    toast.show('MCP server saved');
    return saved;
  }, [workspaceId, toast]);

  const test = useCallback(async (serverId: string) => {
    const result = await mcpServers.test(serverId);
    notifyMcpChanged();
    return result;
  }, []);

  const save = async () => {
    if (problem) { setSubmitProblem(problem); return; }
    const version = connectionVersion.current;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await persist(input);
      if (!connected && method !== 'oauth') {
        const result = await test(saved.id);
        if (version === connectionVersion.current) setProbe(result);
      }
    } catch (error) {
      setSaveError(errorMessage(error, 'Could not save this MCP server'));
    } finally {
      setSaving(false);
    }
  };

  const testNow = async () => {
    if (problem) { setSubmitProblem(problem); return; }
    const version = connectionVersion.current;
    setProbing(true);
    setSaveError(null);
    try {
      const saved = await persist(input);
      const result = await test(saved.id);
      if (version === connectionVersion.current) setProbe(result);
    } catch (error) {
      setSaveError(errorMessage(error, 'Could not reach this MCP server'));
    } finally {
      setProbing(false);
    }
  };

  const loadToolsAfterSignIn = (isConnected: boolean) => {
    setOauthConnected(isConnected);
    if (!isConnected) { setProbe(null); return; }
    if (!savedId.current) return;
    setProbing(true);
    const version = connectionVersion.current;
    void test(savedId.current)
      .then((result) => { if (version === connectionVersion.current) setProbe(result); })
      .catch((error: unknown) => setSaveError(errorMessage(error, 'Could not load tools.')))
      .finally(() => setProbing(false));
  };

  // An OAuth server that is connected but has no probe loads its tools once.
  useEffect(() => {
    if (server?.oauth?.status !== 'connected' || probe || !oauthConnected) return undefined;
    let cancelled = false;
    const version = connectionVersion.current;
    setProbing(true);
    void test(server.id)
      .then((result) => { if (!cancelled && version === connectionVersion.current) setProbe(result); })
      .catch((error: unknown) => { if (!cancelled) setSaveError(errorMessage(error, 'Could not load tools.')); })
      .finally(() => { if (version === connectionVersion.current) setProbing(false); });
    return () => { cancelled = true; };
  }, [server?.id, server?.oauth?.status, oauthConnected, test, probe]);

  const remove = () => {
    const current = editing;
    if (!current) return;
    Alert.alert('Remove this MCP server?',
      `Removing ${current.displayName || current.name} also deletes its stored key. Runs already holding it are untouched.`, [
        { text: 'Cancel', style: 'cancel', isPreferred: true },
        { text: 'Remove', style: 'destructive', onPress: () => {
          void mcpServers.remove(current.id).then(() => {
            notifyMcpChanged();
            guard.leave(() => router.back());
          }).catch((error: unknown) => Alert.alert('Could not remove', errorMessage(error, 'Please try again.')));
        } },
      ]);
  };

  const pickMethod = (choices: readonly McpAuthMethod[]) => menu.open({ title: 'Authentication method',
    actions: choices.map((value) => ({ label: AUTH_LABELS[value], selected: value === method, onPress: () => chooseMethod(value) })) });

  const allowedTools = input.tools ?? null;
  const allowedRepositories = input.repositoryIds ?? null;
  const offeredTools = probe?.toolNames ?? [];
  const names = toolNames(offeredTools, allowedTools);
  const title = input.displayName?.trim() || input.name.trim() || (editing ? 'MCP server' : 'New MCP server');
  const writeDisabled = offline || saving || probing;
  const signInServer = editing?.url === input.url && input.secret === undefined ? editing : null;

  const search = pickerQuery.trim().toLowerCase();
  const repositoryItems: PickerItem[] = repositories
    .filter((repo) => repo.fullName.toLowerCase().includes(search))
    .map((repo) => ({ key: repo.id, label: repo.fullName, mono: true, selected: (allowedRepositories ?? []).includes(repo.id),
      onPress: () => edit({ repositoryIds: toggleId(allowedRepositories ?? [], repo.id) }) }));
  const toolItems: PickerItem[] = names
    .map((name) => ({ name, ...toolRow(name, offeredTools, probe?.tools) }))
    .filter((tool) => `${tool.name} ${tool.label}`.toLowerCase().includes(search))
    .map((tool) => ({ key: tool.name, label: tool.label, detail: tool.detail, selected: selectedTools(allowedTools, offeredTools).includes(tool.name),
      accessibilityLabel: `Enable ${tool.name}`, onPress: () => edit({ tools: toggleTool(allowedTools, offeredTools, tool.name) }) }));
  const openPicker = (kind: 'repositories' | 'tools') => { setPickerQuery(''); setPicker(kind); };

  return <View style={{ flex: 1 }}>
    <Page>
      <AppText accessibilityRole="header" variant="title" numberOfLines={2}>{title}</AppText>

      {saveError ?? submitProblem ? <Notice alert tone="destructive" message={(saveError ?? submitProblem) as string} /> : null}
      {probe && (!probe.ok || probe.detail || !oauthConnected)
        ? <Notice alert={!probe.ok} tone={probe.ok ? 'success' : 'destructive'} message={probeSummary(probe)} /> : null}

      {editing ? <Group>
        <Row title="On" divider={false} subtitle="Agents can use this server when it is on."
          trailing={<Toggle accessibilityLabel="On" value={input.enabled !== false} disabled={offline}
            onValueChange={(value) => edit({ enabled: value })} />} />
      </Group> : null}

      {!catalog && !connected ? <Card>
        <SectionHeader title="MCP server address" detail="Paste the address. Talyn fills in the connection settings." />
        <Input accessibilityLabel="MCP server address" value={input.url} placeholder="https://mcp.linear.app/mcp"
          autoCapitalize="none" autoCorrect={false} keyboardType="url" textContentType="URL" editable={!offline}
          onChangeText={(url) => {
            setManual(false);
            setDiscovery(null);
            setMethod('bearer');
            setOauthConnected(false);
            setProbe(null);
            edit(addressEdit(url, existingNamesRef.current));
          }} />
        {hint ? <AppText accessibilityRole="alert" variant="meta" tone="destructive">{hint}</AppText> : null}
      </Card> : null}

      {slack && !connected && method === 'bearer' ? <Card>
        <SectionHeader title="Connect your own Slack app" detail="Create an internal app in the Slack workspace you want to connect." />
        <AppText variant="meta">1. Open Slack apps and select Create New App → From a manifest.</AppText>
        <View style={{ alignSelf: 'flex-start' }}>
          <Button variant="quiet" size="sm" title="Open Slack apps" onPress={() => openExternal('https://api.slack.com/apps')} />
        </View>
        <AppText variant="meta">2. Select your workspace. Copy the manifest below into Slack, then create the app.</AppText>
        <AppText variant="meta">3. Open Agents {'&'} AI Apps. Enable Model Context Protocol. PKCE is already enabled in the manifest.</AppText>
        <AppText variant="meta">4. Under OAuth {'&'} Permissions, install the app to your workspace. Your administrator may need to approve it.</AppText>
        <AppText variant="meta">5. Copy the User OAuth Token (xoxp-) and paste it below. Keep public distribution off.</AppText>
        <Disclosure title="App manifest">
          <AppText selectable style={type.mono}>{JSON.stringify(SLACK_INTERNAL_APP_MANIFEST, null, 2)}</AppText>
          <View style={{ alignSelf: 'flex-start' }}>
            <Button variant="secondary" size="sm" title="Copy manifest" onPress={() => {
              void Clipboard.setStringAsync(JSON.stringify(SLACK_INTERNAL_APP_MANIFEST, null, 2)).then(() => toast.show('Copied'));
            }} />
          </View>
        </Disclosure>
        <AppText variant="meta" tone="muted">The manifest requests access for all Slack tools. Review these permissions before installation. Each user must supply their own user token. If it expires or is revoked, replace it here.</AppText>
      </Card> : null}

      {validAddress && !connected && !(slack && method === 'bearer' && !manual) ? <Card>
        <SectionHeader title="Authentication" detail="Talyn checks the server address to find its authentication options." />
        {checking ? <Notice loading message="Checking authentication…" /> : null}
        {discovery?.detail ? <AppText variant="meta" tone="muted">{discovery.detail}</AppText> : null}
        {!checking && !authReady ? <AppText variant="meta" tone="muted">Enter a valid server address.</AppText> : null}
        {authReady && !manualFields ? methods.length > 1
          ? <Row title="Authentication method" divider={false} chevron disabled={offline} onPress={() => pickMethod(methods)}
            accessibilityLabel={`Authentication method. ${AUTH_LABELS[method]}.`}
            trailing={<AppText variant="meta" tone="muted">{AUTH_LABELS[method]}</AppText>} />
          : <AppText>{AUTH_LABELS[method]}</AppText> : null}
        <View style={{ alignSelf: 'flex-start' }}>
          <Button variant="quiet" size="sm" title={manual ? 'Detect authentication' : 'Set up manually'} onPress={() => setManual(!manual)} />
        </View>
      </Card> : null}

      {validAddress && (authReady || oauthConnected) && method === 'oauth' ? <SignIn server={signInServer} offline={offline}
        onStatusChange={loadToolsAfterSignIn} onServer={setEditing}
        prepare={async () => {
          if (problem) { setSubmitProblem(problem); throw new Error(problem); }
          return persist({ ...input, authKind: 'bearer', inject: undefined });
        }} /> : null}

      {validAddress && !connected && authReady && (method !== 'oauth' || manualFields) ? <Card>
        <SectionHeader title="Credential" detail={credentialStored
          ? 'A key is stored. Leave this blank to keep it, or type a new one to replace it.'
          : (discovery?.credentialLabel ?? catalog?.credentialLabel ?? 'Enter the credential required by this server.')} />
        {manualFields ? <Row title="Authentication method" divider={false} chevron disabled={offline} onPress={() => pickMethod(MANUAL_METHODS)}
          accessibilityLabel={`Authentication method. ${AUTH_LABELS[method]}.`}
          trailing={<AppText variant="meta" tone="muted">{AUTH_LABELS[method]}</AppText>} /> : null}
        {input.authKind === 'header' && (manualFields || !discovery?.inject?.header)
          ? <Input accessibilityLabel="Header name" value={input.inject?.header ?? ''} placeholder="X-Api-Key" autoCapitalize="none" autoCorrect={false}
            editable={!offline} onChangeText={(header) => edit({ inject: { ...input.inject, header } })} /> : null}
        {input.authKind === 'basic'
          ? <Input accessibilityLabel="Username" value={input.inject?.user ?? ''} placeholder="Username" autoCapitalize="none" autoCorrect={false}
            editable={!offline} onChangeText={(user) => edit({ inject: { ...input.inject, user } })} /> : null}
        {input.authKind === 'query'
          ? <Input accessibilityLabel="Parameter name" value={input.inject?.param ?? ''} placeholder="api_key" autoCapitalize="none" autoCorrect={false}
            editable={!offline} onChangeText={(param) => edit({ inject: { ...input.inject, param } })} /> : null}
        {method !== 'none' && method !== 'oauth'
          ? <Input accessibilityLabel="Key" secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="none"
            value={input.secret ?? ''} placeholder={credentialStored ? '••••••••  (unchanged)' : 'Paste the key'} editable={!offline}
            onChangeText={(secret) => edit({ secret })} /> : null}
        <AppText variant="meta" tone="muted">{method === 'none'
          ? 'No credential is needed for this connection.'
          : 'Credentials are stored encrypted. The sandbox does not receive them.'}</AppText>
      </Card> : null}

      {editing || connected ? <Card>
        <SectionHeader title="Name" detail="Give this server a name that is easy to read. Agents use the identifier to reach it." />
        <Field label="Display name">
          <Input accessibilityLabel="Display name" value={input.displayName ?? ''} maxLength={MCP_DISPLAY_NAME_MAX}
            placeholder={probe?.serverName || hostOf(input.url)} editable={!offline} onChangeText={(displayName) => edit({ displayName })} />
        </Field>
        <Field label="Identifier">
          <Input accessibilityLabel="Identifier" value={input.name} maxLength={40} autoCapitalize="none" autoCorrect={false} spellCheck={false}
            style={type.mono} editable={!offline} onChangeText={(name) => edit({ name: identifierFromTyping(name) })} />
        </Field>
        {nameProblem ? <AppText accessibilityRole="alert" variant="meta" tone="destructive">{nameProblem}</AppText>
          : <AppText variant="meta" tone="muted">Lowercase letters, digits and hyphens.
            {editing !== null && editing.name !== input.name.trim().toLowerCase()
              ? ' Sessions that are running keep the old identifier until their sandbox restarts.' : ''}</AppText>}
      </Card> : null}

      {editing || connected ? <Group title="Repository access" footer="Allow this server in every repository, or limit it to selected repositories.">
        <Row title="All repositories" subtitle="This includes repositories that you add later." selected={allowedRepositories === null}
          accessibilityLabel="All repositories" disabled={offline} onPress={() => edit({ repositoryIds: null })}
          trailing={allowedRepositories === null ? <Check /> : null} />
        <Row title="Only selected repositories" selected={allowedRepositories !== null} divider={allowedRepositories !== null}
          accessibilityLabel="Only selected repositories" disabled={offline}
          onPress={() => { if (allowedRepositories === null) edit({ repositoryIds: onlySelectedRepositories(repositories) }); }}
          trailing={allowedRepositories !== null ? <Check /> : null} />
        {allowedRepositories !== null ? repositories.length === 0
          ? <Row title="This workspace has no repositories." divider={false} />
          : <Row title="Repositories" chevron divider={false} disabled={offline} onPress={() => openPicker('repositories')}
            accessibilityLabel={`Repositories. ${scopeSummary(allowedRepositories, repositories.length, 'repositories')}.`}
            trailing={<AppText variant="meta" tone="muted">{scopeSummary(allowedRepositories, repositories.length, 'repositories')}</AppText>} /> : null}
      </Group> : null}
      {(editing || connected) && allowedRepositories !== null && allowedRepositories.length === 0
        ? <AppText variant="meta" tone="warning">No repository can access this server.</AppText> : null}

      {connected ? <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}><SectionHeader title="Tools" detail="Choose which tools your agents can use." /></View>
          <Button variant="quiet" size="sm" title={offeredTools.length > 0 ? 'Refresh' : 'Load tools'} loading={probing}
            disabled={writeDisabled || !authReady || (method === 'oauth' && !oauthConnected)} onPress={() => { void testNow(); }} />
        </View>
        {names.length === 0 ? <AppText variant="meta" tone="muted">{probe
          ? 'This server offered no tools.' : 'Test the connection to see which tools this server offers.'}</AppText> : <>
          <Row title="All tools" subtitle="Including any this server adds later." divider
            trailing={<Toggle accessibilityLabel="All tools" value={allowedTools === null} disabled={offline}
              onValueChange={(checked) => edit({ tools: allToolsChange(checked, offeredTools) })} />} />
          <Row title="Choose tools" chevron divider={false} disabled={offline} onPress={() => openPicker('tools')}
            accessibilityLabel={`Choose tools. ${selectedTools(allowedTools, offeredTools).length} of ${names.length} on.`}
            trailing={<AppText variant="meta" tone="muted">{`${selectedTools(allowedTools, offeredTools).length} of ${names.length} on`}</AppText>} />
          {allowedTools !== null && allowedTools.length === 0
            ? <AppText variant="meta" tone="warning">Nothing is ticked, so this server will be connected with no tools at all.</AppText> : null}
        </>}
      </Card> : null}

      <View style={{ gap: 8 }}>
        {validAddress && (method !== 'oauth' || connected)
          ? <Button title={saving ? 'Connecting…' : connected ? 'Save' : 'Connect'} loading={saving}
            disabled={writeDisabled || !authReady} onPress={() => { void save(); }} /> : null}
        {connected ? <Button variant="secondary" title={probing ? 'Testing...' : 'Test'} loading={probing}
          disabled={writeDisabled || !authReady || (method === 'oauth' && !oauthConnected)} onPress={() => { void testNow(); }} /> : null}
        {editing ? <Button variant="quiet" title="Remove server" disabled={offline || saving} onPress={remove} /> : null}
      </View>
    </Page>
    <PickerSheet visible={picker !== null} closeOnSelect={false} onClose={() => setPicker(null)}
      title={picker === 'tools' ? 'Tools' : 'Repositories'}
      search={{ value: pickerQuery, onChange: setPickerQuery, placeholder: picker === 'tools' ? 'Search tools' : 'Search repositories' }}
      sections={[{ key: picker ?? 'none', items: picker === 'tools' ? toolItems : repositoryItems }]}
      empty={<AppText variant="meta" tone="muted" style={{ padding: 16 }}>Nothing matches your search.</AppText>} />
    {menu.sheet}
    {toast.element}
  </View>;
}

function Check() {
  const c = useTheme();
  return <SymbolView name={{ ios: 'checkmark', android: 'check' }} size={16} tintColor={c.primaryAction} />;
}

/** The OAuth sign-in, as web's `SignIn`: save, open the browser, poll the flow, then load tools. */
function SignIn({ server, prepare, onStatusChange, onServer, offline }: {
  server: McpServerDefinition | null; prepare(): Promise<McpServerDefinition>; onStatusChange(connected: boolean): void;
  onServer(server: McpServerDefinition): void; offline: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState(server?.oauth ?? null);
  const [serverId, setServerId] = useState(server?.id);
  const [account, setAccount] = useState<{ name?: string; email?: string; workspace?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const attempt = useRef(0);

  useEffect(() => {
    setAccount(null);
    if (grant?.status !== 'connected' || !serverId) return undefined;
    let cancelled = false;
    void mcpServers.account(serverId).then((value) => { if (!cancelled) setAccount(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [grant?.status, serverId]);
  useEffect(() => { setGrant(server?.oauth ?? null); }, [server?.oauth]);
  useEffect(() => () => { attempt.current += 1; }, []);

  const start = async () => {
    const current = ++attempt.current;
    const alive = () => current === attempt.current;
    setBusy(true);
    setError(null);
    setAuthorizeUrl(null);
    try {
      const saved = await prepare();
      setServerId(saved.id);
      if (!alive()) return;
      const result = await runMcpSignIn({
        start: () => startSignInWithReturn(saved.id),
        open: (url) => openReturnFlow(url, 'mcp'),
        status: (flowId) => mcpServers.signInStatus(saved.id, flowId),
        sleep,
        now: Date.now,
        alive,
        onBrowserClosed: (url) => { if (alive()) setAuthorizeUrl(url); },
      });
      notifyMcpChanged();
      if (!alive()) return;
      if (result.outcome === 'connected') {
        setGrant({ status: 'connected' });
        onStatusChange(true);
        void mcpServers.get(saved.id).then((next) => { if (alive()) onServer(next); }).catch(() => undefined);
      } else if (result.outcome === 'error') {
        setError(result.detail);
      } else if (result.outcome === 'timeout') {
        setError('Sign-in took too long. Try again.');
      }
    } catch (err) {
      if (alive()) setError(errorMessage(err, 'Could not start sign-in.'));
    } finally {
      if (alive()) {
        setBusy(false);
        setAuthorizeUrl(null);
      }
    }
  };

  const stop = () => {
    attempt.current += 1;
    setBusy(false);
    setAuthorizeUrl(null);
  };

  const disconnect = async () => {
    if (!server) return;
    setError(null);
    setBusy(true);
    try {
      const next = await mcpServers.disconnect(server.id);
      setGrant(next.oauth ?? null);
      onServer(next);
      notifyMcpChanged();
      onStatusChange(false);
    } catch (err) {
      setError(errorMessage(err, 'Could not disconnect.'));
    } finally {
      setBusy(false);
    }
  };

  const isConnected = grant?.status === 'connected';
  return <Card>
    <SectionHeader title={isConnected ? 'Connected account' : 'Sign in'} detail={isConnected ? undefined : 'Connect your account in your browser.'} />
    {isConnected ? <>
      <AppText tone="success">{signedInLine(account)}</AppText>
      {account?.workspace ? <AppText variant="meta" tone="muted">Workspace: {account.workspace}</AppText> : null}
      <View style={{ alignSelf: 'flex-start' }}>
        <Button variant="secondary" size="sm" title="Disconnect" disabled={busy || offline} onPress={() => { void disconnect(); }} />
      </View>
    </> : <View style={{ gap: 8 }}>
      <Button variant="secondary" title={busy ? 'Waiting for sign-in…' : 'Connect account'} loading={busy}
        disabled={busy || offline} onPress={() => { void start(); }} />
      {authorizeUrl ? <Button title="Continue in browser" onPress={() => { void openReturnFlow(authorizeUrl, 'mcp'); }} /> : null}
      {busy ? <Button variant="quiet" size="sm" title="Stop waiting" onPress={stop} /> : null}
    </View>}
    {grant?.status === 'needs_reauth' && grant.detail ? <AppText variant="meta" tone="warning">{grant.detail}</AppText> : null}
    {error ? <AppText accessibilityRole="alert" variant="meta" tone="destructive">{error}</AppText> : null}
  </Card>;
}
