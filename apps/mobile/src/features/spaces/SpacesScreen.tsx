import type { SpacesTeam } from '@talyn/shared';

import { useNetwork } from '../../auth/AuthProvider';
import { EmptyState, Group, Row } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { useFeatures } from '../../lib/features';
import { Intro, Loading, Page, WebRow } from '../more/Page';
import { spaceRoute } from '../more/routes';
import { SpaceTile } from './Avatars';
import { useTeamMembers, useTeams } from './data';
import { spacesOffered } from './model';

export function SpacesScreen() {
  const features = useFeatures();
  const offline = useNetwork() === 'offline';
  const list = useTeams();
  if (features === null) return <Page><Loading /></Page>;
  if (!spacesOffered(features)) return <Page><EmptyState title="Spaces are not available" detail="Your account does not have Spaces." /></Page>;
  const teams = list.data;
  return <Page refreshing={list.refreshing && teams !== undefined} onRefresh={() => { void list.refresh(); }}>
    <Intro>In a space, your teammates can see your sessions. Each one still runs on its creator&apos;s account.</Intro>
    {teams === undefined && list.status === 'loading' ? <Loading /> : <StateNotice resource={list} offline={offline} refresh={() => { void list.refresh(); }} />}
    {teams?.length === 0 ? <EmptyState title="No teams yet" detail="Create a team and invite teammates in Talyn on the web." /> : null}
    {teams?.map((team) => <TeamGroup key={team.id} team={team} />)}
    <Group footer="Create teams and spaces, invite people and add repositories in Talyn on the web.">
      <WebRow title="Manage teams on the web" path="/settings/teams" />
    </Group>
  </Page>;
}

function TeamGroup({ team }: { team: SpacesTeam }) {
  const members = useTeamMembers(team.id);
  const count = members.data?.length;
  const footer = count === undefined ? undefined : `${count} ${count === 1 ? 'member' : 'members'}`;
  return <Group title={team.name} footer={footer}>
    {team.spaces.length === 0 ? <Row title="No spaces yet" divider={false} /> : team.spaces.map((space, index) =>
      <Row key={space.id} title={space.name} href={spaceRoute(space.id)} chevron divider={index < team.spaces.length - 1}
        leading={<SpaceTile name={space.name} color={space.color} image={space.image} />} />)}
  </Group>;
}
