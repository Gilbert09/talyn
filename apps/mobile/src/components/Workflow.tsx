import { Link, type Href } from 'expo-router';
import { useEffect, useRef, type PropsWithChildren, type ComponentRef } from 'react';
import { AccessibilityInfo, Alert, findNodeHandle, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Resource } from '../workflow/model';
import { ROW_TEXT_LIMIT } from '../workflow/model';
import { useShellColors } from './ShellScreen';

export function Body({ children, muted = false, label }: PropsWithChildren<{ muted?: boolean; label?: string }>) {
  const colors = useShellColors();
  return <Text selectable accessibilityLabel={label} style={[styles.body, { color: muted ? colors.muted : colors.text }]}>{children}</Text>;
}
export function Heading({ children }: PropsWithChildren) {
  const colors = useShellColors();
  const ref = useRef<ComponentRef<typeof Text>>(null);
  useEffect(() => {
    const node = findNodeHandle(ref.current);
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, []);
  return <Text ref={ref} accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>{children}</Text>;
}
export function Action({ label, onPress, disabled = false }: { label: string; onPress(): void; disabled?: boolean }) {
  const colors = useShellColors();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={[styles.action, { backgroundColor: colors.card, borderWidth: disabled ? 1 : 0, borderColor: colors.muted }]}>
    <Text style={[styles.body, { color: colors.accent }]}>{label}</Text>
  </Pressable>;
}
export function CardLink({ href, title, detail }: { href: Href; title: string; detail: string }) {
  const colors = useShellColors();
  return <Link href={href} asChild><Pressable accessibilityRole="link" accessibilityLabel={`${title}. ${detail}`}
    style={StyleSheet.flatten([styles.card, { backgroundColor: colors.card }])}>
    <Text style={[styles.cardTitle, { color: colors.text }]}>{title}</Text>
    <Text style={[styles.body, { color: colors.muted }]}>{detail}</Text>
  </Pressable></Link>;
}
export function StateNotice({ resource, offline, refresh, refreshLabel = 'Refresh' }: { resource: Resource<unknown>; offline: boolean; refresh(): void; refreshLabel?: string }) {
  const colors = useShellColors();
  let text = '';
  if (resource.status === 'loading' || resource.status === 'idle') text = offline ? 'Offline. Connect to load this view.' : 'Loading';
  else if (resource.status === 'deleted') text = 'This item was deleted or is no longer available. Return to the list.';
  else if (resource.status === 'unauthorized') text = 'Access is unavailable. Check your account and workspace.';
  else if (offline || resource.status === 'offline') text = 'Offline. Saved data is from this app session only.';
  else if (resource.status === 'error') text = 'This view could not be refreshed. Try again.';
  else if (resource.stale) text = 'Stale data. Refresh to check current state.';
  if (!text) return null;
  return <View style={styles.notice} accessibilityState={{ busy: resource.refreshing }}>
    <Text accessibilityRole={['error', 'unauthorized', 'deleted'].includes(resource.status) ? 'alert' : 'text'}
      accessibilityLiveRegion={['error', 'unauthorized', 'deleted'].includes(resource.status) ? 'polite' : 'none'}
      style={[styles.body, { color: colors.text }]}>{text}</Text>
    <Action label={refreshLabel} disabled={offline || resource.refreshing} onPress={refresh} />
  </View>;
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
          onPress={() => openExternal(url)} style={styles.action}><Text style={[styles.body, { color: colors.accent }]}>Open {match[1] ?? url}</Text></Pressable> : null;
      })}</View>;
  })}{text.length >= ROW_TEXT_LIMIT ? <Body muted>Long text is limited in this view.</Body> : null}</View>;
}
export const workflowStyles = StyleSheet.create({
  page: { flex: 1 }, content: { padding: 16, gap: 12, width: '100%', maxWidth: 900, alignSelf: 'center' },
  header: { gap: 12, marginBottom: 16 }, footer: { padding: 16, gap: 10 },
  input: { minHeight: 96, maxHeight: 220, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 17, textAlignVertical: 'top', writingDirection: 'auto' },
  transcript: { padding: 14, marginBottom: 12, gap: 6, borderRadius: 10 },
});
const styles = StyleSheet.create({
  heading: { fontSize: 30, fontWeight: '700', textAlign: 'auto' }, body: { fontSize: 17, lineHeight: 26, textAlign: 'auto', writingDirection: 'auto' },
  action: { minHeight: 48, padding: 12, borderRadius: 8, justifyContent: 'center' },
  card: { minHeight: 48, padding: 16, gap: 8, borderRadius: 10, marginBottom: 12 }, cardTitle: { fontSize: 19, fontWeight: '600', textAlign: 'auto' },
  notice: { gap: 8, paddingVertical: 12 }, textParts: { gap: 8 }, code: { padding: 10, borderRadius: 6 }, mono: { fontFamily: 'monospace' },
});
