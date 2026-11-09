import { Link, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useContext, useEffect, useState } from 'react';
import type { ComponentProps, PropsWithChildren, ReactNode } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, BackHandler, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View,
  type StyleProp, type TextProps, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { mono, radius, sans, type, useTheme, withAlpha, type Theme, type TypeVariant } from '../theme/tokens';

export type Tone = 'muted' | 'primary' | 'destructive' | 'success' | 'warning' | 'information' | 'merged';
export type Symbol = ComponentProps<typeof SymbolView>['name'];

export function toneColor(c: Theme, tone: Tone) {
  return tone === 'primary' ? c.primaryAction : c[tone];
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function AppText({ variant = 'body', tone, style, children, ...props }: TextProps & {
  variant?: TypeVariant; tone?: Tone | 'default'; style?: StyleProp<TextStyle>;
}) {
  const c = useTheme();
  const color = !tone || tone === 'default' ? c.text : toneColor(c, tone);
  return <Text {...props} style={[type[variant], { color }, styles.shrink, style]}>{children}</Text>;
}
/** Selectable text in the body or meta size. Kept for screens that predate `AppText`. */
export function Label({ children, muted = false, small = false }: PropsWithChildren<{ muted?: boolean; small?: boolean }>) {
  return <AppText selectable variant={small ? 'meta' : 'body'} tone={muted ? 'muted' : 'default'}>{children}</AppText>;
}
/** A compact screen title in the display face. */
export function Title({ children }: PropsWithChildren) {
  return <AppText accessibilityRole="header" variant="title">{children}</AppText>;
}
/** 12px muted label above a group of rows. Uppercase unless it names something, like a repository. */
export function SectionLabel({ title, trailing, uppercase = true }: { title: string; trailing?: ReactNode; uppercase?: boolean }) {
  return <View style={styles.sectionLabel}>
    <AppText accessibilityRole="header" variant="section" tone="muted" numberOfLines={1}
      style={[{ flex: 1 }, !uppercase && { textTransform: 'none', letterSpacing: 0 }]}>{title}</AppText>
    {trailing}
  </View>;
}
/** A heading with optional detail, for card-style blocks. */
export function SectionHeader({ title, detail }: { title: string; detail?: string }) {
  return <View style={{ gap: 2 }}><AppText accessibilityRole="header" variant="rowTitle">{title}</AppText>
    {detail ? <AppText variant="meta" tone="muted">{detail}</AppText> : null}</View>;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function Button({ title, onPress, disabled = false, accessibilityLabel, variant = 'primary', size = 'md', icon, loading = false }: {
  title: string; onPress(): void; disabled?: boolean; accessibilityLabel?: string;
  variant?: 'primary' | 'secondary' | 'quiet' | 'destructive'; size?: 'md' | 'sm'; icon?: Symbol; loading?: boolean;
}) {
  const c = useTheme();
  const [pressed, setPressed] = useState(false);
  const background = variant === 'primary' ? c.primaryAction : variant === 'destructive' ? c.destructiveFill
    : variant === 'secondary' ? c.surface : 'transparent';
  const foreground = variant === 'primary' ? c.primaryText : variant === 'destructive' ? c.destructiveFillText
    : variant === 'quiet' ? c.primaryAction : c.text;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title}
    accessibilityState={{ disabled, busy: loading }} disabled={disabled} onPress={onPress}
    onPressIn={() => setPressed(true)} onPressOut={() => setPressed(false)}
    style={[styles.button, size === 'sm' && styles.buttonSmall, { backgroundColor: background, opacity: disabled ? 0.45 : pressed ? 0.75 : 1 }]}>
    {loading ? <ActivityIndicator size="small" color={foreground} /> : icon ? <SymbolView name={icon} size={16} tintColor={foreground} /> : null}
    <Text style={[size === 'sm' ? styles.buttonTextSmall : styles.buttonText, { color: foreground }]}>{title}</Text>
  </Pressable>;
}
export function IconButton({ label, symbol, onPress, disabled = false, tone, filled = false, size = 20 }: {
  label: string; symbol: Symbol; onPress(): void; disabled?: boolean; tone?: Tone; filled?: boolean; size?: number;
}) {
  const c = useTheme();
  const [pressed, setPressed] = useState(false);
  const tint = filled ? c.primaryText : tone ? toneColor(c, tone) : c.text;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} hitSlop={4}
    disabled={disabled} onPress={onPress} onPressIn={() => setPressed(true)} onPressOut={() => setPressed(false)}
    style={[styles.iconButton, { backgroundColor: filled ? c.primaryAction : pressed ? c.surface : 'transparent', opacity: disabled ? 0.4 : 1 }]}>
    <SymbolView name={symbol} size={size} tintColor={tint} />
  </Pressable>;
}

