import { Stack } from 'expo-router';

import { IntegrationsScreen } from '../../src/features/integrations/IntegrationsScreen';
import { detailOptions } from '../../src/features/more/Page';
import { DetailRoute } from '../../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/settings"><Stack.Screen options={detailOptions('Integrations')} /><IntegrationsScreen /></DetailRoute>;
}
