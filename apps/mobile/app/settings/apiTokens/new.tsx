import { Stack } from 'expo-router';

import { CreateApiTokenScreen } from '../../../src/features/apiTokens/CreateApiTokenScreen';
import { detailOptions } from '../../../src/features/more/Page';
import { DetailRoute } from '../../../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/settings/apiTokens"><Stack.Screen options={detailOptions('Create API token')} /><CreateApiTokenScreen /></DetailRoute>;
}
