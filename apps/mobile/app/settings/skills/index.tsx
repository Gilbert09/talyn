import { Stack } from 'expo-router';

import { detailOptions } from '../../../src/features/more/Page';
import { SkillsScreen } from '../../../src/features/skills/SkillsScreen';
import { DetailRoute } from '../../../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/settings"><Stack.Screen options={detailOptions('Skills')} /><SkillsScreen /></DetailRoute>;
}
