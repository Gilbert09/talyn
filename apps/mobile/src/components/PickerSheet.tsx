import { SymbolView } from 'expo-symbols';
import { useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Animated, Dimensions, Easing, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  useWindowDimensions } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { useKeyboardTop } from '../lib/keyboard';
import { mono, radius, sans, type, useTheme } from '../theme/tokens';
import { AppText, Button, IconButton, type Symbol } from './UI';

export interface PickerItem {
  key: string;
  label: string;
  /** A second line, such as a model's one-line description. */
  detail?: string;
  icon?: Symbol;
  /** Drawn in place of the icon, such as a space tile. */
  leading?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  /** Draw the label in the code face, for branch names. */
  mono?: boolean;
  accessibilityLabel?: string;
  onPress(): void;
}

export interface PickerSection {
  key: string;
  title?: string;
  /** A sentence under the title, such as why the section has no choices. */
  note?: string;
  action?: { label: string; onPress(): void };
  items: PickerItem[];
}

export interface PickerSheetProps {
  visible: boolean;
  title: string;
  onClose(): void;
  sections: PickerSection[];
  /** A search field above the list. The caller filters the sections. */
  search?: { value: string; onChange(value: string): void; placeholder: string; accessibilityLabel?: string };
  /** Content between the title and the list, such as a text field. */
  header?: ReactNode;
  /** Shown when no section has a choice or a note. */
  empty?: ReactNode;
  footer?: ReactNode;
  /** Close after a choice. On by default. */
  closeOnSelect?: boolean;
}

/**
 * A bottom sheet for one choice: dimmed backdrop, drag handle, title, optional
 * search, and a scrolling list. A tap on the backdrop, the back button or a
 * downward drag on the handle closes it. It stays above the keyboard.
 */
export function PickerSheet({ visible, title, onClose, sections, search, header, empty, footer, closeOnSelect = true }: PickerSheetProps) {
  const c = useTheme();
  const insets = useContext(SafeAreaInsetsContext);
  const keyboardTop = useKeyboardTop();
  const { height } = useWindowDimensions();
  // The modal draws edge to edge, so it pads the navigation bar itself, or the keyboard when it is open.
  const bottom = keyboardTop === null ? insets?.bottom ?? 0 : Math.max(0, Dimensions.get('screen').height - keyboardTop);
  const entry = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    drag.setValue(0);
    entry.setValue(0);
    Animated.timing(entry, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [visible, drag, entry]);

  const pan = useMemo(() => {
    const settle = () => Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) => gesture.dy > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderMove: (_event, gesture) => drag.setValue(Math.max(0, gesture.dy)),
      onPanResponderRelease: (_event, gesture) => { if (gesture.dy > 90 || gesture.vy > 1) onClose(); else settle(); },
      onPanResponderTerminate: settle,
    });
  }, [drag, onClose]);

  const translateY = Animated.add(drag, entry.interpolate({ inputRange: [0, 1], outputRange: [240, 0] }));
  const hasContent = sections.some((section) => section.items.length > 0 || section.note);

  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
    <View style={styles.root}>
      <Pressable accessible={false} importantForAccessibility="no" onPress={onClose} style={[StyleSheet.absoluteFill, styles.backdrop]} />
      <Animated.View accessibilityViewIsModal style={[styles.sheet, { backgroundColor: c.elevated, borderColor: c.border,
        paddingBottom: bottom + 8, maxHeight: Math.round(height * 0.85), transform: [{ translateY }] }]}>
        <View {...pan.panHandlers}>
          <View style={[styles.handle, { backgroundColor: c.border }]} />
          <View style={styles.titleRow}>
            <AppText accessibilityRole="header" variant="rowTitle" numberOfLines={1} style={{ flex: 1 }}>{title}</AppText>
            <IconButton label="Close" symbol={{ ios: 'xmark', android: 'close' }} size={16} onPress={onClose} />
          </View>
        </View>
        {search ? <View style={[styles.search, { backgroundColor: c.surface }]}>
          <SymbolView name={{ ios: 'magnifyingglass', android: 'search' }} size={16} tintColor={c.muted} />
          <TextInput value={search.value} onChangeText={search.onChange} placeholder={search.placeholder}
            accessibilityLabel={search.accessibilityLabel ?? search.placeholder} placeholderTextColor={c.muted} selectionColor={c.primary}
            autoCapitalize="none" autoCorrect={false} returnKeyType="search" style={[styles.searchInput, { color: c.text }]} />
        </View> : null}
        {header}
        <ScrollView keyboardShouldPersistTaps="handled" style={styles.list}>
          {sections.map((section) => <View key={section.key}>
            {section.title ? <AppText accessibilityRole="header" variant="section" tone="muted" style={styles.sectionTitle}>{section.title}</AppText> : null}
            {section.note ? <View style={styles.note}>
              <AppText variant="meta" tone="muted">{section.note}</AppText>
              {section.action ? <View style={{ alignSelf: 'flex-start' }}>
                <Button variant="quiet" size="sm" title={section.action.label} onPress={section.action.onPress} />
              </View> : null}
            </View> : null}
            {section.items.map((item) => <PickerRow key={item.key} item={item}
              onPress={() => { if (closeOnSelect) onClose(); item.onPress(); }} />)}
          </View>)}
          {hasContent ? null : empty}
        </ScrollView>
        {footer}
      </Animated.View>
    </View>
  </Modal>;
}

function PickerRow({ item, onPress }: { item: PickerItem; onPress(): void }) {
  const c = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={item.accessibilityLabel ?? item.label} accessibilityHint={item.detail}
    accessibilityState={{ selected: Boolean(item.selected), disabled: Boolean(item.disabled) }} disabled={item.disabled} onPress={onPress}
    style={({ pressed }) => [styles.row, { backgroundColor: pressed ? c.surface : 'transparent', opacity: item.disabled ? 0.45 : 1 }]}>
    {item.leading ?? (item.icon ? <SymbolView name={item.icon} size={18} tintColor={c.muted} /> : null)}
    <View style={styles.rowText}>
      <Text numberOfLines={1} style={[item.mono ? styles.monoLabel : styles.label, { color: c.text }]}>{item.label}</Text>
      {item.detail ? <AppText variant="meta" tone="muted" numberOfLines={2}>{item.detail}</AppText> : null}
    </View>
    {item.selected ? <SymbolView name={{ ios: 'checkmark', android: 'check' }} size={16} tintColor={c.primaryAction} /> : null}
  </Pressable>;
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderBottomWidth: 0,
    width: '100%', maxWidth: 760, alignSelf: 'center' },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 8, paddingTop: 4, paddingBottom: 4 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 10,
    borderRadius: radius.md, minHeight: 40 },
  searchInput: { flex: 1, ...type.body, paddingVertical: 8 },
  list: { flexGrow: 0 },
  sectionTitle: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  note: { paddingHorizontal: 16, paddingVertical: 6, gap: 4 },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  rowText: { flex: 1, gap: 2 },
  label: { ...type.body, ...sans(500) },
  monoLabel: { fontSize: 14, lineHeight: 20, ...mono(400) },
});
