import { Redirect, Stack, usePathname, useRouter, type Href } from 'expo-router';
import type { PropsWithChildren } from 'react';
import { View } from 'react-native';

import { useWorkspace } from '../auth/AuthProvider';
import { IconButton, Spinner } from '../components/UI';
import { rememberIntent } from './intents';
import { workspaceGate } from './workspaceGate';

export function WorkspaceWait() {
  return <View accessibilityState={{ busy: true }} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Spinner /></View>;
}

/**
 * Wraps a detail screen that sits on the root stack, above the tabs. It waits for
 * a workspace like the tabs do, and gives a cold deep link a way back to its list.
 */
export function DetailRoute({ list, children }: PropsWithChildren<{ list: Href }>) {
  const workspace = useWorkspace();
  const pathname = usePathname();
  const router = useRouter();
  const gate = workspaceGate(workspace);
  if (gate === 'wait') return <WorkspaceWait />;
  if (gate === 'choose') {
    rememberIntent(pathname);
    return <Redirect href="/workspaces" />;
  }
  return <>
    {router.canGoBack() ? null : <Stack.Screen options={{
      headerLeft: () => <IconButton label="Back" symbol={{ ios: 'chevron.left', android: 'arrow_back' }} onPress={() => router.replace(list)} />,
    }} />}
    {children}
  </>;
}
