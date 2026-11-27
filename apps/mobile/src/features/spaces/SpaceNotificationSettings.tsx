import { spaces } from '@talyn/client/native';
import { MOBILE_NOTIFICATION_CATEGORIES, type MobileNotificationCategory, type SpaceNotificationPreferences } from '@talyn/shared';
import { useRef, useState } from 'react';

import { useAuth } from '../../auth/AuthProvider';
import { Status } from '../../components/AuthControls';
import { Button, Group, Row, useActionSheet } from '../../components/UI';
import { notificationLabels, Toggle } from '../../notifications/Settings';
import { useRefreshOnFocus } from '../instructions/useRefreshOnFocus';
import { useSpaceNotificationPreferences, useTeams } from './data';

export function SpaceNotificationSettings({ offline, spaceId: selectedSpaceId }: { offline: boolean; spaceId?: string }) {
  const userId = useAuth().user?.id;
  const currentUserId = useRef(userId);
  currentUserId.current = userId;
  const teams = useTeams();
  const prefs = useSpaceNotificationPreferences();
  useRefreshOnFocus(() => { void prefs.refresh(); });
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const sheet = useActionSheet();
  const withSpaces = (teams.data ?? []).filter((team) => team.spaces.length > 0);
  if (prefs.status === 'idle') return null;
  const loadFailed = [teams.status, prefs.status].some((status) => !['ready', 'loading'].includes(status));
  const loadWarning = <>
    <Status message="Space notification settings could not load. Try again." tone="warning" />
    <Button title="Retry" disabled={offline || teams.refreshing || prefs.refreshing}
      onPress={() => { void teams.refresh(); void prefs.refresh(); }} />
  </>;
  if (loadFailed && (!teams.data || !prefs.data)) return <Group title="Team spaces">{loadWarning}</Group>;
  if (!teams.data || !prefs.data) return <Group title="Team spaces">
    <Status message="Loading space notification settings." loading />
  </Group>;
  const muted = prefs.data.mutedSpaceIds;
  const phone = prefs.data.phoneCategoriesBySpace ?? {};
  const rows = withSpaces.flatMap((team) => team.spaces.map((space) => ({
    id: space.id, label: withSpaces.length > 1 ? `${team.name} / ${space.name}` : space.name,
  })));

  const visibleIds = new Set(rows.map((row) => row.id));
  const missing = muted.filter((id) => !visibleIds.has(id));
  const missingPhone = Object.keys(phone).filter((id) => !visibleIds.has(id));
  const space = rows.find((row) => row.id === selectedSpaceId);
  if (selectedSpaceId && !space) {
    return <Group title="Team spaces">{loadFailed ? loadWarning : <Status message="This space is unavailable." />}</Group>;
  }
  if (!rows.length && !missing.length && !missingPhone.length && !loadFailed) {
    return <Group title="Team spaces"><Status message="You have no team spaces." /></Group>;
  }

  const restoreMissing = async () => {
    if (offline || pending.current || prefs.refreshing || teams.refreshing) return;
    pending.current = true;
    setSaving(true);
    setFailed(false);
    try {
      for (const spaceId of missing) {
        if (currentUserId.current !== userId) return;
        const next = await spaces.setNotificationsMuted(spaceId, false);
        prefs.mutate(() => next);
      }
      for (const spaceId of missingPhone) {
        if (currentUserId.current !== userId) return;
        const next = await spaces.setPhoneNotificationCategories(spaceId, {});
        prefs.mutate(() => next);
      }
    } catch {
      setFailed(true);
    } finally {
      if (currentUserId.current === userId) await prefs.refresh();
      pending.current = false;
      setSaving(false);
    }
  };

  const change = (request: () => Promise<SpaceNotificationPreferences>, optimistic?: SpaceNotificationPreferences) => {
    if (offline || pending.current || prefs.refreshing) return;
    const before = prefs.data;
    pending.current = true;
    setSaving(true);
    setFailed(false);
    if (optimistic) prefs.mutate(() => optimistic);
    request().then((next) => {
      if (currentUserId.current !== userId) return;
      prefs.mutate(() => next);
      void prefs.refresh();
    }, () => {
      if (currentUserId.current !== userId) return;
      if (optimistic && before) prefs.mutate(() => before);
      setFailed(true);
    }).finally(() => {
      pending.current = false;
      setSaving(false);
    });
  };

  const chooseCategory = (spaceId: string, category: MobileNotificationCategory) => {
    const current = phone[spaceId] ?? {};
    const choose = (value: boolean | undefined) => {
      const categories = { ...current };
      if (value === undefined) delete categories[category];
      else categories[category] = value;
      change(() => spaces.setPhoneNotificationCategories(spaceId, categories));
    };
    sheet.open({
      title: notificationLabels[category],
      actions: [
        { label: 'Use workspace default', selected: current[category] === undefined, onPress: () => choose(undefined) },
        { label: 'On', selected: current[category] === true, onPress: () => choose(true) },
        { label: 'Off', selected: current[category] === false, onPress: () => choose(false) },
      ],
    });
  };

  const disabled = offline || saving || prefs.refreshing;
  return <>
    {!selectedSpaceId ? <Group title="Team spaces" footer="These settings apply to your alerts in each space.">
      {loadFailed ? loadWarning : null}
      {rows.map((row, index) => <Row key={row.id} title={row.label}
        subtitle={muted.includes(row.id) ? 'Muted on all devices' : phone[row.id] ? 'Custom phone alerts' : 'Uses workspace defaults'}
        divider={index < rows.length - 1 || Boolean(missing.length || missingPhone.length)} chevron
        href={{ pathname: '/settings/notifications/space/[id]', params: { id: row.id } }} />)}
      {missing.length || missingPhone.length ? <Row title={missing.length && !missingPhone.length
        ? `${missing.length} other muted ${missing.length === 1 ? 'space' : 'spaces'}` : 'Other space settings'}
        subtitle="These spaces are archived or no longer in your teams." subtitleLines={2} divider={false}>
        <Button title={missingPhone.length ? 'Reset settings' : 'Restore alerts'} disabled={disabled || teams.refreshing}
          onPress={() => { void restoreMissing(); }} />
      </Row> : null}
    </Group> : null}
    {space ? <>
      {loadFailed ? loadWarning : null}
      {offline ? <Status message="You are offline. Notification settings need an internet connection." /> : null}
      <Group title={space.label} footer="Mute this space on your phone, desktop and browser.">
        <Toggle label="Mute space" value={muted.includes(space.id)} disabled={disabled} last
          change={(on) => change(() => spaces.setNotificationsMuted(space.id, on), {
            ...prefs.data, mutedSpaceIds: on ? [...new Set([...muted, space.id])] : muted.filter((id) => id !== space.id),
          })} />
      </Group>
      <Group title="Phone alert types" footer="Phone alerts must be enabled for the workspace. Its delivery settings and quiet hours apply here.">
        {MOBILE_NOTIFICATION_CATEGORIES.map((category, index) => {
          const value = phone[space.id]?.[category];
          return <Row key={category} title={notificationLabels[category]}
            subtitle={value === undefined ? 'Workspace default' : value ? 'On' : 'Off'}
            disabled={disabled || muted.includes(space.id)} divider={index < MOBILE_NOTIFICATION_CATEGORIES.length - 1}
            chevron onPress={() => chooseCategory(space.id, category)} />;
        })}
      </Group>
    </> : null}
    {saving ? <Status message="Saving space notification settings." loading /> : null}
    {failed ? <Status message="The space notification setting could not be saved. Try again." tone="warning" /> : null}
    {sheet.sheet}
  </>;
}
