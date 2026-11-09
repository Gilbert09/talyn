import { Stack } from 'expo-router';

import { detailOptions } from '../../src/features/more/Page';
import { SlackScreen } from '../../src/features/slack/SlackScreen';
import { DetailRoute } from '../../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/settings"><Stack.Screen options={detailOptions('Slack')} /><SlackScreen /></DetailRoute>;
}
