import type { CloudProviderInfo } from '@talyn/client/native';
import { fleetReconnectMessage } from '@talyn/shared';
import { useRouter } from 'expo-router';

import { Banner } from '../../components/UI';
import { useResource } from '../../workflow/hooks';

export function FleetReconnectNotice() {
  const providers = useResource<CloudProviderInfo[]>('providers');
  const router = useRouter();
  const message = fleetReconnectMessage(providers.data?.find((provider) => provider.type === 'selfhosted'));
  return message ? <Banner tone="warning" message={message} action="Reconnect" onAction={() => router.push('/agents')} /> : null;
}
