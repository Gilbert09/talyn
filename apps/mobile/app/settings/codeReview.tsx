import { Stack } from 'expo-router';

import { CodeReviewSettingsScreen } from '../../src/features/codeReviewSettings/CodeReviewSettingsScreen';
import { detailOptions } from '../../src/features/more/Page';
import { DetailRoute } from '../../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/settings"><Stack.Screen options={detailOptions('Code review')} /><CodeReviewSettingsScreen /></DetailRoute>;
}
