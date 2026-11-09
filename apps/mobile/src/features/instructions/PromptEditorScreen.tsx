import { workspaces, type PRRow } from '@talyn/client/native';
import {
  DEFAULT_PROMPT_TEMPLATES, PROMPT_KIND_INFO, defaultPromptTemplateHash, promptTemplateOverride,
  type CloudProviderType, type PromptKind, type PromptVariableSpec, type Workspace,
} from '@talyn/shared';
import { useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, View } from 'react-native';

import { useMobileRuntime, useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { PickerSheet } from '../../components/PickerSheet';
import { AppText, Banner, BottomBar, Button, Card, EmptyState, Group, Pill, Row, Segmented } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { errorMessage } from '../../lib/errors';
import { useResource } from '../../workflow/hooks';
import { Intro, Page } from '../more/Page';
import { TextArea } from '../settings/editors/TextArea';
import { useUnsavedGuard } from '../settings/editors/useUnsavedGuard';
import {
  PREVIEW_PROVIDERS, STALE_DEFAULT_DETAIL, initialPromptDraft, insertVariableAt, isPromptKind, previewNote, previewRowLabel,
  promptEditorState, promptOverride, promptSettingsPatch, renderPromptPreview, variableGroups, type PromptDraft,
} from './model';

type Tab = 'edit' | 'preview' | 'default';
const TABS: ReadonlyArray<{ value: Tab; label: string }> = [{ value: 'edit', label: 'Edit' }, { value: 'preview', label: 'Preview' }, { value: 'default', label: 'Default' }];

/** One prompt template of the workspace, like web's `PromptTemplateEditor` dialog. */
export function PromptEditorScreen({ kind }: { kind: string | undefined }) {
  const offline = useNetwork() === 'offline';
  const workspace = useResource<Workspace>('workspace');
  if (!isPromptKind(kind)) return <Page><EmptyState title="This prompt does not exist" /></Page>;
  if (!workspace.data) return <Page><StateNotice resource={workspace} offline={offline} refresh={() => { void workspace.refresh(); }} /></Page>;
  return <PromptEditor key={kind} kind={kind} workspace={workspace.data} offline={offline} />;
}

function PromptEditor({ kind, workspace, offline }: { kind: PromptKind; workspace: Workspace; offline: boolean }) {
  const router = useRouter();
  const { workflow } = useMobileRuntime();
  const workspaceId = useWorkspace().selected ?? workspace.id;
  const info = PROMPT_KIND_INFO[kind];
  const override = promptTemplateOverride(workspace.settings, kind);
  const [draft, setDraft] = useState<PromptDraft>(() => initialPromptDraft(kind, override));
  const [tab, setTab] = useState<Tab>('edit');
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);
  const selection = useRef({ start: draft.template.length, end: draft.template.length });
  const state = useMemo(() => promptEditorState(kind, override, draft), [kind, override, draft]);
  const groups = useMemo(() => variableGroups(kind), [kind]);
  const { leave } = useUnsavedGuard(state.dirty);
  const defaultTemplate = DEFAULT_PROMPT_TEMPLATES[kind];

  const write = async (action: 'save' | 'reset') => {
    setBusy(action);
    try {
      await workspaces.update(workspaceId, promptSettingsPatch(kind, action === 'save' ? promptOverride(draft) : null));
      await workflow.load('workspace').catch(() => undefined);
      leave(() => router.back());
    } catch (error) {
      Alert.alert(action === 'save' ? 'Could not save the prompt' : 'Could not reset the prompt', errorMessage(error, 'Please try again.'));
    } finally {
      setBusy(null);
    }
  };
  const reset = () => Alert.alert(`Reset ${info.label}?`, "The workspace goes back to Talyn's default for this prompt.", [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Reset', style: 'destructive', onPress: () => { void write('reset'); } },
  ]);

  const insert = (spec: PromptVariableSpec) => {
    const { start, end } = selection.current;
    const result = insertVariableAt(draft.template, start, end, spec);
    selection.current = { start: result.caret, end: result.caret };
    setDraft((prev) => ({ ...prev, template: result.text }));
    setTab('edit');
  };
  const disabled = busy !== null || offline;

  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={100}>
    <Page>
      <Intro>{`Replaces Talyn's default for this workspace. ${info.usedFor}`}</Intro>
      {state.staleDefault ? <Banner message={STALE_DEFAULT_DETAIL} action="Dismiss"
        onAction={() => setDraft((prev) => ({ ...prev, basedOnHash: defaultPromptTemplateHash(kind) }))} /> : null}
      <Segmented<Tab> accessibilityLabel="Prompt view" options={TABS} value={tab} onChange={setTab} />

      {tab === 'edit' ? <>
        <View style={{ gap: 6 }}>
          <AppText variant="meta" tone="muted" style={{ textAlign: 'right' }}>{state.chars}</AppText>
          <TextArea code accessibilityLabel={`${info.label} prompt`} value={draft.template} editable={busy === null} minHeight={320}
            onChangeText={(template) => setDraft((prev) => ({ ...prev, template }))}
            onSelectionChange={(event) => { selection.current = event.nativeEvent.selection; }} />
          {state.validation.errors.length > 0
            ? state.validation.errors.map((error) => <AppText key={error} variant="meta" tone="destructive">{error}</AppText>)
            : <AppText variant="meta" tone="success">Ready to save.</AppText>}
        </View>
        <Intro>Tap a variable to insert it at the cursor. Blocks go on their own line.</Intro>
        {groups.map(({ group, label, items }) => <Group key={group} title={label}>
          {items.map((spec, index) => {
            const inUse = state.used.has(spec.name);
            const missing = Boolean(spec.required) && !inUse;
            return <Row key={spec.name} title={`{{${spec.name}}}`} divider={index < items.length - 1} disabled={busy !== null}
              accessibilityLabel={`Insert {{${spec.name}}}${missing ? ', required, missing' : inUse ? ', in use' : ''}`}
              subtitle={<AppText variant="meta" tone="muted">{spec.description}</AppText>} onPress={() => insert(spec)}
              trailing={<View style={{ flexDirection: 'row', gap: 4 }}>
                {spec.shape === 'block' ? <Pill label="Block" /> : null}
                {spec.required ? <Pill label="Required" tone={missing ? 'destructive' : 'muted'} /> : null}
                {inUse ? <Pill label="In use" tone="success" icon={{ ios: 'checkmark', android: 'check' }} /> : null}
              </View>} />;
          })}
        </Group>)}
      </> : null}

      {tab === 'preview' ? <Preview kind={kind} template={draft.template} /> : null}

      {tab === 'default' ? <>
        <Card><AppText selectable variant="mono">{defaultTemplate}</AppText></Card>
        <Intro>Talyn&apos;s current default. Copy it into the editor to start over from it.</Intro>
        <Button variant="secondary" title="Copy into editor" disabled={state.isDefaultText || busy !== null}
          onPress={() => { setDraft({ template: defaultTemplate, basedOnHash: defaultPromptTemplateHash(kind) }); setTab('edit'); }} />
      </> : null}
    </Page>
    <BottomBar>
      {override ? <Button variant="quiet" size="sm" title="Reset to default" disabled={disabled} loading={busy === 'reset'} onPress={reset} /> : null}
      <View style={{ flex: 1 }} />
      <Button size="sm" title={busy === 'save' ? 'Saving' : state.saveLabel} disabled={disabled || !state.canSave} loading={busy === 'save'}
        onPress={() => { void write('save'); }} />
    </BottomBar>
  </KeyboardAvoidingView>;
}