// ---------------------------------------------------------------------------
// Rows and groups
// ---------------------------------------------------------------------------

interface RowProps {
  title: string;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Content under the title line, e.g. a line of pills. */
  children?: ReactNode;
  chevron?: boolean;
  href?: Href;
  onPress?(): void;
  accessibilityLabel?: string;
  accessibilityRole?: 'button' | 'link';
  selected?: boolean;
  disabled?: boolean;
  divider?: boolean;
  titleLines?: number;
  /** A secondary gesture, e.g. a menu of actions. Screen readers get it as a named action. */
  onLongPress?(): void;
  longPressLabel?: string;
}
/** A flat, divider-separated list row. With `href` it is a link; with `onPress` it is a button. */
export function Row({ title, subtitle, leading, trailing, children, chevron = false, href, onPress, accessibilityLabel,
  accessibilityRole, selected, disabled = false, divider = true, titleLines = 2, onLongPress, longPressLabel = 'Show actions' }: RowProps) {
  const c = useTheme();
  const [pressed, setPressed] = useState(false);
  const interactive = Boolean(href || onPress);
  const body = <View style={styles.rowInner}>
    {leading ? <View style={styles.rowLeading}>{leading}</View> : null}
    <View style={styles.rowMain}>
      <View style={styles.rowTitleLine}>
        <AppText variant="rowTitle" numberOfLines={titleLines} style={{ flex: 1 }}>{title}</AppText>
        {trailing}
        {chevron ? <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right' }} size={14} tintColor={c.muted} /> : null}
      </View>
      {typeof subtitle === 'string' ? <AppText variant="meta" tone="muted" numberOfLines={1}>{subtitle}</AppText> : subtitle}
      {children}
    </View>
  </View>;
  // One plain object: `Link asChild` drops style arrays and functions.
  const style: ViewStyle = { ...styles.row,
    backgroundColor: pressed || selected ? c.paper : 'transparent',
    borderBottomColor: divider ? c.border : 'transparent', opacity: disabled ? 0.45 : 1,
  };
  if (!interactive) return <View style={style} accessibilityLabel={accessibilityLabel}>{body}</View>;
  const pressable = <Pressable accessibilityRole={accessibilityRole ?? (href ? 'link' : 'button')} accessibilityLabel={accessibilityLabel ?? title}
    accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress}
    onLongPress={onLongPress} accessibilityActions={onLongPress ? [{ name: 'longpress', label: longPressLabel }] : undefined}
    onAccessibilityAction={onLongPress ? (event) => { if (event.nativeEvent.actionName === 'longpress') onLongPress(); } : undefined}
    onPressIn={() => setPressed(true)} onPressOut={() => setPressed(false)} style={style}>{body}</Pressable>;
  return href ? <Link href={href} asChild>{pressable}</Link> : pressable;
}
/** Kept for the workspace chooser and tests: a selectable row with a subtitle. */
export function ListRow({ title, subtitle, trailing, onPress, accessibilityLabel, selected, disabled = false }: {
  title: string; subtitle?: string; trailing?: ReactNode; onPress?(): void; accessibilityLabel?: string; selected?: boolean; disabled?: boolean;
}) {
  return <Row title={title} subtitle={subtitle} trailing={trailing} onPress={onPress} accessibilityLabel={accessibilityLabel}
    selected={selected} disabled={disabled} />;
}
/** A settings-style group: optional label, rounded surface, rows inside. */
export function Group({ title, footer, children }: PropsWithChildren<{ title?: string; footer?: string }>) {
  const c = useTheme();
  return <View style={{ gap: 6 }}>
    {title ? <SectionLabel title={title} /> : null}
    <View style={[styles.group, { backgroundColor: c.paper, borderColor: c.border }]}>{children}</View>
    {footer ? <AppText variant="meta" tone="muted" style={{ paddingHorizontal: 4 }}>{footer}</AppText> : null}
  </View>;
}
export function Card({ children }: PropsWithChildren) {
  const c = useTheme();
  return <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.border }]}>{children}</View>;
}
export function Divider() {
  const c = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />;
}
export function Disclosure({ title, children, onToggle }: PropsWithChildren<{ title: string; onToggle?(expanded: boolean): void }>) {
  const [expanded, setExpanded] = useState(false);
  const c = useTheme();
  return <View style={{ gap: 8 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded }}
      onPress={() => { onToggle?.(!expanded); setExpanded(!expanded); }} style={styles.disclosure}>
      <AppText variant="meta" tone="muted" style={{ flex: 1 }}>{title}</AppText>
      <SymbolView name={expanded ? { ios: 'chevron.up', android: 'expand_less' } : { ios: 'chevron.down', android: 'expand_more' }} size={14} tintColor={c.muted} />
    </Pressable>
    {expanded ? children : null}
  </View>;
}

