import { Stack, useLocalSearchParams } from 'expo-router';

import { MemoryEditorScreen, NEW_MEMORY_ID } from '../../../src/features/memory/MemoryEditorScreen';
import { detailOptions } from '../../../src/features/more/Page';
import { DetailRoute } from '../../../src/navigation/DetailRoute';

export default function Screen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DetailRoute list="/settings/memory">
    <Stack.Screen options={detailOptions(id === NEW_MEMORY_ID ? 'Add memory' : 'Memory')} /><MemoryEditorScreen id={id} />
  </DetailRoute>;
}
