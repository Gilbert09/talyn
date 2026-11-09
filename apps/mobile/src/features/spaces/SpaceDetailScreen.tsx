import type { SpacePresenceMember, SpaceSessionRow, SpaceTaskRow, TeamMember } from '@talyn/shared';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';

import { useAuth, useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { SessionStateIcon } from '../../components/Status';
import { AppText, Button, EmptyState, Group, Pill, PrNumber, Row, ui } from '../../components/UI';
import { openExternal, StateNotice } from '../../components/Workflow';
import { useFeatures } from '../../lib/features';
import { shortTime, useNow } from '../../lib/time';
import { HOME } from '../../navigation/routes';
import { Intro, Loading, Page } from '../more/Page';
import { MemberAvatar, SpaceTile } from './Avatars';
import { useActiveContext, useOpenSpaceRow } from './context';
import { useSpaceEvents, useSpaceItems, useSpacePresence, useTeamMembers } from './data';
import {
  activeLogins, findSpace, groupSpaceSessions, hiddenText, memberName, openTarget, placeLabel, presenceSentence,
  spaceSessionState, spacesOffered, viewersOf,
} from './model';

export function SpaceDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const spaceId = typeof params.id === 'string' ? params.id : '';
  const features = useFeatures();
  const offered = spacesOffered(features);
  const offline = useNetwork() === 'offline';
  const self = useAuth().user?.id ?? null;
  const place = useActiveContext();
  const teams = place.teams;
  const router = useRouter();
  const found = findSpace(teams.data, spaceId);
  const items = useSpaceItems(offered && found ? spaceId : null);
  const members = useTeamMembers(found?.team.id ?? null);
  const presence = useSpacePresence(offered && found ? spaceId : null);
  const ids = useMemo(() => new Set([...(items.data?.sessions.items ?? []).map((row) => row.id), ...(items.data?.tasks.items ?? []).map((row) => row.id)]),
    [items.data]);
  useSpaceEvents(ids, found ? spaceId : null, () => { void items.refresh(); });

  if (features === null) return <Page><Loading /></Page>;
  if (!offered) return <Page><EmptyState title="Spaces are not available" detail="Your account does not have Spaces." /></Page>;
  const refresh = () => { void teams.refresh(); void items.refresh(); void members.refresh(); };
  if (!found) {
    return <Page refreshing={teams.refreshing} onRefresh={refresh}>
      {teams.data === undefined && teams.status === 'loading' ? <Loading /> : <StateNotice resource={teams} offline={offline} refresh={refresh} />}
      {teams.data ? <EmptyState title="Space not found" detail="It may have been archived, or you left its team." /> : null}
    </Page>;
  }
  const groups = groupSpaceSessions(items.data?.sessions.items ?? [], presence, self);
  const tasks = items.data?.tasks.items ?? [];
  const hidden = hiddenText((items.data?.sessions.hiddenCount ?? 0) + (items.data?.tasks.hiddenCount ?? 0));
  const here = presence?.filter((member) => member.state === 'active' && member.userId !== self) ?? [];
  const sentence = presenceSentence(here);
  return <Page refreshing={items.refreshing && items.data !== undefined} onRefresh={refresh}>
    <Stack.Screen options={{ title: found.space.name }} />
    <View style={ui.inline}>
      <SpaceTile name={found.space.name} color={found.space.color} image={found.space.image} size={28} />
      <View style={{ flex: 1 }}>
        <AppText variant="rowTitle">{found.space.name}</AppText>
        <AppText variant="meta" tone="muted">{sentence ?? found.team.name}</AppText>
      </View>
    </View>
    {place.active?.space.id === spaceId ? <AppText variant="meta" tone="muted">You are in this space. New work starts here.</AppText>
      : <View style={{ alignSelf: 'flex-start' }}>
        <Button variant="secondary" size="sm" title="Switch to this space"
          onPress={() => { void place.select({ kind: 'space', spaceId }).then(() => router.navigate(HOME)); }} />
      </View>}
    {items.data === undefined && items.status === 'loading' ? <Loading label="Loading the space" />
      : <StateNotice resource={items} offline={offline} refresh={() => { void items.refresh(); }} />}
    {items.data ? <>
      {groups.active.length ? <SessionGroup title="Active now" rows={groups.active} presence={presence} self={self} /> : null}
      {groups.recent.length ? <SessionGroup title={groups.active.length ? 'Recent' : 'Sessions'} rows={groups.recent} presence={presence} self={self} /> : null}
      {!groups.active.length && !groups.recent.length ? <EmptyState title="No sessions in this space yet" detail="Start one in Talyn on the web." /> : null}
      {tasks.length ? <TaskGroup tasks={tasks} /> : null}
      {hidden ? <Intro>{hidden}</Intro> : null}
    </> : null}
    <MemberGroup members={members.data} status={members.status} active={activeLogins(presence)} />
  </Page>;
}

