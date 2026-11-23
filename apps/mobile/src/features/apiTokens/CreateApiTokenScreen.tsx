import { apiTokens } from '@talyn/client/native';
import { API_TOKEN_NAME_MAX } from '@talyn/shared';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { AppText, Banner, Button, EmptyState, Field, Group, Input, Row, SectionLabel, Segmented, useActionSheet, useToast } from '../../components/UI';
import { errorMessage } from '../../lib/errors';
import { useFeatures } from '../../lib/features';
import { radius, useTheme } from '../../theme/tokens';
import { Loading, Page } from '../more/Page';
import { useUnsavedGuard } from '../settings/editors/useUnsavedGuard';
import { spacesOffered } from '../spaces/model';
import {
  ALL_WORKSPACES, DEFAULT_EXPIRY, EXPIRY_OPTIONS, LEVEL_LABELS, NO_EXPIRY, accessHint, canCreate, createRequest, curlExample, fullAccessLevels,
  levelsFor, readOnlyLevels, resourcesFor, scopesFor, workspaceLabel, type Levels, type TokenDraft,
} from './model';

/**
 * Create a personal API token, then show it once. Mirrors web's create
 * dialog: the same fields, the same request, and the plaintext only on this
 * screen. Leaving the screen drops it.
 */
export function CreateApiTokenScreen() {
  const features = useFeatures();
  if (features === null) return <Page><Loading /></Page>;
  if (features.publicApi !== true) {
    return <Page><EmptyState title="You cannot create new tokens right now" detail="You can still revoke the tokens you have." /></Page>;
  }
  return <CreateTokenForm offered={spacesOffered(features)} />;
}

