import { View } from 'react-native';

import { BootScreen } from '../components/BootScreen';
import { useTheme } from '../theme/tokens';

/** Why the app is not ready to draw a screen yet. */
export type LoadingPhase = 'fonts' | 'auth' | 'workspace';

const LABELS: Record<Exclude<LoadingPhase, 'fonts'>, string> = {
  auth: 'Restoring sign-in',
  workspace: 'Loading your workspace',
};

/**
 * The one loading screen of the app: while fonts load, while sign-in is
 * restored, and while the saved workspace loads. The native splash covers the
 * font phase, so that phase draws only the background.
 */
export function AppLoading({ phase }: { phase: LoadingPhase }) {
  const c = useTheme();
  if (phase === 'fonts') return <View accessibilityState={{ busy: true }} style={{ flex: 1, backgroundColor: c.background }} />;
  return <BootScreen label={LABELS[phase]} />;
}
