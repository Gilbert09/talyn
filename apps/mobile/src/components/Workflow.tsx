import { useEffect, useRef, type PropsWithChildren, type ComponentRef } from 'react';
import { AccessibilityInfo, Alert, findNodeHandle, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Resource } from '../workflow/model';
import { ROW_TEXT_LIMIT } from '../workflow/model';
import { useShellColors } from './ShellScreen';
import { mono as monoFont, type } from '../theme/tokens';
import { Banner, Button, Spinner } from './UI';

export function Body({ children, muted = false, label }: PropsWithChildren<{ muted?: boolean; label?: string }>) {
  const colors = useShellColors();
  return <Text selectable accessibilityLabel={label} style={[styles.body, { color: muted ? colors.muted : colors.text }]}>{children}</Text>;
}
/** The screen's own title. Focused for screen readers when the screen opens. */
export function Heading({ children, size = 'title' }: PropsWithChildren<{ size?: 'title' | 'heading' }>) {
  const colors = useShellColors();
  const ref = useRef<ComponentRef<typeof Text>>(null);
  useEffect(() => {
    const node = findNodeHandle(ref.current);
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, []);
  return <Text ref={ref} accessibilityRole="header" style={[type[size], { color: colors.text, textAlign: 'auto' }]}>{children}</Text>;
}
export function Action({ label, onPress, disabled = false, primary = false }: { label: string; onPress(): void; disabled?: boolean; primary?: boolean }) {
  return <Button title={label} onPress={onPress} disabled={disabled} variant={primary ? 'primary' : 'quiet'} size="sm" />;
}
/**
 * Shows only what a person must know: first load, offline, error, no access, deleted.
 * A background refetch stays silent, and existing data stays on screen.
 */
export function StateNotice({ resource, offline, refresh, refreshLabel = 'Try again' }: { resource: Resource<unknown>; offline: boolean; refresh(): void; refreshLabel?: string }) {
  const colors = useShellColors();
  const hasData = resource.data !== undefined;
  if ((resource.status === 'loading' || resource.status === 'idle') && !hasData && !offline) {
    return <View accessibilityState={{ busy: true }} style={styles.loading}><Spinner /><Text style={[type.meta, { color: colors.muted }]}>Loading</Text></View>;
  }
  let text = '';
  let tone: 'warning' | 'destructive' = 'warning';
  let action = true;
  if (resource.status === 'deleted') { text = 'This item was deleted or is no longer available.'; tone = 'destructive'; action = false; }
  else if (resource.status === 'unauthorized') { text = 'Access is unavailable. Check your account and workspace.'; tone = 'destructive'; }
  else if (offline || resource.status === 'offline') { text = hasData ? 'You are offline. Showing what this app last loaded.' : 'You are offline. Connect to load this view.'; action = false; }
  else if (resource.status === 'error') { text = hasData ? 'Could not refresh. Showing earlier data.' : 'This view could not load.'; tone = 'destructive'; }
  if (!text) return null;
  return <Banner message={text} tone={tone} action={action ? refreshLabel : undefined} onAction={refresh} actionDisabled={offline || resource.refreshing} />;
}
export function safeExternalUrl(value: string): string | null {
  try {
    if (value.length > 4096 || Array.from(value).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return null;
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function openExternal(value: string) {
  const url = safeExternalUrl(value);
  if (!url) return;
  Alert.alert('Open external website?', url, [
    { text: 'Cancel', style: 'cancel', isPreferred: true },
    { text: 'Open website', onPress: () => { void Linking.openURL(url).catch(() => Alert.alert('Website unavailable', 'Try again when your connection is available.')); } },
  ]);
}
export function NativeText({ text }: { text: string }) {
  const colors = useShellColors();
  const parts = text.slice(0, ROW_TEXT_LIMIT).split(/(```[\s\S]*?(?:```|$))/g).filter(Boolean);
  return <View style={styles.textParts}>{parts.map((part, index) => {
    if (part.startsWith('```')) {
      const code = part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
      return <View key={index} accessibilityLabel="Code block" style={[styles.code, { backgroundColor: colors.background }]}>
        <Body muted>Code</Body>
        {Array.from({ length: Math.ceil(code.length / 4000) }, (_, chunk) => <Text key={chunk} selectable
          style={[styles.body, styles.mono, { color: colors.text }]}>{code.slice(chunk * 4000, (chunk + 1) * 4000)}</Text>)}
      </View>;
    }
    const links = [...part.matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)/g)];
    return <View key={index} style={styles.textParts}><Text selectable style={[styles.body, { color: colors.text }]}>{part}</Text>
      {links.slice(0, 30).map((match, linkIndex) => {
        const url = safeExternalUrl(match[2] ?? match[3]);
        return url ? <Pressable key={linkIndex} accessibilityRole="link" accessibilityLabel={`Open website: ${match[1] ?? url}`}
          onPress={() => openExternal(url)} style={({ pressed }) => [styles.action, { opacity: pressed ? 0.65 : 1 }]}><Text style={[styles.body, { color: colors.primaryAction }]}>Open {match[1] ?? url}</Text></Pressable> : null;
      })}</View>;
  })}{text.length >= ROW_TEXT_LIMIT ? <Body muted>Long text is limited in this view.</Body> : null}</View>;
}
export const workflowStyles = StyleSheet.create({
  page: { flex: 1 }, content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32, width: '100%', maxWidth: 760, alignSelf: 'center' },
  header: { gap: 10, marginBottom: 4 }, footer: { padding: 12, gap: 8, width: '100%', maxWidth: 760, alignSelf: 'center' },
  input: { minHeight: 44, maxHeight: 160, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, ...type.body, textAlignVertical: 'top', writingDirection: 'auto' },
});
const styles = StyleSheet.create({
  body: { ...type.body, textAlign: 'auto', writingDirection: 'auto' },
  action: { minHeight: 48, padding: 12, borderRadius: 8, justifyContent: 'center' },
  loading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 24 },
  textParts: { gap: 8 }, code: { padding: 10, borderRadius: 6 }, mono: { ...monoFont(400), fontSize: 13, lineHeight: 19 },
});
