import { usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Button } from '../src/components/UI';
import { SystemChrome } from '../src/components/SystemChrome';
import { AppLoading } from '../src/navigation/AppLoading';
import { rememberIntent } from '../src/navigation/intents';
import { detailOptions } from '../src/navigation/detailOptions';
import { RootStack } from '../src/navigation/rootStack';
import { AuthProvider, useAuth, useMobileRuntime } from '../src/auth/AuthProvider';
import { AnalyticsRoot, useAnalyticsReady } from '../src/components/Analytics';
import { Status } from '../src/components/AuthControls';
import { ShellScreen, useShellColors } from '../src/components/ShellScreen';
import { UpdateBanner } from '../src/features/updates/UpdateBanner';
import { useFleetModelCatalogSync } from '../src/lib/fleetModelCatalog';
import { useAppFonts } from '../src/theme/fonts';
import { sans } from '../src/theme/tokens';

// The native splash stays up until the fonts load, so the first drawn frame is the boot screen.
void SplashScreen.preventAutoHideAsync().catch(() => {});

function AuthenticatedRoutes() {
  const auth = useAuth();
  const pathname = usePathname();
  if (auth.status !== 'signedIn') rememberIntent(pathname);
  const { auth: controller, signOut } = useMobileRuntime();
  const colors = useShellColors();
  useFleetModelCatalogSync(auth.status === 'signedIn');
  // Boot state 2 of 3: sign-in is restored. The workspace wait is in `(drawer)/_layout` and `DetailRoute`.
  if (auth.status === 'restoring') return <AppLoading phase="auth" />;
  if (auth.status === 'locked') return <ShellScreen topInset centered title="Opening Talyn" description="Your account stays protected while sign-in is checked.">
    <Status message="Sign-in could not be restored. Check your connection and unlock this device." />
    <Button title="Try again" onPress={() => { void controller.restore(); }} />
    <Button variant="quiet" title="Clear sign-in on this device" onPress={() => { void (signOut ? signOut() : controller.signOut()); }} />
  </ShellScreen>;
  const signedIn = auth.status === 'signedIn';
  return <RootStack screenOptions={{ headerShown: false, animation: 'none', headerStyle: { backgroundColor: colors.background },
    headerTintColor: colors.text, headerTitleStyle: { ...sans(600), fontSize: 16 }, headerShadowVisible: false,
    statusBarStyle: colors.mode === 'dark' ? 'light' : 'dark', contentStyle: { backgroundColor: colors.background } }}>
    <RootStack.Screen name="index" />
    <RootStack.Screen name="auth/callback" />
    <RootStack.Screen name="+not-found" options={{ headerShown: false }} />
    <RootStack.Protected guard={!signedIn}><RootStack.Screen name="(auth)" /></RootStack.Protected>
    <RootStack.Protected guard={signedIn}>
      {/* Home and its drawer. Every other page pushes above it with a native header and a back button. */}
      <RootStack.Screen name="(drawer)" />
      <RootStack.Screen name="sessions/[id]" options={detailOptions('Session')} />
      <RootStack.Screen name="threads/[id]" options={detailOptions('Thread')} />
      <RootStack.Screen name="attention/[id]" options={detailOptions('Pull request')} />
      <RootStack.Screen name="pulls/index" options={detailOptions('Pull requests')} />
      <RootStack.Screen name="spaces/index" options={detailOptions('Spaces')} />
      <RootStack.Screen name="spaces/[id]" options={detailOptions('Space')} />
      <RootStack.Screen name="integrations/index" options={detailOptions('Integrations')} />
      <RootStack.Screen name="integrations/[kind]" options={detailOptions('Integration')} />
      <RootStack.Screen name="integrations/[kind]/[id]" options={detailOptions('Automation')} />
      <RootStack.Screen name="automations/index" options={{ headerShown: false }} />
      <RootStack.Screen name="automations/[id]" options={{ headerShown: false }} />
      <RootStack.Screen name="automations/workflows/[id]" options={{ headerShown: false }} />
      <RootStack.Screen name="automations/loops/[id]" options={{ headerShown: false }} />
      <RootStack.Screen name="usage" options={detailOptions('Usage')} />
      <RootStack.Screen name="billing/index" options={detailOptions('Plan and billing')} />
      <RootStack.Screen name="billing/return" options={{ headerShown: false, animation: 'fade' }} />
      <RootStack.Screen name="agents" options={detailOptions('Agents')} />
      <RootStack.Screen name="insights" options={detailOptions('Insights')} />
      <RootStack.Screen name="history" options={detailOptions('History')} />
      {/* The screen draws its own "Settings" heading. */}
      <RootStack.Screen name="settings" options={detailOptions('Settings')} />
      {/* Settings editors. Screens with a dynamic title set it themselves. */}
      <RootStack.Screen name="settings/sandboxSetup" options={detailOptions('Sandbox setup')} />
      <RootStack.Screen name="settings/privateRoutes" options={detailOptions('Private routes')} />
      <RootStack.Screen name="settings/mcp/index" options={detailOptions('MCP servers')} />
      <RootStack.Screen name="settings/mcp/[id]" options={detailOptions('MCP server')} />
      <RootStack.Screen name="settings/apiTokens/index" options={detailOptions('API tokens')} />
      <RootStack.Screen name="settings/apiTokens/new" options={detailOptions('Create API token')} />
      <RootStack.Screen name="settings/slack" options={detailOptions('Slack')} />
      <RootStack.Screen name="settings/integrations" options={detailOptions('Integrations')} />
      <RootStack.Screen name="settings/github" options={{ headerShown: false }} />
      <RootStack.Screen name="settings/skills/index" options={detailOptions('Skills')} />
      <RootStack.Screen name="settings/skills/[id]" options={detailOptions('Skill')} />
      <RootStack.Screen name="settings/skills/repo" options={detailOptions('Repo skill')} />
      <RootStack.Screen name="settings/instructions/index" options={detailOptions('Instructions')} />
      <RootStack.Screen name="settings/instructions/prompt/[kind]" options={detailOptions('Prompt')} />
      <RootStack.Screen name="settings/instructions/repository/[id]" options={detailOptions('Repository instructions')} />
      <RootStack.Screen name="settings/memory/index" options={detailOptions('Memory')} />
      <RootStack.Screen name="settings/memory/[id]" options={detailOptions('Memory')} />
      <RootStack.Screen name="settings/codeReview" options={detailOptions('Code review')} />
      <RootStack.Screen name="workspaces" options={detailOptions('Workspace')} />
      <RootStack.Screen name="repositories" options={detailOptions('Repositories')} />
      {/* Setup draws its own heading and steps, with no navigation header. */}
      <RootStack.Screen name="onboarding" options={{ headerShown: false, animation: 'fade', gestureEnabled: false }} />
      {/* The GitHub install flow's return link. It steps back at once. */}
      <RootStack.Screen name="github/callback" options={{ headerShown: false, animation: 'none' }} />
      {/* Settings sign-in return links. Each steps back at once. */}
      <RootStack.Screen name="mcp/callback" options={{ headerShown: false, animation: 'none' }} />
      <RootStack.Screen name="slack/callback" options={{ headerShown: false, animation: 'none' }} />
      <RootStack.Screen name="posthog/callback" options={{ headerShown: false, animation: 'none' }} />
      <RootStack.Screen name="new" options={{ ...detailOptions('New'), animation: 'slide_from_bottom' }} />
    </RootStack.Protected>
  </RootStack>;
}

export default function RootLayout() {
  const fonts = useAppFonts();
  // The saved analytics opt-out is read before the first screen, so an opted-out person sends nothing.
  const analytics = useAnalyticsReady();
  const colors = useShellColors();
  useEffect(() => { if (fonts) void SplashScreen.hideAsync().catch(() => {}); }, [fonts]);
  // The root paints the app background, so the area under a transparent status bar never shows grey.
  return <GestureHandlerRootView style={[styles.root, { backgroundColor: colors.background }]}>
    {/* Boot state 1 of 3: the bundled fonts load, which takes about one frame. */}
    {!fonts || !analytics ? <AppLoading phase="fonts" /> : <AnalyticsRoot><SafeAreaProvider style={{ backgroundColor: colors.background }}>
      <SystemChrome /><AuthProvider><AuthenticatedRoutes /></AuthProvider>
      {/* Over every screen, and never a modal: it offers a restart and does not take one. */}
      <UpdateBanner />
    </SafeAreaProvider></AnalyticsRoot>}
  </GestureHandlerRootView>;
}

const styles = StyleSheet.create({ root: { flex: 1 } });
