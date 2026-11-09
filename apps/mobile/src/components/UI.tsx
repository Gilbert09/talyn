import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import type { ComponentProps, PropsWithChildren, ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useTheme } from '../theme/tokens';

export type Tone = 'muted' | 'primary' | 'destructive' | 'success' | 'warning' | 'information';
export function Label({ children, muted = false, small = false }: PropsWithChildren<{ muted?: boolean; small?: boolean }>) {
  const colors = useTheme();
  return <Text selectable style={[small ? ui.caption : ui.body, { color: muted ? colors.muted : colors.text }]}>{children}</Text>;
}
export function Button({ title, onPress, disabled = false, accessibilityLabel, variant = 'primary' }: {
  title: string; onPress(): void; disabled?: boolean; accessibilityLabel?: string; variant?: 'primary' | 'secondary' | 'quiet' | 'destructive';
}) {
  const c = useTheme();
  const primary = variant === 'primary';
  const foreground = primary ? c.primaryText : variant === 'destructive' ? c.destructive : c.text;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [ui.button, {
      backgroundColor: primary ? c.primaryAction : variant === 'quiet' ? 'transparent' : c.paper,
      borderColor: variant === 'destructive' ? c.destructive : primary || variant === 'quiet' ? 'transparent' : c.border,
      opacity: disabled ? 0.48 : pressed ? 0.7 : 1,
    }]}>
    <Text style={[ui.buttonText, { color: foreground }]}>{title}</Text>
  </Pressable>;
}
export function IconButton({ label, symbol, onPress, disabled = false }: { label: string; symbol: ComponentProps<typeof SymbolView>['name']; onPress(): void; disabled?: boolean }) {
  const c = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} style={({ pressed }) => [ui.iconButton, { backgroundColor: c.paper, borderColor: c.border, opacity: disabled ? 0.48 : pressed ? 0.7 : 1 }]}>
    <SymbolView name={symbol} size={21} tintColor={c.text} />
  </Pressable>;
}
export function Card({ children }: PropsWithChildren) {
  const c = useTheme();
  return <View style={[ui.card, { backgroundColor: c.paper, borderColor: c.border }]}>{children}</View>;
}
export function SectionHeader({ title, detail }: { title: string; detail?: string }) {
  const c = useTheme();
  return <View style={ui.sectionHeader}><Text accessibilityRole="header" style={[ui.sectionTitle, { color: c.text }]}>{title}</Text>
    {detail ? <Label muted small>{detail}</Label> : null}</View>;
}
export function Disclosure({ title, children, onToggle }: PropsWithChildren<{ title: string; onToggle?(expanded: boolean): void }>) {
  const [expanded, setExpanded] = useState(false);
  const c = useTheme();
  return <View style={{ gap: 8 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded }} onPress={() => { onToggle?.(!expanded); setExpanded(!expanded); }}
      style={({ pressed }) => [{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, opacity: pressed ? 0.65 : 1 }]}>
      <Text style={[ui.body, { color: c.muted, flex: 1 }]}>{title}</Text>
      <Text accessible={false} style={{ color: c.muted, fontSize: 20 }}>{expanded ? '−' : '+'}</Text>
    </Pressable>
    {expanded ? children : null}
  </View>;
}
export function Divider() {
  const c = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />;
}
export function Badge({ label, tone = 'muted' }: { label: string; tone?: Tone }) {
  const c = useTheme();
  return <View style={[ui.badge, { borderColor: c.border, backgroundColor: c.background }]}>
    <View accessible={false} style={[ui.dot, { backgroundColor: c[tone] }]} />
    <Text style={[ui.caption, { color: tone === 'primary' ? c.primaryAction : c[tone], fontWeight: '600', flexShrink: 1 }]}>{label}</Text>
  </View>;
}
export function Notice({ message, loading = false, alert = false, tone, children }: PropsWithChildren<{ message: string; loading?: boolean; alert?: boolean; tone?: Tone }>) {
  const c = useTheme();
  return <View style={[ui.notice, { backgroundColor: c.paper, borderColor: c.border, borderLeftColor: tone ? c[tone] : alert ? c.destructive : c.primary }]}>
    <View style={ui.inline}>
      {loading ? <ActivityIndicator accessibilityLabel="Loading" color={c.primary} /> : null}
      <Text accessibilityRole={alert ? 'alert' : 'text'} accessibilityLiveRegion={alert ? 'polite' : 'none'}
        style={[ui.body, { color: c.text, flex: 1 }]}>{message}</Text>
    </View>
    {children}
  </View>;
}
export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <Card><SectionHeader title={title} /><Label muted>{detail}</Label></Card>;
}
export function ListRow({ title, subtitle, trailing, children, onPress, accessibilityLabel, selected, disabled = false }: PropsWithChildren<{
  title: string; subtitle?: string; trailing?: ReactNode; onPress?(): void; accessibilityLabel?: string; selected?: boolean; disabled?: boolean;
}>) {
  const c = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} accessibilityState={{ disabled, selected }}
    disabled={disabled} onPress={onPress} style={({ pressed }) => [ui.listRow, { backgroundColor: selected ? c.paper : c.background,
      borderColor: selected ? c.primary : c.border, opacity: disabled ? 0.48 : pressed ? 0.7 : 1 }]}>
    <View style={[ui.inline, { flexWrap: 'wrap' }]}><View style={{ flexGrow: 1, flexBasis: 160, gap: 4 }}><Text style={[ui.rowTitle, { color: c.text }]}>{title}</Text>
      {subtitle ? <Label muted small>{subtitle}</Label> : null}</View>{trailing}</View>
    {children}
  </Pressable>;
}
export function Input(props: ComponentProps<typeof TextInput>) {
  const c = useTheme();
  return <TextInput placeholderTextColor={c.muted} selectionColor={c.primary} {...props}
    style={[ui.input, { color: c.text, backgroundColor: c.elevated, borderColor: c.border, opacity: props.editable === false ? 0.6 : 1 }, props.style]} />;
}
export function Field({ label, children }: PropsWithChildren<{ label: string }>) {
  return <View style={{ gap: 6 }}><Label muted small>{label}</Label>{children}</View>;
}
export const ui = StyleSheet.create({
  body: { fontSize: 16, lineHeight: 24, flexShrink: 1, maxWidth: '100%', textAlign: 'auto', writingDirection: 'auto' },
  caption: { fontSize: 13, lineHeight: 20, flexShrink: 1, maxWidth: '100%', textAlign: 'auto', writingDirection: 'auto' },
  button: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 16, lineHeight: 24, fontWeight: '600', textAlign: 'center', flexShrink: 1 },
  iconButton: { minWidth: 48, minHeight: 48, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 12 },
  sectionHeader: { gap: 4 }, sectionTitle: { fontSize: 18, lineHeight: 26, fontWeight: '600' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 8, maxWidth: '100%' },
  dot: { width: 5, height: 5, borderRadius: 3 },
  notice: { padding: 12, gap: 8, borderWidth: 1, borderLeftWidth: 3, borderRadius: 12 },
  listRow: { minHeight: 52, padding: 14, borderWidth: 1, borderRadius: 14, gap: 8 },
  rowTitle: { fontSize: 17, lineHeight: 25, fontWeight: '600', flexShrink: 1 },
  input: { minHeight: 48, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 12, fontSize: 16, textAlignVertical: 'top' },
});
