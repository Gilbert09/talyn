import { Stack, usePathname } from 'expo-router';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Button } from '../src/components/UI';
import { SystemChrome } from '../src/components/SystemChrome';
import { rememberIntent } from '../src/navigation/intents';
import { AuthProvider, useAuth, useMobileRuntime } from '../src/auth/AuthProvider';
import { Status } from '../src/components/AuthControls';
import { ShellScreen, useShellColors } from '../src/components/ShellScreen';
import { useAppFonts } from '../src/theme/fonts';
import { sans } from '../src/theme/tokens';

function AuthenticatedRoutes() {
  const auth = useAuth();
  const pathname = usePathname();
  if (auth.status !== 'signedIn') rememberIntent(pathname);
  const { auth: controller, signOut } = useMobileRuntime();
  const colors = useShellColors();
  if (auth.status === 'restoring' || auth.status === 'locked') return <ShellScreen topInset centered title="Opening Talyn" description="Your account stays protected while sign-in is checked.">
    <Status message={auth.status === 'locked' ? 'Sign-in could not be restored. Check your connection and unlock this device.' : 'Restoring sign-in'} loading={auth.status === 'restoring'} />
    {auth.status === 'locked' ? <><Button title="Try again" onPress={() => { void controller.restore(); }} />
      <Button variant="quiet" title="Clear sign-in on this device" onPress={() => { void (signOut ? signOut() : controller.signOut()); }} /></> : null}
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
      <Stack.Screen name="(tabs)" />
      {/* Details sit above the tabs, so the tab bar is hidden and the header has a back button. */}
      <Stack.Screen name="sessions/[id]" options={detail('Session')} />
      <Stack.Screen name="threads/[id]" options={detail('Thread')} />
      <Stack.Screen name="attention/[id]" options={detail('Pull request')} />
      <Stack.Screen name="workspaces" options={detail('Workspace')} />
    </Stack.Protected>
  </Stack>;
}
export default function RootLayout() {
  const fonts = useAppFonts();
  const colors = useShellColors();
  // The fonts are bundled, so this is one frame of the app background.
  if (!fonts) return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  return <SafeAreaProvider><SystemChrome /><AuthProvider><AuthenticatedRoutes /></AuthProvider></SafeAreaProvider>;
}
