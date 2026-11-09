import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Status } from '../components/AuthControls';
import { useTheme } from '../theme/tokens';

/** Why the app is not ready to draw a screen yet. */
export type LoadingPhase = 'fonts' | 'auth' | 'workspace';

/**
 * The one loading screen of the app: while fonts load, while sign-in is
 * restored, and while the saved workspace loads. Swap the body here to change
 * every boot state at once.
 */
export function AppLoading({ phase }: { phase: LoadingPhase }) {
  const c = useTheme();
  // Fonts are not ready in the first phase, so it draws no text.
  return <View accessibilityState={{ busy: true }} style={[styles.screen, { backgroundColor: c.background }]}>
    {phase === 'fonts' ? null : phase === 'auth'
      ? <View style={styles.status}><Status message="Restoring sign-in" loading /></View>
      : <ActivityIndicator accessibilityLabel="Loading" color={c.muted} />}
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  status: { width: '100%', maxWidth: 420 },
});
