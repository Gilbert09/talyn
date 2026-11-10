import { Stack } from 'expo-router';

import { detailOptions } from '../../src/features/more/Page';
import { GitHubSettingsScreen } from '../../src/features/settings/GitHubSettingsScreen';
import { DetailRoute } from '../../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/settings"><Stack.Screen options={detailOptions('GitHub')} /><GitHubSettingsScreen /></DetailRoute>;
}
