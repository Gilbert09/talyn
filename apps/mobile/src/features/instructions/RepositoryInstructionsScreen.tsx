import { repositories as repositoriesApi, type WatchedRepo } from '@talyn/client/native';
import type { RepositoryInstructionAgents, RepositoryInstructions } from '@talyn/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, View } from 'react-native';

import { useNetwork } from '../../auth/AuthProvider';
import { AppText, BottomBar, Button, EmptyState, Field, Segmented } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { errorMessage } from '../../lib/errors';
import { useFeatures } from '../../lib/features';
import { useResource } from '../../workflow/hooks';
import { Intro, Loading, Page } from '../more/Page';
import { useRemote } from '../more/useRemote';
import { TextArea } from '../settings/editors/TextArea';
import { useUnsavedGuard } from '../settings/editors/useUnsavedGuard';
import { AGENT_OPTIONS, REPOSITORY_INSTRUCTIONS_INTRO, REPOSITORY_INSTRUCTIONS_PLACEHOLDER, checkRepositoryInstructions,
  type RepositoryInstructionsDraft } from './model';

/** One repository's instructions, like web's inline `Editor` in `RepositoryInstructionsSection`. */
export function RepositoryInstructionsScreen({ repositoryId }: { repositoryId: string | undefined }) {
  const offline = useNetwork() === 'offline';
  const features = useFeatures();
  const offered = features?.workbenches === true;
  const repositories = useResource<WatchedRepo[]>('repositories', '', offered);
  const remote = useRemote<RepositoryInstructions | null>(offered && repositoryId ? `repo-instructions-body:${repositoryId}` : null,
    () => repositoriesApi.instructions.get(repositoryId ?? ''));
  if (features && !offered) return <Page><EmptyState title="Repository instructions are not available" detail="Sessions are not available on this account." /></Page>;
  if (!repositoryId) return <Page><EmptyState title="This repository does not exist" /></Page>;
  const repo = repositories.data?.find((item) => item.id === repositoryId);
  if (remote.data === undefined || !features) {
    return <Page>{remote.status === 'loading' || !features ? <Loading /> : <StateNotice resource={remote} offline={offline} refresh={() => { void remote.refresh(); }} />}</Page>;
  }
  return <Editor key={repositoryId} repositoryId={repositoryId} fullName={repo?.fullName ?? 'This repository'} saved={remote.data} offline={offline} />;
}

function Editor({ repositoryId, fullName, saved, offline }: {
  repositoryId: string; fullName: string; saved: RepositoryInstructions | null; offline: boolean;
}) {
  const router = useRouter();
  const [original] = useState<RepositoryInstructionsDraft | null>(saved ? { body: saved.body, agents: saved.agents } : null);
  const [body, setBody] = useState(saved?.body ?? '');
  const [agents, setAgents] = useState<RepositoryInstructionAgents>(saved?.agents ?? 'both');
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const check = checkRepositoryInstructions({ body, agents }, original);
  const { leave } = useUnsavedGuard(check.dirty);

  const save = async () => {
    setBusy('save');
    try {
      await repositoriesApi.instructions.put(repositoryId, { body, agents });
      leave(() => router.back());
    } catch (error) {
      Alert.alert('Could not save these instructions', errorMessage(error, 'Please try again.'));
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy('delete');
    try {
      await repositoriesApi.instructions.remove(repositoryId);
      leave(() => router.back());
    } catch (error) {
      Alert.alert('Could not delete these instructions', errorMessage(error, 'Please try again.'));
    } finally {
      setBusy(null);
    }
  };
  const confirmDelete = () => Alert.alert('Delete these instructions?', `Sessions on ${fullName} stop getting them.`, [
    { text: 'Keep', style: 'cancel' },
    { text: 'Confirm delete', style: 'destructive', onPress: () => { void remove(); } },
  ]);
  const disabled = busy !== null || offline;

  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={100}>
    <Page>
      <AppText variant="mono" selectable>{fullName}</AppText>
      <Intro>{REPOSITORY_INSTRUCTIONS_INTRO}</Intro>
      <Field label="Agents">
        <Segmented accessibilityLabel="Agents" options={AGENT_OPTIONS} value={agents} onChange={(value) => { if (busy === null) setAgents(value); }} />
      </Field>
      <View style={{ gap: 6 }}>
        <TextArea code accessibilityLabel={`Instructions for ${fullName}`} value={body} onChangeText={setBody} editable={busy === null}
          placeholder={REPOSITORY_INSTRUCTIONS_PLACEHOLDER} minHeight={240} />
        <AppText variant="meta" tone={check.tooLarge ? 'destructive' : 'muted'}>{check.count}</AppText>
      </View>
    </Page>
    <BottomBar>
      {original ? <Button variant="quiet" size="sm" title="Delete" disabled={disabled} loading={busy === 'delete'} onPress={confirmDelete} /> : null}
      <View style={{ flex: 1 }} />
      <Button size="sm" title={busy === 'save' ? 'Saving' : 'Save'} disabled={disabled || !check.canSave} loading={busy === 'save'}
        onPress={() => { void save(); }} />
    </BottomBar>
  </KeyboardAvoidingView>;
}
