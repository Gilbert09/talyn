import { Stack } from 'expo-router';

import { useShellColors } from './ShellScreen';

export function TabStack({ title, detailTitle }: { title: string; detailTitle?: string }) {
  const colors = useShellColors();
  return (
    <Stack screenOptions={{
      headerStyle: { backgroundColor: colors.background },
      headerTintColor: colors.text,
      headerShadowVisible: false,
      statusBarStyle: colors.mode === 'dark' ? 'light' : 'dark',
      contentStyle: { backgroundColor: colors.background },
    }}>
      <Stack.Screen name="index" options={{ title, headerShown: false }} />
      {detailTitle ? <Stack.Screen name="[id]" options={{ title: detailTitle }} /> : null}
    </Stack>
  );
}
