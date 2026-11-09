import type { PropsWithChildren } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-screens/experimental';

import { useTheme } from '../theme/tokens';

export function ScreenContainer({ children, topInset = false }: PropsWithChildren<{ topInset?: boolean }>) {
  const colors = useTheme();
  return <SafeAreaView edges={{ top: topInset, left: true, right: true, bottom: true }} insetType="all"
    style={[styles.screen, { backgroundColor: colors.background }]}>{children}</SafeAreaView>;
}
const styles = StyleSheet.create({ screen: { flex: 1 } });
