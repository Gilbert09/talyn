import { skills as skillsApi, type WatchedRepo } from '@talyn/client/native';
import type { CodeReviewCustomReviewer, ListSkillsResponse, SkillSummary } from '@talyn/shared';
import { useState } from 'react';
import { View } from 'react-native';

import { useNetwork } from '../../auth/AuthProvider';
import { PickerSheet, type PickerSection } from '../../components/PickerSheet';
import { AppText, Row, type Symbol } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { useResource } from '../../workflow/hooks';
import { Loading } from '../more/Page';
import { useRemote } from '../more/useRemote';
import { emptySkillsText, repoSkillsError, reviewerSkillRefusal, skillGroups } from './model';

const GROUP_ICONS: Record<SkillSummary['source'], Symbol> = {
  repo: { ios: 'folder', android: 'folder' },
  platform: { ios: 'sparkles', android: 'auto_awesome' },
  local: { ios: 'laptopcomputer', android: 'laptop' },
};

/**
 * Choose a skill to review with: the repository's skills and Talyn's, from the
 * same `skills.list` web reads. A skill that cannot be a reviewer shows why
 * and cannot be chosen. With more than one repository, the header switches
 * which repository's skills show.
 */
export function ReviewerPicker({ visible, workspaceId, added, onClose, onPick }: {
  visible: boolean; workspaceId: string; added: readonly CodeReviewCustomReviewer[]; onClose(): void; onPick(skill: SkillSummary): void;
}) {
  const offline = useNetwork() === 'offline';
  const repos = useResource<WatchedRepo[]>('repositories', '', visible);
  const [chosenRepo, setChosenRepo] = useState<string | null>(null);
  const [choosingRepo, setChoosingRepo] = useState(false);
  const [query, setQuery] = useState('');
  const repoList = repos.data ?? [];
  const repo = repoList.find((item) => item.id === chosenRepo) ?? repoList[0] ?? null;
  // A failed repository read still lists Talyn's skills.
  const reposKnown = repos.data !== undefined || (repos.status !== 'loading' && repos.status !== 'idle');
  const list = useRemote<ListSkillsResponse>(visible && reposKnown ? `review-skills:${workspaceId}:${repo?.id ?? ''}` : null,
    () => skillsApi.list(workspaceId, repo?.id));

  const close = () => { setChoosingRepo(false); setQuery(''); onClose(); };

  if (choosingRepo) {
    return <PickerSheet visible={visible} title="Choose a repository" onClose={close} closeOnSelect={false}
      sections={[{ key: 'repos', items: repoList.map((item) => ({ key: item.id, label: item.fullName, selected: item.id === repo?.id,
        icon: GROUP_ICONS.repo, onPress: () => { setChosenRepo(item.id); setChoosingRepo(false); } })) }]} />;
  }

  const groups = skillGroups(list.data, repo?.fullName ?? null, query);
  const warning = repoSkillsError(list.data);
  const sections: PickerSection[] = [
    ...(warning ? [{ key: 'warning', note: warning, items: [] }] : []),
    ...groups.map((group) => ({ key: group.key, title: group.title, items: group.skills.map((skill) => {
      const refusal = reviewerSkillRefusal(skill, added);
      return { key: skill.key, label: skill.name, detail: refusal ?? (skill.description || undefined), icon: GROUP_ICONS[group.key],
        disabled: refusal !== null, accessibilityLabel: refusal ? `${skill.name}. ${refusal}` : skill.name, onPress: () => onPick(skill) };
    }) })),
  ];
  const ready = list.data !== undefined;
  const empty = ready ? <AppText variant="meta" tone="muted" style={{ textAlign: 'center', paddingVertical: 24 }}>{emptySkillsText(query)}</AppText>
    : list.status === 'loading' || list.status === 'idle' || !reposKnown ? <Loading label="Loading skills" />
      : <StateNotice resource={list} offline={offline} refresh={() => { void list.refresh(); }} />;

  return <PickerSheet visible={visible} title="Add a reviewer" onClose={close} sections={sections} empty={empty}
    search={{ value: query, onChange: setQuery, placeholder: 'Search skills' }}
    header={repoList.length > 1 ? <View style={{ paddingHorizontal: 12 }}>
      <Row title="Repository" chevron divider={false} accessibilityLabel={`Repository: ${repo?.fullName ?? 'none'}. Change`}
        trailing={<AppText variant="meta" tone="muted" numberOfLines={1} style={{ maxWidth: '60%' }}>{repo?.fullName ?? ''}</AppText>}
        onPress={() => setChoosingRepo(true)} />
    </View> : null} />;
}
