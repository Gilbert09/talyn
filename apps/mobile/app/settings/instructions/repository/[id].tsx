import { Stack, useLocalSearchParams } from 'expo-router';

import { RepositoryInstructionsScreen } from '../../../../src/features/instructions/RepositoryInstructionsScreen';
import { detailOptions } from '../../../../src/features/more/Page';
import { DetailRoute } from '../../../../src/navigation/DetailRoute';

export default function Screen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DetailRoute list="/settings/instructions">
    <Stack.Screen options={detailOptions('Repository instructions')} /><RepositoryInstructionsScreen repositoryId={id} />
  </DetailRoute>;
}
