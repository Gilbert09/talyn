import { Stack } from 'expo-router';

import { CatalogScreen } from '../../src/features/integrations/CatalogScreen';
import { detailOptions } from '../../src/features/more/Page';
import { DetailRoute } from '../../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/sessions"><Stack.Screen options={detailOptions('Integrations')} /><CatalogScreen /></DetailRoute>;
}
