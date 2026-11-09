import { Stack } from 'expo-router';

import { UsageScreen } from '../src/features/usage/UsageScreen';
import { detailOptions } from '../src/features/more/Page';
import { DetailRoute } from '../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/sessions"><Stack.Screen options={detailOptions('Usage')} /><UsageScreen /></DetailRoute>;
}
