import { skills as skillsApi } from '@talyn/client/native';

import { useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { AppText, Card, EmptyState } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { Intro, Page } from '../more/Page';
import { useRemote } from '../more/useRemote';

/** A repository skill's SKILL.md, read-only: it lives in the repository, so it is changed there. */
export function RepoSkillScreen({ repositoryId, name }: { repositoryId: string | undefined; name: string | undefined }) {
  const offline = useNetwork() === 'offline';
  const workspaceId = useWorkspace().selected;
  const content = useRemote<{ content: string; repoPath: string }>(workspaceId && repositoryId && name ? `repo-skill:${workspaceId}:${repositoryId}:${name}` : null,
    () => skillsApi.repoContent(workspaceId ?? '', repositoryId ?? '', name ?? ''));
  if (!repositoryId || !name) return <Page><EmptyState title="This skill does not exist" /></Page>;
  return <Page refreshing={content.refreshing && content.data !== undefined} onRefresh={() => { void content.refresh(); }}>
    <AppText variant="rowTitle">{name}</AppText>
    {content.data ? <>
      <Intro>{`From ${content.data.repoPath} on the default branch. Change it in the repository.`}</Intro>
      <Card><AppText selectable variant="mono">{content.data.content}</AppText></Card>
    </> : <StateNotice resource={content} offline={offline} refresh={() => { void content.refresh(); }} />}
  </Page>;
}
