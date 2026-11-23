import { Stack, useLocalSearchParams } from 'expo-router';

import { detailOptions } from '../../../src/features/more/Page';
import { NEW_SKILL_ID, SkillEditorScreen } from '../../../src/features/skills/SkillEditorScreen';
import { DetailRoute } from '../../../src/navigation/DetailRoute';

export default function Screen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DetailRoute list="/settings/skills">
    <Stack.Screen options={detailOptions(id === NEW_SKILL_ID ? 'New skill' : 'Edit skill')} /><SkillEditorScreen id={id} />
  </DetailRoute>;
}
