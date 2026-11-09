import { Stack } from 'expo-router';

import { AgentsScreen } from '../src/features/agents/AgentsScreen';
import { detailOptions } from '../src/features/more/Page';
import { DetailRoute } from '../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/sessions"><Stack.Screen options={detailOptions('Agents')} /><AgentsScreen /></DetailRoute>;
}
