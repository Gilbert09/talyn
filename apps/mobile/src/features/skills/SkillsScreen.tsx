import { skills as skillsApi, type WatchedRepo } from '@talyn/client/native';
import type { ListSkillsResponse, SkillSummary } from '@talyn/shared';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useRef, useState } from 'react';
import { Alert, View } from 'react-native';

import { useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { AppText, Group, IconButton, Row, SectionLabel, useActionSheet, useToast } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { errorMessage } from '../../lib/errors';
import { useTheme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import { useRefreshOnFocus } from '../instructions/useRefreshOnFocus';
import { Intro, Loading, Page } from '../more/Page';
import { useRemote } from '../more/useRemote';
import {
  DELETE_SKILL_TITLE, LOCAL_SKILLS_NOTE, NO_PLATFORM_SKILLS, SKILLS_INTRO, deleteSkillMessage, repoSkillsMessage, selectedRepositoryId,
  skillSubtitle, splitSkills,
} from './model';

/** Settings → Skills: Talyn skills to manage, and the skills found in a repository. Mirrors web `SkillsSettings`. */
export function SkillsScreen() {
  const router = useRouter();
  const offline = useNetwork() === 'offline';
  const workspaceId = useWorkspace().selected;
  const repositories = useResource<WatchedRepo[]>('repositories');
  const repos = repositories.data ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const repoId = selectedRepositoryId(repos, selected);
  const refreshRepo = useRef(false);
  const list = useRemote<ListSkillsResponse>(workspaceId ? `skills:${workspaceId}:${repoId ?? ''}` : null,
    () => skillsApi.list(workspaceId ?? '', repoId ?? undefined, refreshRepo.current || undefined));
  const [deleting, setDeleting] = useState<string | null>(null);
  const menu = useActionSheet();
  const toast = useToast();
  const refresh = () => { void list.refresh(); void repositories.refresh(); };
  useRefreshOnFocus(refresh);
  const { platform, repo } = splitSkills(list.data);
  const repoName = repos.find((item) => item.id === repoId)?.fullName;

  const refetchRepo = async () => {
    refreshRepo.current = true;
    try { await list.refresh(); } finally { refreshRepo.current = false; }
  };
  const openSkill = (skill: SkillSummary) => { if (skill.id) router.push({ pathname: '/settings/skills/[id]', params: { id: skill.id } }); };
  const remove = async (skill: SkillSummary) => {
    if (!skill.id) return;
    setDeleting(skill.id);
    try {
      await skillsApi.remove(skill.id);
      toast.show(`Deleted "${skill.name}"`);
      await list.refresh();
    } catch (error) {
      Alert.alert('Could not delete skill', errorMessage(error, 'Please try again.'));
    } finally {
      setDeleting(null);
    }
  };
  const confirmDelete = (skill: SkillSummary) => Alert.alert(DELETE_SKILL_TITLE, deleteSkillMessage(skill.name), [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => { void remove(skill); } },
  ]);
  const skillMenu = (skill: SkillSummary) => menu.open({ title: skill.name, message: skill.description || undefined, actions: [
    { label: 'Edit', onPress: () => openSkill(skill) },
    { label: 'Delete', destructive: true, disabled: offline, onPress: () => confirmDelete(skill) },
  ] });
  const pickRepo = () => menu.open({ title: 'Repository', actions: repos.map((item) => ({
    label: item.fullName, selected: item.id === repoId, onPress: () => setSelected(item.id),
  })) });
  const repoMessage = repositories.data === undefined ? null
    : repos.length === 0 ? repoSkillsMessage(0, null, [])
      : list.data ? repoSkillsMessage(repos.length, list.data, repo) : null;

  return <View style={{ flex: 1 }}>
    <Page refreshing={list.refreshing && list.data !== undefined} onRefresh={refresh}>
      <Intro>{SKILLS_INTRO}</Intro>
      {list.data === undefined ? <StateNotice resource={list} offline={offline} refresh={() => { void list.refresh(); }} /> : null}

      <Group title="Talyn skills">
        <Row title="New skill" leading={<PlusIcon />} disabled={offline || !workspaceId} divider={list.data !== undefined}
          onPress={() => router.push({ pathname: '/settings/skills/[id]', params: { id: 'new' } })} />
        {list.data === undefined ? null : platform.length === 0
          ? <Row title={NO_PLATFORM_SKILLS} titleLines={3} divider={false} />
          : platform.map((skill, index) => <Row key={skill.key} title={skill.name} subtitle={skill.description || undefined} chevron
            divider={index < platform.length - 1} disabled={deleting === skill.id}
            onPress={() => openSkill(skill)} onLongPress={() => skillMenu(skill)} />)}
      </Group>

      <Group title="Local skills" footer={LOCAL_SKILLS_NOTE}>
        <Row title="Managed in the desktop app" leading={<LaptopIcon />} divider={false} />
      </Group>

      <View>
        <SectionLabel title="Repo skills" trailing={<IconButton label="Re-fetch from GitHub" symbol={{ ios: 'arrow.clockwise', android: 'refresh' }}
          size={16} disabled={list.refreshing || !repoId || offline} onPress={() => { void refetchRepo(); }} />} />
        <Group>
          {repos.length > 0 ? <Row title="Repository" chevron={repos.length > 1} disabled={repos.length < 2} onPress={pickRepo}
            accessibilityLabel={`Repository: ${repoName ?? ''}`}
            trailing={<AppText variant="mono" tone="muted" numberOfLines={1} style={{ maxWidth: '60%', textAlign: 'right' }}>{repoName}</AppText>}
            divider={repoMessage !== null || repo.length > 0} /> : null}
          {repositories.data === undefined || (repos.length > 0 && list.data === undefined) ? <Loading />
            : repoMessage ? <Row title={repoMessage} titleLines={3} divider={false} />
              : repo.map((skill, index) => <Row key={skill.key} title={skill.name} subtitle={skillSubtitle(skill)} chevron
                divider={index < repo.length - 1}
                onPress={() => router.push({ pathname: '/settings/skills/repo', params: { repositoryId: repoId ?? '', name: skill.name } })} />)}
        </Group>
      </View>
    </Page>
    {menu.sheet}
    {toast.element}
  </View>;
}

function PlusIcon() {
  const c = useTheme();
  return <SymbolView name={{ ios: 'plus', android: 'add' }} size={16} tintColor={c.primaryAction} />;
}

function LaptopIcon() {
  const c = useTheme();
  return <SymbolView name={{ ios: 'laptopcomputer', android: 'laptop' }} size={16} tintColor={c.muted} />;
}
