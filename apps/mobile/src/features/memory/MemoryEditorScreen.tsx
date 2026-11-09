import { workbenches, type WatchedRepo } from '@talyn/client/native';
import { MEMORY_TYPES, type MemoryEntry, type MemoryType } from '@talyn/shared';
import { useRouter } from 'expo-router';
import type { PropsWithChildren } from 'react';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, View } from 'react-native';

import { useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { AppText, Banner, BottomBar, Button, EmptyState, Group, Input, Row, Segmented, useActionSheet } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { errorMessage } from '../../lib/errors';
import { useFeatures } from '../../lib/features';
import { sessionRoute } from '../../navigation/routes';
import { useResource } from '../../workflow/hooks';
import { Fact, Loading, Page } from '../more/Page';
import { useRemote } from '../more/useRemote';
import { TextArea } from '../settings/editors/TextArea';
import { useUnsavedGuard } from '../settings/editors/useUnsavedGuard';
import {
  MEMORY_TYPE_LABEL, WORKSPACE_TARGET, WORKSPACE_TARGET_LABEL, ago, memoryDirty, memoryDraftOf, memoryFieldCounts, memorySaveRequest,
  memoryScopeLabel, memorySourceLabel, sameNameMessage, targetLabel, type MemoryDraft,
} from './model';

export const NEW_MEMORY_ID = 'new';
const TYPE_OPTIONS = MEMORY_TYPES.map((value) => ({ value, label: MEMORY_TYPE_LABEL[value] }));

/** One memory entry: view and edit it, forget or restore it. With id `new`, a create. Mirrors web `MemoryEditor`. */
export function MemoryEditorScreen({ id }: { id: string | undefined }) {
  const offline = useNetwork() === 'offline';
  const features = useFeatures();
  const offered = features?.workbenches === true;
  const creating = id === NEW_MEMORY_ID;
  const repositories = useResource<WatchedRepo[]>('repositories', '', offered);
  const entry = useRemote<MemoryEntry>(offered && id && !creating ? `memory-entry:${id}` : null, () => workbenches.memory.get(id ?? ''));
  if (!features) return <Page><Loading /></Page>;
  if (!offered) return <Page><EmptyState title="Memory is not available" detail="Sessions are not available on this account." /></Page>;
  if (!id) return <Page><EmptyState title="This memory does not exist" /></Page>;
  const repos = repositories.data ?? [];
  if (creating) return <Editor key="new" original={null} repositories={repos} offline={offline} />;
  if (entry.data === undefined) return <Page><StateNotice resource={entry} offline={offline} refresh={() => { void entry.refresh(); }} /></Page>;
  return <Editor key={id} original={entry.data} repositories={repos} offline={offline} />;
}

function Editor({ original: initial, repositories, offline }: {
  original: MemoryEntry | null; repositories: ReadonlyArray<{ id: string; fullName: string }>; offline: boolean;
}) {
  const router = useRouter();
  const workspaceId = useWorkspace().selected ?? initial?.workspaceId ?? '';
  const [original, setOriginal] = useState<MemoryEntry | null>(initial);
  const [draft, setDraft] = useState<MemoryDraft>(() => memoryDraftOf(initial));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'forget' | 'restore' | null>(null);
  const menu = useActionSheet();
  const forgotten = Boolean(original?.forgottenAt);
  const dirty = !forgotten && memoryDirty(original, draft);
  const { leave } = useUnsavedGuard(dirty);
  const counts = memoryFieldCounts(draft);
  const set = <K extends keyof MemoryDraft>(key: K, value: MemoryDraft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));
  const editable = busy === null && !forgotten;
  const source = original ? memorySourceLabel(original.source) : null;

  const save = async () => {
    setError(null);
    const request = memorySaveRequest(workspaceId, original, draft);
    if (request.kind === 'none') { leave(() => router.back()); return; }
    if (request.kind === 'invalid') { setError(request.error); return; }
    setBusy('save');
    try {
      if (request.kind === 'update' && original) {
        await workbenches.memory.update(original.id, request.patch);
      } else if (request.kind === 'create') {
        const result = await workbenches.memory.put(request.input);
        if (result.outcome === 'updated') Alert.alert('Memory updated', sameNameMessage(result.entry.name));
      }
      leave(() => router.back());
    } catch (failure) {
      setError(errorMessage(failure, 'Could not save this memory'));
    } finally {
      setBusy(null);
    }
  };
  const forget = async () => {
    if (!original) return;
    setBusy('forget');
    try {
      const summary = await workbenches.memory.forget(original.id);
      setOriginal({ ...original, ...summary });
      setDraft(memoryDraftOf({ ...original, ...summary }));
    } catch (failure) {
      Alert.alert('Could not forget this memory', errorMessage(failure, 'Please try again.'));
    } finally {
      setBusy(null);
    }
  };
  const restore = async () => {
    if (!original) return;
    setBusy('restore');
    try {
      const restored = await workbenches.memory.restore(original.id);
      setOriginal(restored);
      setDraft(memoryDraftOf(restored));
    } catch (failure) {
      Alert.alert('Could not restore this memory', errorMessage(failure, 'Please try again.'));
    } finally {
      setBusy(null);
    }
  };
  const pickTarget = () => menu.open({ title: 'Applies to', actions: [
    { label: WORKSPACE_TARGET_LABEL, selected: draft.target === WORKSPACE_TARGET, onPress: () => set('target', WORKSPACE_TARGET) },
    ...repositories.map((repo) => ({ label: repo.fullName, selected: draft.target === repo.id, onPress: () => set('target', repo.id) })),
  ] });

  return <View style={{ flex: 1 }}>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={100}>
      <Page>
        {forgotten ? <Banner tone="information" message="This memory is forgotten. Sessions no longer read it." action="Restore"
          actionDisabled={busy !== null || offline} onAction={() => { void restore(); }} /> : null}
        <Group>
          {original ? <Fact label="Applies to" value={memoryScopeLabel(original, repositories)} />
            : <Row title="Applies to" chevron disabled={!editable} onPress={pickTarget} accessibilityLabel={`Applies to: ${targetLabel(draft.target, repositories)}`}
              trailing={<AppText variant="meta" tone="muted" numberOfLines={1} style={{ maxWidth: '60%', textAlign: 'right' }}>{targetLabel(draft.target, repositories)}</AppText>} />}
          {original && source ? <Row title={source.text} divider={false} disabled={!source.workbenchId}
            onPress={source.workbenchId ? () => router.push(sessionRoute(source.workbenchId!)) : undefined}
            chevron={Boolean(source.workbenchId)} subtitle={`Updated ${ago(original.updatedAt)}`} /> : null}
        </Group>
        <Counted label="Type">
          <Segmented accessibilityLabel="Memory type" options={TYPE_OPTIONS} value={draft.type}
            onChange={(value: MemoryType) => { if (editable) set('type', value); }} />
        </Counted>
        <Counted label="Name" count={counts.name.label} over={counts.name.over}>
          <Input accessibilityLabel="Memory name" value={draft.name} editable={editable} onChangeText={(value) => set('name', value)}
            placeholder="For example: build command" autoCorrect={false} />
        </Counted>
        <Counted label="Description" count={counts.description.label} over={counts.description.over}>
          <Input accessibilityLabel="Memory description" value={draft.description} editable={editable} multiline
            onChangeText={(value) => set('description', value)} placeholder="One sentence. Sessions see this in every turn." />
        </Counted>
        <Counted label="Note" count={counts.body.label} over={counts.body.over}>
          <TextArea code accessibilityLabel="Memory note" value={draft.body} editable={editable} onChangeText={(value) => set('body', value)}
            placeholder="The full note. A session reads it when it needs it." minHeight={200} />
        </Counted>
        {error ? <Banner tone="destructive" message={error} /> : null}
      </Page>
      <BottomBar>
        {original && !forgotten ? <Button variant="quiet" size="sm" title="Forget" disabled={busy !== null || offline} loading={busy === 'forget'}
          onPress={() => { void forget(); }} /> : null}
        <View style={{ flex: 1 }} />
        {!forgotten ? <Button size="sm" title={busy === 'save' ? 'Saving' : 'Save'} disabled={busy !== null || offline || !dirty}
          loading={busy === 'save'} onPress={() => { void save(); }} /> : null}
      </BottomBar>
    </KeyboardAvoidingView>
    {menu.sheet}
  </View>;
}

function Counted({ label, count, over = false, children }: PropsWithChildren<{ label: string; count?: string; over?: boolean }>) {
  return <View style={{ gap: 6 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
      <AppText variant="meta" tone="muted">{label}</AppText>
      {count ? <AppText variant="meta" tone={over ? 'destructive' : 'muted'}>{count}</AppText> : null}
    </View>
    {children}
  </View>;
}
