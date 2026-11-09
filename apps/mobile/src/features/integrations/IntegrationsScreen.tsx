import { posthog, trunk, workspaces as workspaceApi, type PostHogCodeStatus } from '@talyn/client/native';
import { POSTHOG_CODE_MODELS, type TrunkIntegrationStatus, type Workspace } from '@talyn/shared';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { useMobileRuntime, useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { AppText, Button, Card, EmptyState, Field, Group, Input, Pill, Row, useActionSheet } from '../../components/UI';
import { openExternal, StateNotice } from '../../components/Workflow';
import { errorMessage } from '../../lib/errors';
import { featureOffered, useFeatures } from '../../lib/features';
import { appReturnBase, openReturnFlow } from '../../lib/returnTo';
import { useResource } from '../../workflow/hooks';
import { Intro, Page } from '../more/Page';
import { useRemote, type Remote } from '../more/useRemote';
import {
  type Badge, DEFAULT_POSTHOG_HOST, isHttpsUrl, keyFormOpen, POSTHOG_API_KEYS_URL, POSTHOG_KEY_SCOPE_NOTE, POSTHOG_MODEL_DESCRIPTION, postHogKeyConfig,
  postHogModelLabel, postHogModelOf, postHogOAuthOptions, postHogView, trunkFormOpen, trunkToken, trunkView, withAppReturn,
} from './model';

/** The secret fields: hidden, never corrected, never kept by the keyboard. */
const SECRET = { secureTextEntry: true, autoCapitalize: 'none', autoCorrect: false, spellCheck: false, autoComplete: 'off', textContentType: 'none' } as const;
const PLAIN = { autoCapitalize: 'none', autoCorrect: false, spellCheck: false } as const;

/**
 * Settings → Integrations: PostHog Code and Trunk, like web
 * `IntegrationsSettings`. The Talyn Fleet cards live on the Agents screen, so
 * this one links there.
 */
export function IntegrationsScreen() {
  const workspaceId = useWorkspace().selected;
  const offline = useNetwork() === 'offline';
  const features = useFeatures();
  const trunkOn = featureOffered(features, 'trunkMergeEta');
  const posthogStatus = useRemote<PostHogCodeStatus>(workspaceId ? `posthog-status:${workspaceId}` : null,
    () => posthog.getStatus(workspaceId as string));
  const trunkStatus = useRemote<TrunkIntegrationStatus>(workspaceId && trunkOn ? `trunk-status:${workspaceId}` : null,
    () => trunk.getStatus(workspaceId as string));

  if (!workspaceId) {
    return <Page><EmptyState title="No Workspace Selected" detail="Create or select a workspace to configure settings" /></Page>;
  }
  const refresh = () => { void posthogStatus.refresh(); if (trunkOn) void trunkStatus.refresh(); };
  return <Page refreshing={posthogStatus.refreshing && posthogStatus.data !== undefined} onRefresh={refresh}>
    <Intro>Connect external services to enhance your workflow</Intro>
    <Group title="Agents" footer="Connect Talyn Fleet and choose which agent new work uses.">
      <Row title="Agents" subtitle="Talyn Fleet and the default agent" chevron href="/agents" divider={false} />
    </Group>
    <PostHogCodeCard workspaceId={workspaceId} status={posthogStatus} offline={offline} />
    {trunkOn ? <TrunkCard workspaceId={workspaceId} status={trunkStatus} offline={offline} /> : null}
  </Page>;
}

function CardHeader({ title, badge }: { title: string; badge: Badge | null }) {
  return <View style={styles.header}>
    <AppText accessibilityRole="header" variant="rowTitle" style={{ flex: 1 }}>{title}</AppText>
    {badge ? <Pill label={badge.label} tone={badge.tone} /> : null}
  </View>;
}

function ErrorLine({ message }: { message: string | null }) {
  return message ? <AppText variant="meta" tone="destructive" accessibilityRole="alert">{message}</AppText> : null;
}

/**
 * Two ways to connect, as on web. OAuth when the backend offers it: the user
 * picks the project on PostHog's own page. A personal API key only where OAuth
 * is not configured, or to edit an existing key connection.
 */
export function PostHogCodeCard({ workspaceId, status, offline }: { workspaceId: string; status: Remote<PostHogCodeStatus>; offline: boolean }) {
  const { workflow } = useMobileRuntime();
  const workspace = useResource<Workspace>('workspace');
  const menu = useActionSheet();
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [projectId, setProjectId] = useState('');
  const [host, setHost] = useState(DEFAULT_POSTHOG_HOST);
  const [busy, setBusy] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = status.data;
  const view = postHogView(data);
  const formOpen = keyFormOpen(view, editing);
  const disabled = busy || offline;

  // Seed the form from the status, without overwriting what the person types.
  useEffect(() => {
    if (data?.projectId) setProjectId(data.projectId);
    if (data?.host) setHost(data.host);
  }, [data?.projectId, data?.host]);

  const changed = async () => {
    await Promise.allSettled([status.refresh(), workflow.load('providers'), workflow.load('readiness')]);
  };

  const connectOAuth = async () => {
    setBusy(true);
    setError(null);
    try {
      const { authorizeUrl } = await withAppReturn((returnTo) =>
        posthog.startOAuth(workspaceId, postHogOAuthOptions(host, data?.projectId, returnTo)), appReturnBase());
      if (!isHttpsUrl(authorizeUrl)) throw new Error('The PostHog sign-in address is not valid.');
      await openReturnFlow(authorizeUrl, 'posthog');
    } catch (e) {
      setError(errorMessage(e, 'Failed to start the PostHog connection'));
    } finally {
      await changed();
      setBusy(false);
    }
  };

  const save = async () => {
    const config = postHogKeyConfig({ apiKey, projectId, host });
    if (!config) return;
    setBusy(true);
    setError(null);
    try {
      const next = await posthog.saveConfig(workspaceId, config);
      status.mutate(() => next);
      setApiKey('');
      setEditing(false);
      await changed();
    } catch (e) {
      setError(errorMessage(e, 'Failed to save credentials'));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await posthog.disconnect(workspaceId);
      status.mutate(() => ({ connected: false, oauthAvailable: view.oauthAvailable }));
      setProjectId('');
      setEditing(false);
      await changed();
    } catch (e) {
      setError(errorMessage(e, 'Failed to disconnect'));
    } finally {
      setBusy(false);
    }
  };

  const confirmDisconnect = () => Alert.alert('Disconnect PostHog Code?', 'Cloud tasks stop running on PostHog Code.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Disconnect', style: 'destructive', onPress: () => { void disconnect(); } },
  ]);

  const cancelEdit = () => { setEditing(false); setApiKey(''); setError(null); };

  const currentModel = postHogModelOf(workspace.data?.settings);
  const pickModel = () => menu.open({ title: 'Model', message: POSTHOG_MODEL_DESCRIPTION,
    actions: POSTHOG_CODE_MODELS.map((model) => ({ label: model.label, detail: model.blurb, selected: model.id === currentModel, onPress: () => {
      if (model.id === currentModel) return;
      setSavingModel(true);
      void workspaceApi.update(workspaceId, { settings: { posthogCodeModel: model.id } as Workspace['settings'] })
        .then(() => workflow.load('workspace'))
        .catch((e: unknown) => Alert.alert('Could not save the model', errorMessage(e, 'Please try again.')))
        .finally(() => setSavingModel(false));
    } })) });

  return <>
    <Card>
      <CardHeader title="PostHog Code" badge={data ? view.badge : null} />
      {data === undefined
        ? <StateNotice resource={status} offline={offline} refresh={() => { void status.refresh(); }} />
        : <AppText variant="meta" tone="muted">{view.description}</AppText>}

      {data && !view.connected && view.oauthAvailable && !formOpen ? <>
        <Field label="PostHog host">
          <Input accessibilityLabel="PostHog host" value={host} onChangeText={setHost} placeholder={DEFAULT_POSTHOG_HOST}
            editable={!busy} keyboardType="url" {...PLAIN} />
        </Field>
        <ErrorLine message={error} />
        <Button title="Connect with PostHog" onPress={() => { void connectOAuth(); }} disabled={disabled} loading={busy} />
      </> : null}

      {data && formOpen ? <>
        <Field label="Personal API key">
          <Input accessibilityLabel="Personal API key" value={apiKey} onChangeText={setApiKey} placeholder="phx_..." editable={!busy} {...SECRET} />
        </Field>
        <AppText variant="meta" tone="muted">
          <AppText variant="meta" tone="primary" accessibilityRole="link" onPress={() => openExternal(POSTHOG_API_KEYS_URL)}>Get a key ↗</AppText>
          {`: ${POSTHOG_KEY_SCOPE_NOTE}`}
        </AppText>
        <Field label="Project (team) id">
          <Input accessibilityLabel="Project (team) id" value={projectId} onChangeText={setProjectId} placeholder="e.g. 2" editable={!busy} {...PLAIN} />
        </Field>
        <Field label="Host">
          <Input accessibilityLabel="Host" value={host} onChangeText={setHost} placeholder={DEFAULT_POSTHOG_HOST} editable={!busy}
            keyboardType="url" {...PLAIN} />
        </Field>
        <ErrorLine message={error} />
        <View style={styles.actions}>
          <Button title="Save & verify" onPress={() => { void save(); }} loading={busy}
            disabled={disabled || !postHogKeyConfig({ apiKey, projectId, host })} />
          {view.oauthAvailable ? <Button variant="quiet" title="Connect with PostHog instead" onPress={() => { void connectOAuth(); }} disabled={disabled} /> : null}
          {view.connected || view.oauthAvailable ? <Button variant="quiet" title="Cancel" onPress={cancelEdit} disabled={busy} /> : null}
        </View>
      </> : null}

      {data && view.connected && !formOpen ? <>
        <ErrorLine message={error} />
        <View style={styles.actions}>
          <Button variant={view.needsReauth ? 'primary' : 'secondary'} size="sm" title={view.connectedAction.label} disabled={disabled}
            onPress={() => { if (view.connectedAction.kind === 'edit') setEditing(true); else void connectOAuth(); }} />
          <Button variant="secondary" size="sm" title="Disconnect" accessibilityLabel="Disconnect PostHog Code" disabled={disabled}
            loading={busy} onPress={confirmDisconnect} />
        </View>
      </> : null}
    </Card>
    {data && view.connected ? <Group title="PostHog Code model" footer={POSTHOG_MODEL_DESCRIPTION}>
      <Row title="Model" chevron divider={false} disabled={savingModel || offline} onPress={pickModel}
        accessibilityLabel={`Model. ${postHogModelLabel(currentModel)}.`}
        trailing={<AppText variant="meta" tone="muted">{postHogModelLabel(currentModel)}</AppText>} />
    </Group> : null}
    {menu.sheet}
  </>;
}

