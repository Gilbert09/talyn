import { Stack } from 'expo-router';

import { detailOptions } from '../../src/features/more/Page';
import { WhatsNewScreen } from '../../src/features/whatsNew/WhatsNewScreen';
import { ColdBack } from '../../src/navigation/DetailRoute';

// Release notes are global and need no workspace, so this skips DetailRoute's workspace gate, like Settings.
export default function Screen() {
  return <><ColdBack list="/settings" /><Stack.Screen options={detailOptions("What's new")} /><WhatsNewScreen /></>;
}
