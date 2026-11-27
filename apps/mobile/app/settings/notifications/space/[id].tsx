import { useLocalSearchParams } from 'expo-router';

import { useNetwork } from '../../../../src/auth/AuthProvider';
import { Page } from '../../../../src/features/more/Page';
import { SpaceNotificationSettings } from '../../../../src/features/spaces/SpaceNotificationSettings';
import { ColdBack } from '../../../../src/navigation/DetailRoute';

export default function TeamSpaceNotificationsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const offline = useNetwork() === 'offline';
  return <><ColdBack list="/settings/notifications" /><Page>
    <SpaceNotificationSettings key={id} spaceId={id} offline={offline} />
  </Page></>;
}
