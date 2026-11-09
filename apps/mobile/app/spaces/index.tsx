import { Stack } from 'expo-router';

import { detailOptions } from '../../src/features/more/Page';
import { SpacesScreen } from '../../src/features/spaces/SpacesScreen';
import { DetailRoute } from '../../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/sessions"><Stack.Screen options={detailOptions('Spaces')} /><SpacesScreen /></DetailRoute>;
}