function SessionGroup({ title, rows, presence, self }: { title: string; rows: SpaceSessionRow[]; presence: SpacePresenceMember[] | undefined; self: string | null }) {
  const now = useNow();
  const workspaceId = useWorkspace().selected;
  const choices = useWorkspace().choices;
  const open = useOpenSpaceRow();
  return <Group title={title}>
    {rows.map((row, index) => {
      const state = spaceSessionState(row);
      const viewers = viewersOf(presence, row.id, self);
      const target = openTarget(row, workspaceId, choices.map((choice) => choice.id));
      const name = row.title || row.name;
      const owner = memberName(row.creator);
      const viewing = presenceSentence(viewers);
      return <Row key={row.id} title={name} divider={index < rows.length - 1} leading={<SessionStateIcon state={state} />}
        subtitle={`${owner} · ${placeLabel(row)}`}
        accessibilityLabel={`${name}. ${state.label}. ${owner}.${viewing ? ` ${viewing}.` : ''}${target.kind === 'web' ? ' Opens on the web.' : ''}`}
        accessibilityRole="link"
        onPress={() => open(row)}
        trailing={<AppText variant="meta" tone="muted">{shortTime(row.lastActivityAt ?? row.updatedAt, now)}</AppText>}>
        <View style={ui.wrap}>
          <AppText variant="caption" tone="muted" numberOfLines={1}>{state.label}</AppText>
          {row.pullRequest ? <PrNumber number={row.pullRequest.number} /> : null}
          {viewers.length ? <Pill label={viewers.length === 1 ? `${memberName(viewers[0])} is here` : `${viewers.length} here`} tone="success"
            icon={{ ios: 'eye', android: 'visibility' }} /> : null}
          {target.kind === 'web' ? <Pill label="Web" icon={{ ios: 'safari', android: 'open_in_new' }} /> : null}
        </View>
      </Row>;
    })}
  </Group>;
}

function TaskGroup({ tasks }: { tasks: SpaceTaskRow[] }) {
  return <Group title="Tasks">
    {tasks.map((task, index) => <Row key={task.id} title={task.title} divider={index < tasks.length - 1}
      leading={<MemberAvatar member={task.creator} />}
      subtitle={[memberName(task.creator), task.status.replace(/_/g, ' '), task.repoFullName].filter(Boolean).join(' · ')}
      onPress={task.pullRequest ? () => openExternal(task.pullRequest!.url) : undefined}
      trailing={task.pullRequest ? <PrNumber number={task.pullRequest.number} /> : undefined} />)}
  </Group>;
}

function MemberGroup({ members, status, active }: { members: TeamMember[] | undefined; status: string; active: Set<string> }) {
  if (!members) return status === 'loading' ? <Loading label="Loading members" /> : null;
  return <Group title="Members">
    {members.map((member, index) => {
      const here = member.signedUp && active.has(member.githubLogin.toLowerCase());
      return <Row key={member.id} title={member.githubLogin} divider={index < members.length - 1}
        leading={<MemberAvatar member={member} />}
        subtitle={member.signedUp ? roleLabel(member.role) : `${roleLabel(member.role)} · Not signed up yet`}
        trailing={here ? <Pill label="Here now" tone="success" /> : undefined} />;
    })}
  </Group>;
}

function roleLabel(role: TeamMember['role']): string {
  return role === 'owner' ? 'Owner' : role === 'admin' ? 'Admin' : 'Member';
}
