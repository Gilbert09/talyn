import { SymbolView } from 'expo-symbols';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { AppText } from '../../components/UI';
import { radius, useTheme } from '../../theme/tokens';
import type { NewWorkMode } from './model';

/**
 * The session screen while its create request is in flight, like web `PendingSessionView`. The composer page switches
 * here on Start, so the person sees their session at once. The real session replaces it when the row exists.
 */
export function PendingSessionView({ mode, repository, branch, prompt, images }: {
  mode: NewWorkMode; repository?: string | null; branch?: string | null; prompt: string; images: number;
}) {
  const c = useTheme();
  const thread = mode === 'thread';
  const text = prompt.trim();
  return <View style={styles.page} testID="pending-session-view">
    <View style={[styles.header, { borderBottomColor: c.border }]}>
      <AppText variant="rowTitle" numberOfLines={1}>{thread ? 'New thread' : 'New session'}</AppText>
      {!thread && repository ? <AppText variant="meta" tone="muted" numberOfLines={1}>{branch ? `${repository} · ${branch}` : repository}</AppText> : null}
    </View>
    <View style={styles.body}>
      {text || images > 0 ? <View style={styles.userWrap}>
        <View style={[styles.bubble, { backgroundColor: c.surface }]}>
          {text ? <AppText>{text}</AppText> : null}
          {images > 0 ? <View style={styles.imageLine}>
            <SymbolView name={{ ios: 'photo', android: 'image' }} size={13} tintColor={c.muted} />
            <AppText variant="meta" tone="muted">{images === 1 ? '1 image' : `${images} images`}</AppText>
          </View> : null}
        </View>
      </View> : null}
      <View accessibilityRole="progressbar" accessible style={styles.status}>
        <ActivityIndicator size="small" color={c.muted} />
        <AppText variant="meta" tone="muted">{thread ? 'Creating the thread…' : 'Creating the session…'}</AppText>
      </View>
    </View>
    <View style={styles.dock}>
      <View style={[styles.stub, { borderColor: c.border, backgroundColor: c.elevated }]}>
        <AppText variant="meta" tone="muted">You can write more when the {thread ? 'thread' : 'session'} opens.</AppText>
      </View>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  header: { paddingHorizontal: 16, paddingVertical: 10, gap: 2, borderBottomWidth: StyleSheet.hairlineWidth },
  body: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },
  userWrap: { alignItems: 'flex-end', paddingVertical: 6 },
  bubble: { borderRadius: radius.lg, paddingHorizontal: 12, paddingVertical: 8, maxWidth: '85%', gap: 4 },
  imageLine: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  status: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 24 },
  dock: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8, width: '100%', maxWidth: 760, alignSelf: 'center' },
  stub: { borderRadius: 16, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 14, opacity: 0.6 },
});
