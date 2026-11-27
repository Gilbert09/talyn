import { useLocalSearchParams } from 'expo-router';
import { useSyncExternalStore } from 'react';

import { useMobileRuntime, useWorkspace } from '../../../../src/auth/AuthProvider';
import { Status } from '../../../../src/components/AuthControls';
import { Group } from '../../../../src/components/UI';
import { Intro, Page } from '../../../../src/features/more/Page';
import { ColdBack } from '../../../../src/navigation/DetailRoute';
import { NotificationSettings } from '../../../../src/notifications/Settings';

export default function WorkspaceNotificationsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { choices, status } = useWorkspace();
  const { lifecycle, notifications } = useMobileRuntime();
  const { activity, reachability } = useSyncExternalStore(lifecycle.subscribe, lifecycle.getSnapshot, lifecycle.getSnapshot);
  const workspace = choices.find((choice) => choice.id === id);
  const loading = status === 'idle' || status === 'loading';

  return <><ColdBack list="/settings/notifications" /><Page>
    {workspace ? <>
      <Intro>{workspace.name}</Intro>
      <NotificationSettings key={workspace.id} controller={notifications} workspaceId={workspace.id}
        foreground={activity === 'active'} offline={reachability === 'offline'} />
    </> : <Group>
      <Status message={loading ? 'Loading workspaces' : 'This workspace is unavailable.'} loading={loading} />
    </Group>}
  </Page></>;
}
