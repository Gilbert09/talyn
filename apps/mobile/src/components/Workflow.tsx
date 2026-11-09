import { Link, type Href } from 'expo-router';
import { useEffect, useRef, type PropsWithChildren, type ComponentRef } from 'react';
import { AccessibilityInfo, Alert, findNodeHandle, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Resource } from '../workflow/model';
import { ROW_TEXT_LIMIT } from '../workflow/model';
import { useShellColors } from './ShellScreen';
import { Button, Notice, ui } from './UI';

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
export function Action({ label, onPress, disabled = false, primary = false }: { label: string; onPress(): void; disabled?: boolean; primary?: boolean }) {
  return <Button title={label} onPress={onPress} disabled={disabled} variant={primary ? 'primary' : 'quiet'} />;
}
export function CardLink({ href, title, detail, children }: PropsWithChildren<{ href: Href; title: string; detail: string }>) {
  const colors = useShellColors();
  return <Link href={href} asChild><Pressable accessibilityRole="link" accessibilityLabel={`${title}. ${detail}`}
    style={({ pressed }) => [styles.card, { backgroundColor: pressed ? colors.paper : colors.background, borderColor: colors.border }]}>
    <View style={ui.inline}><Text style={[styles.cardTitle, { color: colors.text, flex: 1 }]}>{title}</Text>
      <Text accessible={false} style={{ fontSize: 22, color: colors.muted }}>›</Text></View>
    {children ?? <Text style={[ui.caption, { color: colors.muted }]}>{detail}</Text>}
  </Pressable></Link>;
}
export function StateNotice({ resource, offline, refresh, refreshLabel = 'Refresh' }: { resource: Resource<unknown>; offline: boolean; refresh(): void; refreshLabel?: string }) {
  let text = '';
  if (resource.status === 'loading' || resource.status === 'idle') text = offline ? 'Offline. Connect to load this view.' : 'Loading';
  else if (resource.status === 'deleted') text = 'This item was deleted or is no longer available. Return to the list.';
  else if (resource.status === 'unauthorized') text = 'Access is unavailable. Check your account and workspace.';
  else if (offline || resource.status === 'offline') text = 'Offline. Saved data is from this app session only.';
  else if (resource.status === 'error') text = 'This view could not be refreshed. Try again.';
  else if (resource.stale) text = 'Stale data. Refresh to check current state.';
  if (!text) return null;
  return <View accessibilityState={{ busy: resource.refreshing }}>
    <Notice message={text} loading={resource.status === 'loading' || resource.status === 'idle'}
      alert={['error', 'unauthorized', 'deleted'].includes(resource.status)}>
      <Action label={refreshLabel} disabled={offline || resource.refreshing} onPress={refresh} />
    </Notice>
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
          onPress={() => openExternal(url)} style={({ pressed }) => [styles.action, { opacity: pressed ? 0.65 : 1 }]}><Text style={[styles.body, { color: colors.primaryAction }]}>Open {match[1] ?? url}</Text></Pressable> : null;
      })}</View>;
  })}{text.length >= ROW_TEXT_LIMIT ? <Body muted>Long text is limited in this view.</Body> : null}</View>;
}
export const workflowStyles = StyleSheet.create({
  page: { flex: 1 }, content: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 32, gap: 10, width: '100%', maxWidth: 760, alignSelf: 'center' },
  header: { gap: 12, marginBottom: 8 }, footer: { padding: 12, gap: 8, width: '100%', maxWidth: 760, alignSelf: 'center' },
  input: { minHeight: 52, maxHeight: 160, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 17, textAlignVertical: 'top', writingDirection: 'auto' },
  transcript: { padding: 14, gap: 10, borderRadius: 14, borderWidth: 1, borderLeftWidth: 3 },
});
const styles = StyleSheet.create({
  heading: { fontSize: 28, lineHeight: 36, letterSpacing: -0.5, fontWeight: '700', textAlign: 'auto' }, body: { fontSize: 16, lineHeight: 24, textAlign: 'auto', writingDirection: 'auto' },
  action: { minHeight: 48, padding: 12, borderRadius: 8, justifyContent: 'center' },
  card: { minHeight: 48, paddingVertical: 14, paddingHorizontal: 14, gap: 6, borderRadius: 14, borderWidth: 1 }, cardTitle: { fontSize: 17, lineHeight: 25, fontWeight: '600', textAlign: 'auto' },
  textParts: { gap: 8 }, code: { padding: 10, borderRadius: 6 }, mono: { fontFamily: 'monospace' },
});
