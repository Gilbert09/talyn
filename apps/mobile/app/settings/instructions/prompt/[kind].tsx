import { PROMPT_KIND_INFO } from '@talyn/shared';
import { Stack, useLocalSearchParams } from 'expo-router';

import { isPromptKind } from '../../../../src/features/instructions/model';
import { PromptEditorScreen } from '../../../../src/features/instructions/PromptEditorScreen';
import { detailOptions } from '../../../../src/features/more/Page';
import { DetailRoute } from '../../../../src/navigation/DetailRoute';

export default function Screen() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  const title = isPromptKind(kind) ? `${PROMPT_KIND_INFO[kind].label} prompt` : 'Prompt';
  return <DetailRoute list="/settings/instructions">
    <Stack.Screen options={detailOptions(title)} /><PromptEditorScreen kind={kind} />
  </DetailRoute>;
}
