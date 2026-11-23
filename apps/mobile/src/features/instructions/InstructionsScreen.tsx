import { repositories as repositoriesApi, workspaces, type WatchedRepo } from '@talyn/client/native';
import type { PromptKind, RepositoryInstructionsSummary, Workspace } from '@talyn/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { useMobileRuntime, useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { AppText, Group, Pill, Row, useActionSheet, useToast } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { errorMessage } from '../../lib/errors';
import { useFeatures } from '../../lib/features';
import { useResource } from '../../workflow/hooks';
import { Intro, Loading, Page } from '../more/Page';
import { useRemote } from '../more/useRemote';
import {
  INSTRUCTIONS_INTRO, REPOSITORY_INSTRUCTIONS_INTRO, STALE_DEFAULT_LINE, promptCards, promptSavedMessage, promptSettingsPatch,
  repositoryInstructionRows, type PromptCard,
} from './model';
import { useRefreshOnFocus } from './useRefreshOnFocus';

/**
 * Settings → Instructions: repository instructions (when sessions are
 * offered) above the workspace prompt templates. Mirrors web
 * `RepositoryInstructionsSection` and `InstructionsSettings`.
 */
export function InstructionsScreen() {
  const router = useRouter();
  const { workflow } = useMobileRuntime();
  const offline = useNetwork() === 'offline';
  const workspaceId = useWorkspace().selected;
  const features = useFeatures();
  const workspace = useResource<Workspace>('workspace');
  const showRepositories = features?.workbenches === true;
  const repositories = useResource<WatchedRepo[]>('repositories', '', showRepositories);
  const summaries = useRemote<RepositoryInstructionsSummary[]>(showRepositories && workspaceId ? `repo-instructions:${workspaceId}` : null,
    () => repositoriesApi.instructions.list(workspaceId ?? ''));
  const menu = useActionSheet();
  const toast = useToast();
  const [resetting, setResetting] = useState<PromptKind | null>(null);
  const refresh = () => { void workspace.refresh(); if (showRepositories) { void repositories.refresh(); void summaries.refresh(); } };
  useRefreshOnFocus(refresh);

  const reset = (card: PromptCard) => Alert.alert(`Reset ${card.label}?`, "The workspace goes back to Talyn's default for this prompt.", [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Reset', style: 'destructive', onPress: () => { void runReset(card.kind); } },
  ]);
  const runReset = async (kind: PromptKind) => {
    if (!workspaceId) return;
    setResetting(kind);
    try {
      await workspaces.update(workspaceId, promptSettingsPatch(kind, null));
      await workflow.load('workspace').catch(() => undefined);
      toast.show(promptSavedMessage(kind, false));
    } catch (error) {
      Alert.alert('Could not reset the prompt', errorMessage(error, 'Please try again.'));
    } finally {
      setResetting(null);
    }
  };
  const open = (kind: PromptKind) => router.push({ pathname: '/settings/instructions/prompt/[kind]', params: { kind } });
  const cardMenu = (card: PromptCard) => menu.open({ title: card.label, actions: [
    { label: card.customized ? 'Edit' : 'Customize', onPress: () => open(card.kind) },
    ...(card.customized ? [{ label: 'Reset to default', destructive: true, disabled: offline, onPress: () => reset(card) }] : []),
  ] });

  const cards = promptCards(workspace.data?.settings);
  const rows = repositoryInstructionRows(repositories.data ?? [], summaries.data, workspaceId);

  return <View style={{ flex: 1 }}>
    <Page refreshing={workspace.refreshing || summaries.refreshing} onRefresh={refresh}>
      {showRepositories ? <Group title="Repository instructions" footer={REPOSITORY_INSTRUCTIONS_INTRO}>
        {summaries.status === 'error' && summaries.data === undefined
          ? <Row title="Could not load repository instructions" divider={false}
            trailing={<AppText variant="meta" tone="primary" accessibilityRole="button" onPress={() => { void summaries.refresh(); }}>Try again</AppText>} />
          : repositories.data === undefined || summaries.data === undefined ? <Loading />
            : rows.length === 0 ? <Row title="Add a repository first, then write instructions for it here." titleLines={3} divider={false} />
              : rows.map((row, index) => <Row key={row.id} title={row.fullName} subtitle={row.detail} chevron divider={index < rows.length - 1}
                accessibilityLabel={`Edit instructions for ${row.fullName}`}
                trailing={row.set ? <Pill label="Set" tone="primary" /> : undefined}
                onPress={() => router.push({ pathname: '/settings/instructions/repository/[id]', params: { id: row.id } })} />)}
      </Group> : null}

      <Intro>{INSTRUCTIONS_INTRO}</Intro>
      {workspace.data === undefined ? <StateNotice resource={workspace} offline={offline} refresh={() => { void workspace.refresh(); }} />
        : <Group title="Prompts">
          {cards.map((card, index) => <Row key={card.kind} title={card.label} chevron divider={index < cards.length - 1}
            disabled={resetting === card.kind || !workspaceId} titleLines={2}
            accessibilityLabel={`${card.label}, ${card.customized ? 'customized' : 'default'}`}
            trailing={card.customized ? <Pill label="Customized" tone="success" /> : <Pill label="Default" />}
            onPress={() => open(card.kind)} onLongPress={() => cardMenu(card)}
            subtitle={<AppText variant="meta" tone="muted">{card.usedFor}</AppText>}>
            {card.updatedAt ? <AppText variant="meta" tone="muted">Last edited {new Date(card.updatedAt).toLocaleString()}</AppText> : null}
            {card.stale ? <AppText variant="meta" tone="warning">{STALE_DEFAULT_LINE}</AppText> : null}
          </Row>)}
        </Group>}
    </Page>
    {menu.sheet}
    {toast.element}
  </View>;
}