function CreateTokenForm({ offered }: { offered: boolean }) {
  const router = useRouter();
  const offline = useNetwork() === 'offline';
  const workspaces = useWorkspace().choices;
  const sheet = useActionSheet();
  const toast = useToast();
  const [draft, setDraft] = useState<TokenDraft>(() => ({ name: '', expiry: DEFAULT_EXPIRY, workspaceId: ALL_WORKSPACES, levels: readOnlyLevels(offered) }));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ token: string; name: string } | null>(null);
  const dirty = draft.name.trim().length > 0 || draft.expiry !== DEFAULT_EXPIRY || draft.workspaceId !== ALL_WORKSPACES
    || JSON.stringify(draft.levels) !== JSON.stringify(readOnlyLevels(offered));
  const guard = useUnsavedGuard(secret !== null || dirty,
    secret ? "You won't see this token again. Copy it before you leave." : 'Your new token is not created.',
    secret ? 'Leave without copying?' : undefined);

  const update = (patch: Partial<TokenDraft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const setLevel = (key: keyof Levels, level: Levels[keyof Levels]) => setDraft((prev) => ({ ...prev, levels: { ...prev.levels, [key]: level } }));
  const scopes = scopesFor(draft.levels, offered);
  const ready = canCreate(draft, offered, creating) && !offline;

  const submit = async () => {
    if (!ready) return;
    setCreating(true);
    setError(null);
    try {
      const response = await apiTokens.create(createRequest(draft, offered));
      setSecret({ token: response.token, name: draft.name.trim() });
    } catch (failure) {
      setError(errorMessage(failure, 'Could not create the token'));
    } finally {
      setCreating(false);
    }
  };

  const copy = async (text: string, label: string) => {
    try {
      await Clipboard.setStringAsync(text);
      toast.show(`${label} copied`);
    } catch {
      Alert.alert('Could not copy to clipboard');
    }
  };

  if (secret) {
    return <>
      <Page>
        <AppText variant="heading" accessibilityRole="header">Copy your new token</AppText>
        <AppText variant="meta" tone="muted">"{secret.name}" is ready to use.</AppText>
        <Banner message="You won't see this token again. Copy it now and keep it somewhere safe." />
        <Field label="Token">
          <Secret text={secret.token} />
          <Button title="Copy" accessibilityLabel="Copy token" variant="secondary" size="sm" icon={{ ios: 'doc.on.doc', android: 'content_copy' }}
            onPress={() => { void copy(secret.token, 'Token'); }} />
        </Field>
        <Field label="Try it">
          <Secret text={curlExample(secret.token)} />
          <Button title="Copy" accessibilityLabel="Copy curl command" variant="secondary" size="sm" icon={{ ios: 'doc.on.doc', android: 'content_copy' }}
            onPress={() => { void copy(curlExample(secret.token), 'Command'); }} />
        </Field>
        <Button title="Done" onPress={() => guard.leave(() => router.back())} />
      </Page>
      {toast.element}
    </>;
  }

  const chooseWorkspace = () => sheet.open({ title: 'Workspace', actions: [
    { label: 'All workspaces', selected: draft.workspaceId === ALL_WORKSPACES, onPress: () => update({ workspaceId: ALL_WORKSPACES }) },
    ...workspaces.map((workspace) => ({ label: workspace.name, selected: draft.workspaceId === workspace.id, onPress: () => update({ workspaceId: workspace.id }) })),
  ] });
  const workspaceText = draft.workspaceId === ALL_WORKSPACES ? 'All workspaces' : workspaceLabel([draft.workspaceId], workspaces);

  return <>
    <Page>
      <AppText variant="meta" tone="muted">Give the token only the access your script needs.</AppText>
      {offline ? <Banner message="You are offline. Connect to the internet to create a token." /> : null}
      <Field label="Name">
        <Input accessibilityLabel="Name" placeholder="For example, CI script" value={draft.name} maxLength={API_TOKEN_NAME_MAX}
          autoCorrect={false} returnKeyType="done" onChangeText={(name) => update({ name })} />
      </Field>
      <Field label="Expires after">
        <Segmented accessibilityLabel="Expires after" options={EXPIRY_OPTIONS} value={draft.expiry} onChange={(expiry) => update({ expiry })} />
        {draft.expiry === NO_EXPIRY ? <AppText variant="meta" tone="warning">A token with no expiry stays valid until you revoke it.</AppText> : null}
      </Field>
      <Group>
        <Row title="Workspace" chevron divider={false} onPress={chooseWorkspace} accessibilityLabel={`Workspace: ${workspaceText}. Change`}
          trailing={<AppText variant="meta" tone="muted" numberOfLines={1} style={{ maxWidth: '60%' }}>{workspaceText}</AppText>} />
      </Group>
      <View style={{ gap: 6 }}>
        <SectionLabel title="Access" trailing={<View style={styles.presets}>
          <Button title="Read only" variant="quiet" size="sm" onPress={() => update({ levels: readOnlyLevels(offered) })} />
          <Button title="Full access" variant="quiet" size="sm" onPress={() => update({ levels: fullAccessLevels(offered) })} />
        </View>} />
        <AccessList offered={offered} levels={draft.levels} onChange={setLevel} />
        {scopes.length === 0 ? <AppText variant="meta" tone="muted" style={{ paddingHorizontal: 4 }}>Give the token access to at least one thing.</AppText> : null}
      </View>
      {error ? <Banner tone="destructive" message={error} /> : null}
      <Button title="Create token" disabled={!ready} loading={creating} onPress={() => { void submit(); }} />
    </Page>
    {sheet.sheet}
  </>;
}

function AccessList({ offered, levels, onChange }: { offered: boolean; levels: Levels; onChange(key: keyof Levels, level: Levels[keyof Levels]): void }) {
  const c = useTheme();
  const resources = resourcesFor(offered);
  return <View style={[styles.access, { backgroundColor: c.paper, borderColor: c.border }]}>
    {resources.map(({ key, label }, index) => <View key={key} style={[styles.resource,
      index < resources.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }]}>
      <AppText variant="rowTitle">{label}</AppText>
      <AppText variant="meta" tone="muted">{accessHint(key, levels[key])}</AppText>
      <Segmented accessibilityLabel={`${label} access`} value={levels[key]} onChange={(level) => onChange(key, level)}
        options={levelsFor(key).map((level) => ({ value: level, label: LEVEL_LABELS[level] }))} />
    </View>)}
  </View>;
}

function Secret({ text }: { text: string }) {
  const c = useTheme();
  return <View style={[styles.secret, { backgroundColor: c.surface }]}>
    <AppText variant="mono" selectable>{text}</AppText>
  </View>;
}

const styles = StyleSheet.create({
  presets: { flexDirection: 'row', alignItems: 'center' },
  access: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, paddingHorizontal: 12, overflow: 'hidden' },
  resource: { gap: 6, paddingVertical: 12, paddingHorizontal: 4 },
  secret: { borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8 },
});
