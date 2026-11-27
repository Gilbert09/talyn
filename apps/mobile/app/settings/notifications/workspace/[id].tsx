import { useLocalSearchParams } from 'expo-router';

import { useMobileRuntime, useNetwork, useWorkspace } from '../../../../src/auth/AuthProvider';
import { Status } from '../../../../src/components/AuthControls';
import { Group } from '../../../../src/components/UI';
import { Intro, Page } from '../../../../src/features/more/Page';
import { ColdBack } from '../../../../src/navigation/DetailRoute';
import { NotificationSettings } from '../../../../src/notifications/Settings';

export default function WorkspaceNotificationsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { choices, status } = useWorkspace();
  const { notifications } = useMobileRuntime();
  const offline = useNetwork() === 'offline';
  const workspace = choices.find((choice) => choice.id === id);
  const loading = status === 'idle' || status === 'loading';

  return <><ColdBack list="/settings/notifications" /><Page>
    {workspace ? <>
      <Intro>{workspace.name}</Intro>
      <NotificationSettings key={workspace.id} controller={notifications} workspaceId={workspace.id} offline={offline} />
    </> : <Group>
      <Status message={loading ? 'Loading workspaces' : 'This workspace is unavailable.'} loading={loading} />
    </Group>}
  </Page></>;
}
