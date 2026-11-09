import { Stack } from 'expo-router';

import { detailOptions } from '../../src/features/more/Page';
import { SpaceDetailScreen } from '../../src/features/spaces/SpaceDetailScreen';
import { DetailRoute } from '../../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/spaces"><Stack.Screen options={detailOptions('Space')} /><SpaceDetailScreen /></DetailRoute>;
}