// ---------------------------------------------------------------------------
// Pills and marks
// ---------------------------------------------------------------------------

export function Pill({ label, tone = 'muted', icon, spin = false, accessibilityLabel }: {
  label: string; tone?: Tone; icon?: Symbol; spin?: boolean; accessibilityLabel?: string;
}) {
  const c = useTheme();
  const color = toneColor(c, tone);
  return <View accessibilityLabel={accessibilityLabel} style={[styles.pill, { backgroundColor: tone === 'muted' ? c.surface : withAlpha(color, c.mode === 'dark' ? 0.16 : 0.1) }]}>
    {spin ? <ActivityIndicator size={10} color={color} /> : icon ? <SymbolView name={icon} size={12} tintColor={color} /> : null}
    <Text numberOfLines={1} style={[styles.pillText, { color }]}>{label}</Text>
  </View>;
}
/** A mono `#123`, tinted by the PR's state the way web `PrPill` is. */
export function PrNumber({ number, tone = 'muted', plain = false }: { number: number; tone?: Tone; plain?: boolean }) {
  const c = useTheme();
  const color = toneColor(c, tone);
  return <Text accessibilityLabel={`Pull request ${number}`} style={[styles.prNumber, plain ? { color: c.muted } : {
    color, backgroundColor: tone === 'muted' ? c.surface : withAlpha(color, c.mode === 'dark' ? 0.16 : 0.1),
  }]}>#{number}</Text>;
}
export function Dot({ color, size = 8, dashed = false }: { color: string; size?: number; dashed?: boolean }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2,
    ...(dashed ? { borderWidth: 1.5, borderStyle: 'dashed' as const, borderColor: color } : { backgroundColor: color }) }} />;
}
export function Spinner({ color, size = 'small' }: { color?: string; size?: 'small' | 'large' | number }) {
  const c = useTheme();
  return <ActivityIndicator accessibilityLabel="Loading" size={size} color={color ?? c.muted} />;
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/** A real problem: error, offline, unauthorized, deleted. Not for background refresh. */
export function Banner({ message, tone = 'warning', action, onAction, actionDisabled = false }: {
  message: string; tone?: 'warning' | 'destructive' | 'information'; action?: string; onAction?(): void; actionDisabled?: boolean;
}) {
  const c = useTheme();
  const color = toneColor(c, tone);
  return <View style={[styles.banner, { backgroundColor: withAlpha(color, c.mode === 'dark' ? 0.14 : 0.08), borderColor: withAlpha(color, 0.3) }]}>
    <SymbolView name={tone === 'information' ? { ios: 'info.circle', android: 'info' } : { ios: 'exclamationmark.triangle', android: 'warning' }} size={16} tintColor={color} />
    <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[type.meta, { color: c.text, flex: 1 }]}>{message}</Text>
    {action && onAction ? <Pressable accessibilityRole="button" accessibilityLabel={action} disabled={actionDisabled} onPress={onAction} hitSlop={8}
      style={{ opacity: actionDisabled ? 0.45 : 1 }}><Text style={[type.meta, sans(600), { color: c.primaryAction }]}>{action}</Text></Pressable> : null}
  </View>;
}
/** A status line with optional spinner. `alert` announces it. */
export function Notice({ message, loading = false, alert = false, tone, children }: PropsWithChildren<{ message: string; loading?: boolean; alert?: boolean; tone?: Tone }>) {
  const c = useTheme();
  const accent = tone ? toneColor(c, tone) : alert ? c.destructive : c.muted;
  return <View style={[styles.notice, { backgroundColor: c.paper, borderColor: c.border }]}>
    <View style={styles.inline}>
      {loading ? <ActivityIndicator accessibilityLabel="Loading" size="small" color={c.muted} /> : <Dot color={accent} size={6} />}
      <Text accessibilityRole={alert ? 'alert' : 'text'} accessibilityLiveRegion={alert ? 'polite' : 'none'}
        style={[type.meta, { color: c.text, flex: 1 }]}>{message}</Text>
    </View>
    {children}
  </View>;
}
export function EmptyState({ title, detail, children }: PropsWithChildren<{ title: string; detail?: string }>) {
  return <View style={styles.empty}>
    <AppText variant="rowTitle" style={{ textAlign: 'center' }}>{title}</AppText>
    {detail ? <AppText variant="meta" tone="muted" style={{ textAlign: 'center' }}>{detail}</AppText> : null}
    {children}
  </View>;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export function Segmented<T extends string>({ options, value, onChange, accessibilityLabel }: {
  options: ReadonlyArray<{ value: T; label: string }>; value: T; onChange(value: T): void; accessibilityLabel?: string;
}) {
  const c = useTheme();
  return <View accessibilityRole="tablist" accessibilityLabel={accessibilityLabel} style={[styles.segmented, { backgroundColor: c.surface }]}>
    {options.map((option) => {
      const selected = option.value === value;
      return <Pressable key={option.value} accessibilityRole="tab" accessibilityLabel={option.label} accessibilityState={{ selected }}
        onPress={() => onChange(option.value)} style={[styles.segment, selected && { backgroundColor: c.background, borderColor: c.border }]}>
        <Text numberOfLines={1} style={[type.meta, sans(selected ? 600 : 500), { color: selected ? c.text : c.muted }]}>{option.label}</Text>
      </Pressable>;
    })}
  </View>;
}
export function Input(props: ComponentProps<typeof TextInput>) {
  const c = useTheme();
  return <TextInput placeholderTextColor={c.muted} selectionColor={c.primary} {...props}
    style={[styles.input, { color: c.text, backgroundColor: c.background, borderColor: c.border, opacity: props.editable === false ? 0.6 : 1 }, props.style]} />;
}
export function Field({ label, children }: PropsWithChildren<{ label: string }>) {
  return <View style={{ gap: 6 }}><AppText variant="meta" tone="muted">{label}</AppText>{children}</View>;
}

/** A native action menu: an action sheet on iOS, an alert with choices on Android. */
export function showActionMenu(title: string, actions: Array<{ label: string; destructive?: boolean; onPress(): void }>) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions({ title, options: [...actions.map((action) => action.label), 'Cancel'],
      cancelButtonIndex: actions.length, destructiveButtonIndex: actions.findIndex((action) => action.destructive) },
    (index) => { actions[index]?.onPress(); });
    return;
  }
  Alert.alert(title, undefined, [...actions.map((action) => ({ text: action.label, style: action.destructive ? 'destructive' as const : 'default' as const,
    onPress: action.onPress })), { text: 'Cancel', style: 'cancel' as const }]);
}


// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

export interface SheetAction {
  label: string;
  onPress(): void;
  detail?: string;
  icon?: Symbol;
  destructive?: boolean;
  disabled?: boolean;
  /** Draws a check mark, for a choice in a list. */
  selected?: boolean;
}
export interface SheetRequest { title: string; message?: string; actions: SheetAction[] }

/**
 * A bottom sheet of actions drawn over the screen. Unlike an Android alert it
 * has no three-button limit, and unlike a native modal an alert can open from
 * one of its actions straight away. Render `sheet` last inside the screen.
 */
export function useActionSheet() {
  const [request, setRequest] = useState<SheetRequest | null>(null);
  const close = () => setRequest(null);
  return { open: setRequest, close, sheet: request ? <ActionSheet request={request} onClose={close} /> : null };
}

export function ActionSheet({ request, onClose }: { request: SheetRequest; onClose(): void }) {
  const c = useTheme();
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => subscription.remove();
  }, [onClose]);
  return <View style={StyleSheet.absoluteFill}>
    <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose}
      style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.35)' }]} />
    <View accessibilityViewIsModal style={[styles.sheet, { backgroundColor: c.elevated, borderColor: c.border }]}>
      <View style={styles.sheetHeader}>
        <AppText accessibilityRole="header" variant="rowTitle" numberOfLines={2}>{request.title}</AppText>
        {request.message ? <AppText variant="meta" tone="muted">{request.message}</AppText> : null}
      </View>
      <ScrollView style={{ maxHeight: 420 }} keyboardShouldPersistTaps="handled">
        {request.actions.map((action, index) => {
          const color = action.destructive ? c.destructive : c.text;
          return <Pressable key={`${action.label}:${index}`} accessibilityRole="button" accessibilityLabel={action.label}
            accessibilityHint={action.detail} accessibilityState={{ disabled: action.disabled, selected: action.selected }}
            disabled={action.disabled} onPress={() => { onClose(); action.onPress(); }}
            style={({ pressed }) => [styles.sheetItem, { borderTopColor: c.border, opacity: action.disabled ? 0.45 : 1,
              backgroundColor: pressed ? c.surface : 'transparent' }]}>
            {action.icon ? <SymbolView name={action.icon} size={18} tintColor={color} /> : null}
            <View style={{ flex: 1, gap: 2 }}>
              <Text numberOfLines={2} style={[type.body, sans(500), { color }]}>{action.label}</Text>
              {action.detail ? <AppText variant="meta" tone="muted" numberOfLines={2}>{action.detail}</AppText> : null}
            </View>
            {action.selected ? <SymbolView name={{ ios: 'checkmark', android: 'check' }} size={16} tintColor={c.primaryAction} /> : null}
          </Pressable>;
        })}
      </ScrollView>
      <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={onClose}
        style={({ pressed }) => [styles.sheetItem, styles.sheetCancel, { borderTopColor: c.border, backgroundColor: pressed ? c.surface : 'transparent' }]}>
        <Text style={[type.body, sans(600), { color: c.text }]}>Cancel</Text>
      </Pressable>
    </View>
  </View>;
}

