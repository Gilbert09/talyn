import { Stack } from 'expo-router';

import { detailOptions } from '../src/features/more/Page';
import { RepositoriesScreen } from '../src/features/repositories/RepositoriesScreen';
import { DetailRoute } from '../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/sessions"><Stack.Screen options={detailOptions('Repositories')} /><RepositoriesScreen /></DetailRoute>;
}