/** The workspace's Trunk v2 API key, for merge ETAs. The server never returns the key. */
export function TrunkCard({ workspaceId, status, offline }: { workspaceId: string; status: Remote<TrunkIntegrationStatus>; offline: boolean }) {
  const [token, setToken] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = status.data;
  const view = trunkView(data);
  const formOpen = trunkFormOpen(view, editing);
  const disabled = busy || offline;

  const save = async () => {
    const value = trunkToken(token);
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const next = await trunk.saveToken(workspaceId, value);
      status.mutate(() => next);
      setToken('');
      setEditing(false);
    } catch (e) {
      setError(errorMessage(e, 'Could not save the Trunk API key'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await trunk.removeToken(workspaceId);
      status.mutate(() => next);
      setEditing(false);
    } catch (e) {
      setError(errorMessage(e, 'Could not remove the Trunk API key'));
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = () => Alert.alert('Remove the Trunk API key?', 'Pull requests stop showing merge ETAs.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: () => { void remove(); } },
  ]);

  return <Card>
    <CardHeader title="Trunk merge queue" badge={data ? view.badge : null} />
    {data === undefined
      ? <StateNotice resource={status} offline={offline} refresh={() => { void status.refresh(); }} />
      : <AppText variant="meta" tone="muted">{view.description}</AppText>}
    <ErrorLine message={error} />
    {data && formOpen ? <>
      <Input accessibilityLabel="Trunk API key" value={token} onChangeText={setToken} placeholder="trunk_v2_…" editable={!busy}
        returnKeyType="done" onSubmitEditing={() => { if (!disabled) void save(); }} {...SECRET} />
      <View style={styles.actions}>
        <Button title="Save" accessibilityLabel="Save Trunk API key" onPress={() => { void save(); }} loading={busy}
          disabled={disabled || !trunkToken(token)} />
        {editing ? <Button variant="quiet" title="Cancel" onPress={() => { setEditing(false); setToken(''); }} disabled={busy} /> : null}
      </View>
    </> : null}
    {data && view.connected && !editing ? <View style={styles.actions}>
      <Button variant={view.needsReauth ? 'primary' : 'secondary'} size="sm" title={view.replaceLabel} onPress={() => setEditing(true)} disabled={disabled} />
      <Button variant="secondary" size="sm" title="Remove" accessibilityLabel="Remove the Trunk API key" onPress={confirmRemove}
        disabled={disabled} loading={busy} />
    </View> : null}
  </Card>;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
