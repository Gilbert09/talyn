import { Stack } from 'expo-router';

import { useShellColors } from './ShellScreen';

export function TabStack({ title, detailTitle }: { title: string; detailTitle?: string }) {
  const colors = useShellColors();
  return (
    <Stack screenOptions={{
      headerStyle: { backgroundColor: colors.background },
      headerTintColor: colors.text,
      contentStyle: { backgroundColor: colors.background },
    }}>
      <Stack.Screen name="index" options={{ title }} />
      {detailTitle ? <Stack.Screen name="[id]" options={{ title: detailTitle }} /> : null}
    </Stack>
  );
}
