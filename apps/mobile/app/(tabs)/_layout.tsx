import { Redirect, usePathname } from 'expo-router';

import { useWorkspace } from '../../src/auth/AuthProvider';

import { NativeTabs } from 'expo-router/native-tabs';

export default function TabsLayout() {
  const workspace = useWorkspace();
  const pathname = usePathname();
  if (!pathname.startsWith('/settings') && !workspace.selected) return <Redirect href="/workspaces" />;
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="sessions" accessibilityLabel="Sessions">
        <NativeTabs.Trigger.Label>Sessions</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="terminal" md="terminal" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="threads" accessibilityLabel="Threads">
        <NativeTabs.Trigger.Label>Threads</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="bubble.left.and.bubble.right" md="chat" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="attention" accessibilityLabel="Attention">
        <NativeTabs.Trigger.Label>Attention</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="bell" md="notifications" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings" accessibilityLabel="Settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
