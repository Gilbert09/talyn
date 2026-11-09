import { Stack } from 'expo-router';

import { HistoryScreen } from '../src/features/history/HistoryScreen';
import { detailOptions } from '../src/features/more/Page';
import { DetailRoute } from '../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/sessions"><Stack.Screen options={detailOptions('History')} /><HistoryScreen /></DetailRoute>;
}
