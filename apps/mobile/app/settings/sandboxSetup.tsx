import { Stack } from 'expo-router';

import { detailOptions } from '../../src/features/more/Page';
import { SandboxSetupScreen } from '../../src/features/sandboxSetup/SandboxSetupScreen';
import { DetailRoute } from '../../src/navigation/DetailRoute';

export default function Screen() {
  return <DetailRoute list="/settings"><Stack.Screen options={detailOptions('Sandbox setup')} /><SandboxSetupScreen /></DetailRoute>;
}
