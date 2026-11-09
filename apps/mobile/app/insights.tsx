import { Stack } from 'expo-router';

import { InsightsScreen } from '../src/features/insights/InsightsScreen';
import { detailOptions } from '../src/features/more/Page';
import { DetailRoute } from '../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/sessions"><Stack.Screen options={detailOptions('Insights')} /><InsightsScreen /></DetailRoute>;
}
