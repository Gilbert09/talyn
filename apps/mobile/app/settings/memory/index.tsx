import { Stack } from 'expo-router';

import { MemoryScreen } from '../../../src/features/memory/MemoryScreen';
import { detailOptions } from '../../../src/features/more/Page';
import { DetailRoute } from '../../../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/settings"><Stack.Screen options={detailOptions('Memory')} /><MemoryScreen /></DetailRoute>;
}
