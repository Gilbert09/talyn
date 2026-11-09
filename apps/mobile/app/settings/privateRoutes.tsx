import { Stack } from 'expo-router';

import { detailOptions } from '../../src/features/more/Page';
import { PrivateRoutesScreen } from '../../src/features/privateRoutes/PrivateRoutesScreen';
import { DetailRoute } from '../../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/settings"><Stack.Screen options={detailOptions('Private routes')} /><PrivateRoutesScreen /></DetailRoute>;
}
