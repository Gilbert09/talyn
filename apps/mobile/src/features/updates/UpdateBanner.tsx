import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText, Button, IconButton } from '../../components/UI';
import { radius, useTheme } from '../../theme/tokens';
import { appUpdates, useAppUpdates, useUpdateChecks } from './appUpdates';
import type { UpdateController } from './controller';
import { showsReadyBanner } from './model';

/**
 * Runs the update checks and, when an update is downloaded, offers a restart. It never restarts by itself,
 * so a person writing a message keeps their place. A closed banner leaves the update to the next cold start.
 */
export function UpdateBanner({ controller = appUpdates() }: { controller?: UpdateController }) {
  useUpdateChecks(controller);
  const updates = useAppUpdates(controller);
  const insets = useSafeAreaInsets();
  const c = useTheme();
  if (!showsReadyBanner(updates)) return null;
  const rollback = updates.ready?.updateId === null;
  return <View pointerEvents="box-none" style={[styles.overlay, { top: insets.top + 8 }]}>
    <View testID="update-banner" style={[styles.banner, { backgroundColor: c.elevated, borderColor: c.border }]}>
      <AppText accessibilityRole="alert" accessibilityLiveRegion="polite" variant="meta" style={styles.text}>
        {rollback ? 'Talyn needs a restart to return to the built-in version.' : 'Update ready. Restart Talyn to use it.'}
      </AppText>
      <Button title="Restart" size="sm" accessibilityLabel="Restart Talyn to apply the update" onPress={() => { void updates.restart(); }} />
      <IconButton label="Restart later" symbol={{ ios: 'xmark', android: 'close' }} size={16} onPress={updates.dismiss} />
    </View>
  </View>;
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', left: 12, right: 12, alignItems: 'center' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 4, paddingVertical: 4,
    borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, maxWidth: 520, width: '100%' },
  text: { flex: 1 },
});
