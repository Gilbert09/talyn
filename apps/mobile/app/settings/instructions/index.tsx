import { Stack } from 'expo-router';

import { InstructionsScreen } from '../../../src/features/instructions/InstructionsScreen';
import { detailOptions } from '../../../src/features/more/Page';
import { DetailRoute } from '../../../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/settings"><Stack.Screen options={detailOptions('Instructions')} /><InstructionsScreen /></DetailRoute>;
}
