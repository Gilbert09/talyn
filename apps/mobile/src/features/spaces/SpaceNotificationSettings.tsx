import { spaces } from '@talyn/client/native';
import { useRef, useState } from 'react';

import { Status } from '../../components/AuthControls';
import { Button, Group } from '../../components/UI';
import { Toggle } from '../../notifications/Settings';
import { useSpaceNotificationPreferences, useTeams } from './data';

/** Personal preferences apply to every device. */
export function SpaceNotificationSettings({ offline }: { offline: boolean }) {
  const teams = useTeams();
  const prefs = useSpaceNotificationPreferences();
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const withSpaces = (teams.data ?? []).filter((team) => team.spaces.length > 0);
  if (prefs.status === 'idle') return null;
  const loadFailed = [teams.status, prefs.status].some((status) => !['ready', 'loading'].includes(status));
  if (loadFailed) return <Group title="Team spaces">
    <Status message="Space notification settings could not load. Try again." tone="warning" />
    <Button title="Retry" disabled={offline || teams.refreshing || prefs.refreshing}
      onPress={() => { void teams.refresh(); void prefs.refresh(); }} />
  </Group>;
  if (!teams.data || !prefs.data) return <Group title="Team spaces">
    <Status message="Loading space notification settings." loading />
  </Group>;
  if (!withSpaces.length) return null;
  const muted = prefs.data.mutedSpaceIds;
  const rows = withSpaces.flatMap((team) => team.spaces.map((space) => ({
    id: space.id, label: withSpaces.length > 1 ? `${team.name} / ${space.name}` : space.name,
  })));

  const change = (spaceId: string, on: boolean) => {
    if (offline || pending.current || prefs.refreshing) return;
    const before = muted;
    pending.current = true;
    setSaving(true);
    setFailed(false);
    prefs.mutate(() => ({ mutedSpaceIds: on ? before.filter((id) => id !== spaceId) : [...new Set([...before, spaceId])] }));
    spaces.setNotificationsMuted(spaceId, !on).then((next) => {
      prefs.mutate(() => next);
      void prefs.refresh();
    }, () => {
      prefs.mutate((current) => ({ mutedSpaceIds: before.includes(spaceId)
        ? [...new Set([...current.mutedSpaceIds, spaceId])]
        : current.mutedSpaceIds.filter((id) => id !== spaceId) }));
      setFailed(true);
    }).finally(() => {
      pending.current = false;
      setSaving(false);
    });
  };

  return <>
    <Group title="Team spaces" footer="Control alerts for each space on all your devices. Turn a space off to mute its alerts for you.">
      {rows.map((row, index) => <Toggle key={row.id} label={row.label} value={!muted.includes(row.id)} disabled={offline || saving || prefs.refreshing}
        last={index === rows.length - 1} change={(on) => change(row.id, on)} />)}
    </Group>
    {saving ? <Status message="Saving space notification settings." loading /> : null}
    {failed ? <Status message="The space notification setting could not be saved. Try again." tone="warning" /> : null}
  </>;
}
