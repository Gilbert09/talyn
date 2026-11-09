import { skills as skillsApi } from '@talyn/client/native';
import type { PlatformSkill } from '@talyn/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, View } from 'react-native';

import { useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { Banner, BottomBar, Button, EmptyState, Field, Input } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { errorMessage } from '../../lib/errors';
import { Page } from '../more/Page';
import { useRemote } from '../more/useRemote';
import { TextArea } from '../settings/editors/TextArea';
import { useUnsavedGuard } from '../settings/editors/useUnsavedGuard';
import {
  DELETE_SKILL_TITLE, SKILL_CONTENT_PLACEHOLDER, deleteSkillMessage, skillCreateRequest, skillDirty, skillDraftError, skillDraftOf,
  skillSaveFailureTitle, skillUpdateRequest, type SkillDraft,
} from './model';

export const NEW_SKILL_ID = 'new';

/** Create or edit one Talyn skill, like web's skill dialog. With id `new`, a create. */
export function SkillEditorScreen({ id }: { id: string | undefined }) {
  const offline = useNetwork() === 'offline';
  const creating = id === NEW_SKILL_ID;
  const skill = useRemote<PlatformSkill>(id && !creating ? `skill:${id}` : null, () => skillsApi.get(id ?? ''));
  if (!id) return <Page><EmptyState title="This skill does not exist" /></Page>;
  if (creating) return <Editor key="new" original={null} offline={offline} />;
  if (skill.data === undefined) return <Page><StateNotice resource={skill} offline={offline} refresh={() => { void skill.refresh(); }} /></Page>;
  return <Editor key={id} original={skill.data} offline={offline} />;
}

function Editor({ original, offline }: { original: PlatformSkill | null; offline: boolean }) {
  const router = useRouter();
  const workspaceId = useWorkspace().selected;
  const [saved] = useState<SkillDraft | null>(original ? skillDraftOf(original) : null);
  const [draft, setDraft] = useState<SkillDraft>(() => skillDraftOf(original));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const dirty = skillDirty(saved, draft);
  const { leave } = useUnsavedGuard(dirty);
  const set = (key: keyof SkillDraft) => (value: string) => setDraft((prev) => ({ ...prev, [key]: value }));
  const editable = busy === null;

  const save = async () => {
    const invalid = skillDraftError(draft);
    setError(invalid);
    if (invalid || !workspaceId) return;
    setBusy('save');
    try {
      if (original) await skillsApi.update(original.id, skillUpdateRequest(draft));
      else await skillsApi.create(skillCreateRequest(workspaceId, draft));
      leave(() => router.back());
    } catch (failure) {
      Alert.alert(skillSaveFailureTitle(Boolean(original)), errorMessage(failure, 'Please try again.'));
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!original) return;
    setBusy('delete');
    try {
      await skillsApi.remove(original.id);
      leave(() => router.back());
    } catch (failure) {
      Alert.alert('Could not delete skill', errorMessage(failure, 'Please try again.'));
    } finally {
      setBusy(null);
    }
  };
  const confirmDelete = () => original && Alert.alert(DELETE_SKILL_TITLE, deleteSkillMessage(original.name), [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => { void remove(); } },
  ]);
  const disabled = busy !== null || offline;

  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={100}>
    <Page>
      <Field label="Name">
        <Input accessibilityLabel="Name" value={draft.name} onChangeText={set('name')} editable={editable} placeholder="pr-review"
          autoCapitalize="none" autoCorrect={false} />
      </Field>
      <Field label="Description">
        <Input accessibilityLabel="Description" value={draft.description} onChangeText={set('description')} editable={editable} multiline
          placeholder="What this skill does, shown in the picker" />
      </Field>
      <Field label="Content (SKILL.md)">
        <TextArea code accessibilityLabel="Content (SKILL.md)" value={draft.content} onChangeText={set('content')} editable={editable}
          placeholder={SKILL_CONTENT_PLACEHOLDER} minHeight={280} />
      </Field>
      {error ? <Banner tone="destructive" message={error} /> : null}
    </Page>
    <BottomBar>
      {original ? <Button variant="quiet" size="sm" title="Delete" disabled={disabled} loading={busy === 'delete'} onPress={confirmDelete} /> : null}
      <View style={{ flex: 1 }} />
      <Button size="sm" title={busy === 'save' ? 'Saving' : original ? 'Save changes' : 'Create skill'} loading={busy === 'save'}
        disabled={disabled || !dirty || !workspaceId} onPress={() => { void save(); }} />
    </BottomBar>
  </KeyboardAvoidingView>;
}
