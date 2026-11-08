import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useShellColors } from '../src/components/ShellScreen';

export default function RootLayout() {
  const colors = useShellColors();
  return (
    <SafeAreaProvider>
      <Stack screenOptions={{
        headerShown: false,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.background },
      }}>
        <Stack.Screen name="+not-found" options={{ headerShown: true, title: 'Page unavailable' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
