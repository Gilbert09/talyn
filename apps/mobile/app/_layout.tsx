import { Stack, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Button } from '../src/components/UI';
import { SystemChrome } from '../src/components/SystemChrome';
import { AppLoading } from '../src/navigation/AppLoading';
import { rememberIntent } from '../src/navigation/intents';
import { AuthProvider, useAuth, useMobileRuntime } from '../src/auth/AuthProvider';
import { AnalyticsRoot, useAnalyticsReady } from '../src/components/Analytics';
import { Status } from '../src/components/AuthControls';
import { ShellScreen, useShellColors } from '../src/components/ShellScreen';
import { UpdateBanner } from '../src/features/updates/UpdateBanner';
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
  // Boot state 2 of 3: sign-in is restored. The workspace wait is in `(drawer)/_layout` and `DetailRoute`.
  if (auth.status === 'restoring') return <AppLoading phase="auth" />;
  if (auth.status === 'locked') return <ShellScreen topInset centered title="Opening Talyn" description="Your account stays protected while sign-in is checked.">
    <Status message="Sign-in could not be restored. Check your connection and unlock this device." />
    <Button title="Try again" onPress={() => { void controller.restore(); }} />
    <Button variant="quiet" title="Clear sign-in on this device" onPress={() => { void (signOut ? signOut() : controller.signOut()); }} />
  </ShellScreen>;
  const signedIn = auth.status === 'signedIn';
  const detail = (title: string) => ({ headerShown: true, title, animation: 'default' as const, headerBackTitle: 'Back' });
  return <Stack screenOptions={{ headerShown: false, animation: 'none', headerStyle: { backgroundColor: colors.background },
    headerTintColor: colors.text, headerTitleStyle: { ...sans(600), fontSize: 16 }, headerShadowVisible: false,
    statusBarStyle: colors.mode === 'dark' ? 'light' : 'dark', contentStyle: { backgroundColor: colors.background } }}>
    <Stack.Screen name="index" />
    <Stack.Screen name="auth/callback" />
    <Stack.Screen name="+not-found" options={{ headerShown: false }} />
    <Stack.Protected guard={!signedIn}><Stack.Screen name="(auth)" /></Stack.Protected>
    <Stack.Protected guard={signedIn}>
      {/* Home and its drawer. Every other page pushes above it with a native header and a back button. */}
      <Stack.Screen name="(drawer)" />
      <Stack.Screen name="sessions/[id]" options={detail('Session')} />
      <Stack.Screen name="threads/[id]" options={detail('Thread')} />
      <Stack.Screen name="attention/[id]" options={detail('Pull request')} />
      <Stack.Screen name="pulls/index" options={detail('Pull requests')} />
      <Stack.Screen name="spaces/index" options={detail('Spaces')} />
      <Stack.Screen name="spaces/[id]" options={detail('Space')} />
      <Stack.Screen name="automations/index" options={detail('Automations')} />
      <Stack.Screen name="automations/[id]" options={detail('Automation')} />
      <Stack.Screen name="usage" options={detail('Usage')} />
      <Stack.Screen name="billing/index" options={detail('Plan and billing')} />
      <Stack.Screen name="billing/return" options={{ headerShown: false, animation: 'fade' }} />
      <Stack.Screen name="agents" options={detail('Agents')} />
      <Stack.Screen name="insights" options={detail('Insights')} />
      <Stack.Screen name="history" options={detail('History')} />
      {/* The screen draws its own "Settings" heading. */}
      <Stack.Screen name="settings" options={detail('Settings')} />
      {/* Settings editors. Screens with a dynamic title set it themselves. */}
      <Stack.Screen name="settings/sandboxSetup" options={detail('Sandbox setup')} />
      <Stack.Screen name="settings/privateRoutes" options={detail('Private routes')} />
      <Stack.Screen name="settings/mcp/index" options={detail('MCP servers')} />
      <Stack.Screen name="settings/mcp/[id]" options={detail('MCP server')} />
      <Stack.Screen name="settings/apiTokens/index" options={detail('API tokens')} />
      <Stack.Screen name="settings/apiTokens/new" options={detail('Create API token')} />
      <Stack.Screen name="settings/slack" options={detail('Slack')} />
      <Stack.Screen name="settings/integrations" options={detail('Integrations')} />
      <Stack.Screen name="settings/skills/index" options={detail('Skills')} />
      <Stack.Screen name="settings/skills/[id]" options={detail('Skill')} />
      <Stack.Screen name="settings/skills/repo" options={detail('Repo skill')} />
      <Stack.Screen name="settings/instructions/index" options={detail('Instructions')} />
      <Stack.Screen name="settings/instructions/prompt/[kind]" options={detail('Prompt')} />
      <Stack.Screen name="settings/instructions/repository/[id]" options={detail('Repository instructions')} />
      <Stack.Screen name="settings/memory/index" options={detail('Memory')} />
      <Stack.Screen name="settings/memory/[id]" options={detail('Memory')} />
      <Stack.Screen name="settings/codeReview" options={detail('Code review')} />
      <Stack.Screen name="workspaces" options={detail('Workspace')} />
      <Stack.Screen name="repositories" options={detail('Repositories')} />
      {/* Setup draws its own heading and steps, with no navigation header. */}
      <Stack.Screen name="onboarding" options={{ headerShown: false, animation: 'fade', gestureEnabled: false }} />
      {/* The GitHub install flow's return link. It steps back at once. */}
      <Stack.Screen name="github/callback" options={{ headerShown: false, animation: 'none' }} />
      {/* Settings sign-in return links. Each steps back at once. */}
      <Stack.Screen name="mcp/callback" options={{ headerShown: false, animation: 'none' }} />
      <Stack.Screen name="slack/callback" options={{ headerShown: false, animation: 'none' }} />
      <Stack.Screen name="posthog/callback" options={{ headerShown: false, animation: 'none' }} />
      <Stack.Screen name="new" options={{ ...detail('New'), animation: 'slide_from_bottom' }} />
    </Stack.Protected>
  </Stack>;
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
