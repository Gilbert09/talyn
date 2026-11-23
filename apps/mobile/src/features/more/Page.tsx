import { SymbolView } from 'expo-symbols';
import type { PropsWithChildren, ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { ScreenContainer } from '../../components/ScreenContainer';
import { AppText, Row, Spinner, toneColor, type Tone } from '../../components/UI';
import { openExternal } from '../../components/Workflow';
import { radius, useTheme } from '../../theme/tokens';
import { WEB_APP_URL } from '../settings/about';

/** A page of Talyn on the web, for the screens that leave editing there. */
export function webUrl(path: string): string {
  return `${WEB_APP_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

export { detailOptions } from '../../navigation/detailOptions';

/** A scrolling detail screen with pull-to-refresh. The native header carries the title. */
export function Page({ children, refreshing = false, onRefresh }: PropsWithChildren<{ refreshing?: boolean; onRefresh?(): void }>) {
  const c = useTheme();
  return <ScreenContainer>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh}
        tintColor={c.muted} colors={[c.primaryAction]} progressBackgroundColor={c.elevated} /> : undefined}>
      {children}
    </ScrollView>
  </ScreenContainer>;
}

/** A short muted intro line under the header. */
export function Intro({ children }: PropsWithChildren) {
  return <AppText variant="meta" tone="muted" style={{ paddingHorizontal: 4 }}>{children}</AppText>;
}

/** First load: a centred spinner and a word, like `StateNotice`. */
export function Loading({ label = 'Loading' }: { label?: string }) {
  return <View accessibilityState={{ busy: true }} style={styles.loading}><Spinner /><AppText variant="meta" tone="muted">{label}</AppText></View>;
}

/** "Edit on the web"-style row. Confirms before it leaves the app. */
export function WebRow({ title, path, divider = false, subtitle }: { title: string; path: string; divider?: boolean; subtitle?: ReactNode }) {
  return <Row title={title} subtitle={subtitle} chevron divider={divider} accessibilityRole="link"
    leading={<WebIcon />} onPress={() => openExternal(webUrl(path))} />;
}
function WebIcon() {
  const c = useTheme();
  return <SymbolView name={{ ios: 'safari', android: 'open_in_new' }} size={15} tintColor={c.muted} />;
}

/** A label and value on one line, for read-only facts. */
export function Fact({ label, value, tone, divider = true }: { label: string; value: string; tone?: 'muted' | 'destructive' | 'warning' | 'success'; divider?: boolean }) {
  return <Row title={label} divider={divider} trailing={<AppText variant="meta" tone={tone ?? 'muted'} selectable numberOfLines={2}
    style={{ maxWidth: '60%', textAlign: 'right' }}>{value}</AppText>} />;
}

/** A plain progress bar. `percent` is the filled share, 0 to 100. */
export function Bar({ percent, tone = 'primary', label, height = 6 }: { percent: number; tone?: Tone; label: string; height?: number }) {
  const c = useTheme();
  const value = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  return <View accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max: 100, now: Math.round(value) }}
    style={[styles.track, { height, backgroundColor: c.surface }]}>
    <View style={[styles.fill, { width: `${value}%`, backgroundColor: toneColor(c, tone) }]} />
  </View>;
}

export const pageStyles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40, gap: 16, width: '100%', maxWidth: 680, alignSelf: 'center' },
});
const styles = StyleSheet.create({
  content: pageStyles.content,
  track: { borderRadius: radius.round, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: radius.round },
  loading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 24 },
});
