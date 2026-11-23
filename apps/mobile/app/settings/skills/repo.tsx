import { Stack, useLocalSearchParams } from 'expo-router';

import { detailOptions } from '../../../src/features/more/Page';
import { RepoSkillScreen } from '../../../src/features/skills/RepoSkillScreen';
import { DetailRoute } from '../../../src/navigation/DetailRoute';

export default function Screen() {
  const { repositoryId, name } = useLocalSearchParams<{ repositoryId: string; name: string }>();
  return <DetailRoute list="/settings/skills">
    <Stack.Screen options={detailOptions('Repo skill')} /><RepoSkillScreen repositoryId={repositoryId} name={name} />
  </DetailRoute>;
}
