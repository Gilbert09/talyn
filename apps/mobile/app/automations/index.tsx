import { Stack } from 'expo-router';

import { AutomationsScreen } from '../../src/features/automations/AutomationsScreen';
import { detailOptions } from '../../src/features/more/Page';
import { DetailRoute } from '../../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/sessions"><Stack.Screen options={detailOptions('Automations')} /><AutomationsScreen /></DetailRoute>;
}