/** A small text prompt in a modal, since `Alert.prompt` exists on iOS only. */
export function PromptSheet({ visible, title, label, initialValue = '', placeholder, maxLength, submitLabel = 'Save', onCancel, onSubmit }: {
  visible: boolean; title: string; label: string; initialValue?: string; placeholder?: string; maxLength?: number;
  submitLabel?: string; onCancel(): void; onSubmit(value: string): void;
}) {
  const c = useTheme();
  const [value, setValue] = useState(initialValue);
  useEffect(() => { if (visible) setValue(initialValue); }, [visible, initialValue]);
  const submit = () => { if (value.trim()) onSubmit(value.trim()); };
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.promptBackdrop}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onCancel} style={StyleSheet.absoluteFill} />
      <View accessibilityViewIsModal style={[styles.prompt, { backgroundColor: c.elevated, borderColor: c.border }]}>
        <AppText accessibilityRole="header" variant="rowTitle">{title}</AppText>
        <Input accessibilityLabel={label} autoFocus value={value} onChangeText={setValue} placeholder={placeholder}
          maxLength={maxLength} returnKeyType="done" onSubmitEditing={submit} />
        <View style={styles.promptActions}>
          <Button variant="quiet" size="sm" title="Cancel" onPress={onCancel} />
          <Button size="sm" title={submitLabel} disabled={!value.trim()} onPress={submit} />
        </View>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

