import { useContext, type PropsWithChildren } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { useTheme } from '../theme/tokens';

// Insets come from the JS safe-area provider. The native experimental SafeAreaView lost them after a large reload,
// which put content under the Android navigation buttons.
export function ScreenContainer({ children, topInset = false }: PropsWithChildren<{ topInset?: boolean }>) {
  const colors = useTheme();
  const insets = useContext(SafeAreaInsetsContext) ?? NO_INSETS;
  return <View style={[styles.screen, {
    backgroundColor: colors.background,
    paddingTop: topInset ? insets.top : 0,
    paddingBottom: insets.bottom,
    paddingLeft: insets.left,
    paddingRight: insets.right,
  }]}>{children}</View>;
}
const NO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };
const styles = StyleSheet.create({ screen: { flex: 1 } });