function Preview({ kind, template }: { kind: PromptKind; template: string }) {
  const attention = useResource<PRRow[]>('attention');
  const rows = attention.data ?? [];
  const [provider, setProvider] = useState<CloudProviderType>('posthog_code');
  const [prId, setPrId] = useState('');
  const [picking, setPicking] = useState(false);
  const row = rows.find((item) => item.id === prId) ?? rows[0];
  const rendered = useMemo(() => renderPromptPreview(kind, template, provider, row), [kind, template, provider, row]);
  return <>
    <Group>
      <Row title="Pull request" chevron={rows.length > 0} disabled={rows.length === 0} onPress={() => setPicking(true)}
        accessibilityLabel={`Preview PR: ${previewRowLabel(row)}`}
        subtitle={previewRowLabel(row)} divider={false} />
    </Group>
    <Segmented<CloudProviderType> accessibilityLabel="Preview provider" options={PREVIEW_PROVIDERS} value={provider} onChange={setProvider} />
    <Card><AppText selectable variant="mono">{rendered}</AppText></Card>
    <Intro>{previewNote(kind)}</Intro>
    <PickerSheet visible={picking} title="Preview PR" onClose={() => setPicking(false)} sections={[{ key: 'prs', items: rows.map((item) => ({
      key: item.id, label: previewRowLabel(item), selected: item.id === row?.id, onPress: () => setPrId(item.id),
    })) }]} />
  </>;
}
