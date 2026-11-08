import { Stack, usePathname } from 'expo-router';
import { Button } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { rememberIntent } from '../src/navigation/intents';
import { AuthProvider, useAuth, useMobileRuntime } from '../src/auth/AuthProvider';
import { Status } from '../src/components/AuthControls';
import { ShellScreen, useShellColors } from '../src/components/ShellScreen';

function AuthenticatedRoutes() {
  const auth = useAuth();
  const pathname = usePathname();
  if (auth.status !== 'signedIn') rememberIntent(pathname);
  const { auth: controller } = useMobileRuntime();
  const colors = useShellColors();
  if (auth.status === 'restoring' || auth.status === 'locked') return <ShellScreen title="Opening Talyn" description="Your account stays protected while sign-in is checked.">
    <Status message={auth.status === 'locked' ? 'Sign-in could not be restored. Check your connection and unlock this device.' : 'Restoring sign-in'} loading={auth.status === 'restoring'} />
    {auth.status === 'locked' ? <><Button title="Try again" onPress={() => { void controller.restore(); }} />
      <Button title="Clear sign-in on this device" onPress={() => { void controller.signOut(); }} /></> : null}
  </ShellScreen>;
  const signedIn = auth.status === 'signedIn';
  return <Stack screenOptions={{ headerShown: false, animation: 'none', headerStyle: { backgroundColor: colors.background },
    headerTintColor: colors.text, contentStyle: { backgroundColor: colors.background } }}>
    <Stack.Screen name="index" />
    <Stack.Screen name="auth/callback" />
    <Stack.Screen name="+not-found" options={{ headerShown: true, title: 'Page unavailable' }} />
    <Stack.Protected guard={!signedIn}><Stack.Screen name="(auth)" /></Stack.Protected>
    <Stack.Protected guard={signedIn}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="workspaces" options={{ headerShown: true, title: 'Choose a workspace' }} />
    </Stack.Protected>
  </Stack>;
}
export default function RootLayout() {
  return <SafeAreaProvider><AuthProvider><AuthenticatedRoutes /></AuthProvider></SafeAreaProvider>;
}
