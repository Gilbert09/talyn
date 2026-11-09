import { Redirect, usePathname } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';

import { rememberIntent } from '../../src/navigation/intents';
import { useShellColors } from '../../src/components/ShellScreen';
import { useWorkspace } from '../../src/auth/AuthProvider';
import { fonts } from '../../src/theme/tokens';


export default function TabsLayout() {
  const workspace = useWorkspace();
  const colors = useShellColors();
  const pathname = usePathname();
  if (!pathname.startsWith('/settings') && !workspace.selected) {
    rememberIntent(pathname);
    return <Redirect href="/workspaces" />;
  }
  return (
    <NativeTabs key={workspace.selected} backgroundColor={colors.paper} tintColor={colors.mode === 'light' ? colors.primaryAction : colors.primary}
      iconColor={{ default: colors.muted, selected: colors.mode === 'light' ? colors.primaryAction : colors.primary }}
      labelStyle={{ default: { color: colors.muted, fontSize: 12, fontFamily: fonts.sans[500] }, selected: { color: colors.mode === 'light' ? colors.primaryAction : colors.primary, fontFamily: fonts.sans[600] } }}
      indicatorColor={colors.surface} shadowColor={colors.border} disableTransparentOnScrollEdge>
      <NativeTabs.Trigger name="sessions" accessibilityLabel="Sessions" disableAutomaticContentInsets>
        <NativeTabs.Trigger.Label>Sessions</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="terminal" md="terminal" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="threads" accessibilityLabel="Threads" disableAutomaticContentInsets>
        <NativeTabs.Trigger.Label>Threads</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="bubble.left.and.bubble.right" md="chat" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="attention" accessibilityLabel="Attention" disableAutomaticContentInsets>
        <NativeTabs.Trigger.Label>Attention</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="bell" md="notifications" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings" accessibilityLabel="Settings" disableAutomaticContentInsets>
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