/** Fixed actions under a scrolling screen, like a toolbar. */
export function BottomBar({ children }: PropsWithChildren) {
  const c = useTheme();
  return <View style={[styles.bottomBar, { backgroundColor: c.background, borderTopColor: c.border }]}>{children}</View>;
}

/**
 * A short confirmation, such as "Copied", that hides itself after a moment.
 * Render `element` last inside the screen.
 */
export function useToast(duration = 2000) {
  const [toast, setToast] = useState<{ message: string; at: number } | null>(null);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), duration);
    return () => clearTimeout(timer);
  }, [toast, duration]);
  const show = useCallback((message: string) => setToast({ message, at: Date.now() }), []);
  return { show, element: toast ? <Toast message={toast.message} /> : null };
}
export function Toast({ message }: { message: string }) {
  const c = useTheme();
  return <View pointerEvents="none" style={styles.toastWrap}>
    <View style={[styles.toast, { backgroundColor: c.elevated, borderColor: c.border }]}>
      <SymbolView name={{ ios: 'checkmark.circle', android: 'check_circle' }} size={16} tintColor={c.success} />
      <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[type.meta, sans(500), { color: c.text, flexShrink: 1 }]}>{message}</Text>
    </View>
  </View>;
}

export const ui = StyleSheet.create({
  body: { ...type.body, flexShrink: 1, maxWidth: '100%', textAlign: 'auto', writingDirection: 'auto' },
  caption: { ...type.meta, flexShrink: 1, maxWidth: '100%', textAlign: 'auto', writingDirection: 'auto' },
  mono: { ...type.mono },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
});
const styles = StyleSheet.create({
  shrink: { flexShrink: 1, textAlign: 'auto', writingDirection: 'auto' },
  sectionLabel: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingTop: 16, paddingBottom: 6 },
  button: { minHeight: 44, borderRadius: radius.md, paddingVertical: 10, paddingHorizontal: 16, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
  buttonSmall: { minHeight: 36, paddingVertical: 6, paddingHorizontal: 12 },
  buttonText: { fontSize: 15, lineHeight: 20, ...sans(600), textAlign: 'center', flexShrink: 1 },
  buttonTextSmall: { fontSize: 13, lineHeight: 18, ...sans(600), textAlign: 'center', flexShrink: 1 },
  iconButton: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  row: { borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 48 },
  rowInner: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 12, paddingHorizontal: 4 },
  rowLeading: { width: 16, minHeight: 21, alignItems: 'center', justifyContent: 'center' },
  rowMain: { flex: 1, gap: 4 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  group: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, paddingHorizontal: 12, overflow: 'hidden' },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: 14, gap: 10 },
  disclosure: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2, paddingHorizontal: 6, borderRadius: radius.pill, maxWidth: '100%', alignSelf: 'flex-start' },
  pillText: { fontSize: 12, lineHeight: 16, ...sans(500), flexShrink: 1 },
  prNumber: { fontSize: 12, lineHeight: 16, ...mono(500), paddingHorizontal: 4, borderRadius: 4, overflow: 'hidden' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  notice: { padding: 10, gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  empty: { alignItems: 'center', gap: 6, paddingVertical: 48, paddingHorizontal: 24 },
  segmented: { flexDirection: 'row', borderRadius: radius.md, padding: 2, gap: 2 },
  segment: { flex: 1, minHeight: 32, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth, paddingBottom: 24, maxWidth: 760, alignSelf: 'center', width: '100%' },
  sheetHeader: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 10, gap: 4 },
  sheetItem: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth },
  sheetCancel: { justifyContent: 'center' },
  promptBackdrop: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: 'rgba(0,0,0,0.35)' },
  prompt: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 12, width: '100%', maxWidth: 480, alignSelf: 'center' },
  promptActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  bottomBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth },
  toastWrap: { position: 'absolute', left: 16, right: 16, bottom: 32, alignItems: 'center' },
  toast: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 14, borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth, maxWidth: 480, elevation: 3, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  input: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 10, borderRadius: radius.md, ...type.body, textAlignVertical: 'top' },
});

