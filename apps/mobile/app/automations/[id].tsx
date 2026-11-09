import { Stack } from 'expo-router';

import { AutomationDetailScreen } from '../../src/features/automations/AutomationDetailScreen';
import { detailOptions } from '../../src/features/more/Page';
import { DetailRoute } from '../../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/automations"><Stack.Screen options={detailOptions('Automation')} /><AutomationDetailScreen /></DetailRoute>;
}
