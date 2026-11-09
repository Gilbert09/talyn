import { Redirect, Stack, usePathname, useRouter, type Href } from 'expo-router';
import type { PropsWithChildren } from 'react';

import { useWorkspace } from '../auth/AuthProvider';
import { IconButton } from '../components/UI';
import { AppLoading } from './AppLoading';
import { rememberIntent } from './intents';
import { workspaceGate } from './workspaceGate';

export function WorkspaceWait() {
  return <AppLoading phase="workspace" />;
}

/**
 * Wraps a screen that sits on the root stack, above the drawer. It waits for
 * a workspace like home does, and gives a cold deep link a way back to `list`.
 */
export function DetailRoute({ list, children }: PropsWithChildren<{ list: Href }>) {
  const workspace = useWorkspace();
  const pathname = usePathname();
  const gate = workspaceGate(workspace);
  if (gate === 'wait') return <WorkspaceWait />;
  if (gate === 'choose') {
    rememberIntent(pathname);
    return <Redirect href="/workspaces" />;
  }
  return <>
    <ColdBack list={list} />
    {children}
  </>;
}

/** A back button for a screen opened with nothing under it, such as a cold deep link. */
export function ColdBack({ list }: { list: Href }) {
  const router = useRouter();
  if (router.canGoBack()) return null;
  return <Stack.Screen options={{
    headerLeft: () => <IconButton label="Back" symbol={{ ios: 'chevron.left', android: 'arrow_back' }} onPress={() => router.replace(list)} />,
  }} />;
}