/** A switch in the app colours. The Android default thumb is teal. */
export function Toggle(props: ComponentProps<typeof Switch>) {
  const c = useTheme();
  return <Switch trackColor={{ false: c.border, true: c.primaryAction }} thumbColor={c.elevated} ios_backgroundColor={c.border} {...props} />;
}

/**
 * A compact action chip for a quick-action row: icon, short label, and a
 * spinner while it runs. `hint` explains it, or why it is disabled.
 */
export function ChipButton({ label, onPress, icon, variant = 'secondary', loading = false, disabled = false, hint, accessibilityLabel }: {
  label: string; onPress(): void; icon?: Symbol; variant?: 'primary' | 'secondary'; loading?: boolean; disabled?: boolean;
  hint?: string; accessibilityLabel?: string;
}) {
  const c = useTheme();
  const primary = variant === 'primary';
  const foreground = primary ? c.primaryText : c.text;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityHint={hint}
    accessibilityState={{ disabled: disabled || loading, busy: loading }} disabled={disabled || loading} onPress={onPress} hitSlop={4}
    style={({ pressed }) => [chipStyles.chip, { backgroundColor: primary ? c.primaryAction : c.surface,
      opacity: disabled ? 0.45 : pressed ? 0.75 : 1 }]}>
    {loading ? <ActivityIndicator size={12} color={foreground} /> : icon ? <SymbolView name={icon} size={14} tintColor={foreground} /> : null}
    <Text numberOfLines={1} style={[chipStyles.label, { color: foreground }]}>{label}</Text>
  </Pressable>;
}

/**
 * Content in a sheet that slides up over the screen, with a title and a close
 * button. `full` makes it nearly full height, for a list or a diff. Render
 * any action sheet the content opens inside `children`, so it draws on top.
 */
export function SheetModal({ visible, title, onClose, full = false, children }: PropsWithChildren<{
  visible: boolean; title: string; onClose(): void; full?: boolean;
}>) {
  const c = useTheme();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, bottom: 0, left: 0, right: 0 };
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
    <View style={chipStyles.backdrop}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={StyleSheet.absoluteFill} />
      <View accessibilityViewIsModal style={[chipStyles.sheet, full ? { height: '92%' } : { maxHeight: '85%' },
        { backgroundColor: c.background, borderColor: c.border, paddingBottom: insets.bottom }]}>
        <View style={chipStyles.sheetHeader}>
          <AppText accessibilityRole="header" variant="rowTitle" numberOfLines={1} style={{ flex: 1 }}>{title}</AppText>
          <IconButton label="Close" symbol={{ ios: 'xmark', android: 'close' }} size={18} onPress={onClose} />
        </View>
        <View style={full ? { flex: 1 } : { flexShrink: 1 }}>{children}</View>
      </View>
    </View>
  </Modal>;
}

const chipStyles = StyleSheet.create({
  chip: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, borderRadius: radius.round, flexShrink: 1 },
  label: { fontSize: 13, lineHeight: 18, ...sans(600), flexShrink: 1 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { width: '100%', maxWidth: 760, alignSelf: 'center', borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 8, paddingTop: 8, minHeight: 52 },
});
