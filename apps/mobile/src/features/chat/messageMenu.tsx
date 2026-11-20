import type { Workbench } from '@talyn/shared';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Alert, Modal, Platform, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { AppText, Button, useActionSheet, useToast, type Symbol } from '../../components/UI';
import { trackEvent } from '../../lib/analytics';
import { radius, type, useTheme } from '../../theme/tokens';
import { MESSAGE_ACTION_LABEL, newSessionFromTextRoute, selectedText } from '../sessions/actions';

const ICONS: Record<'new_session' | 'copy' | 'select', Symbol> = {
  new_session: { ios: 'plus.bubble', android: 'add_comment' },
  copy: { ios: 'doc.on.doc', android: 'content_copy' },
  select: { ios: 'selection.pin.in.out', android: 'select_all' },
};

/** Opens the message menu for a transcript message. Null outside a conversation, so the message keeps native selection. */
export const MessageMenuContext = createContext<((text: string) => void) | null>(null);
export const useMessageMenuOpener = () => useContext(MessageMenuContext);

/**
 * The long-press menu on a transcript message: web's "New session from
 * selection" without the phone's text menu, which takes no app items. Render
 * `elements` last inside the screen.
 */
export function useMessageMenu(item: Workbench) {
  const router = useRouter();
  const sheet = useActionSheet();
  const toast = useToast();
  const [selecting, setSelecting] = useState<string | null>(null);
  const openSheet = sheet.open;
  const showToast = toast.show;
  // Read through a ref, so `open` stays the same and a workbench update does not draw every message again.
  const itemRef = useRef(item);
  itemRef.current = item;

  const startSession = useCallback((text: string, via: 'message' | 'selection') => {
    const current = itemRef.current;
    const route = newSessionFromTextRoute(current, text);
    if (!route) return;
    trackEvent('session_from_selection', { source_kind: current.kind === 'thread' ? 'thread' : 'session', chars: text.length, via,
      repository_prefilled: Boolean(route.params.repository) });
    router.push(route);
  }, [router]);

  const open = useCallback((text: string) => {
    if (!text.trim()) return;
    openSheet({ title: 'Message', actions: [
      { label: MESSAGE_ACTION_LABEL.new_session, icon: ICONS.new_session, detail: 'Quotes this message in a new session.', onPress: () => startSession(text, 'message') },
      { label: MESSAGE_ACTION_LABEL.copy, icon: ICONS.copy, onPress: () => {
        Clipboard.setStringAsync(text).then(() => showToast('Message copied.'), () => Alert.alert('Could not copy', 'Please try again.'));
      } },
      { label: MESSAGE_ACTION_LABEL.select, icon: ICONS.select, detail: 'Select part of the message.', onPress: () => setSelecting(text) },
    ] });
  }, [openSheet, showToast, startSession]);

  const elements = <>
    {sheet.sheet}
    {selecting !== null ? <SelectTextSheet text={selecting} onClose={() => setSelecting(null)}
      onStart={(text, partial) => { setSelecting(null); startSession(text, partial ? 'selection' : 'message'); }} /> : null}
    {toast.element}
  </>;
  return { open, elements };
}

/**
 * The message as read-only text the person can select part of. A Text view
 * cannot report its selection, so this is a TextInput that ignores edits.
 */
export function SelectTextSheet({ text, onClose, onStart }: { text: string; onClose(): void; onStart(text: string, partial: boolean): void }) {
  const c = useTheme();
  const insets = useContext(SafeAreaInsetsContext);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const part = selectedText(text, selection);
  return <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
    <View style={[local.screen, { backgroundColor: c.background, paddingTop: (insets?.top ?? 0) + 12, paddingBottom: (insets?.bottom ?? 0) + 12 }]}>
      <View style={local.header}>
        <AppText accessibilityRole="header" variant="rowTitle" style={{ flex: 1 }}>Select text</AppText>
        <Button title="Close" variant="quiet" size="sm" onPress={onClose} />
      </View>
      <AppText variant="meta" tone="muted">Select the part you want, then start a new session from it.</AppText>
      <TextInput testID="select-text-input" accessibilityLabel="Message text" value={text} multiline scrollEnabled
        // iOS selects in a non-editable field. Android cannot, so there the field is editable with no keyboard and drops edits.
        editable={Platform.OS === 'ios' ? false : true} showSoftInputOnFocus={false} onChangeText={() => undefined}
        onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
        style={[local.text, { color: c.text, borderColor: c.border, backgroundColor: c.surface }]} />
      <Button title={part ? MESSAGE_ACTION_LABEL.new_from_selection : MESSAGE_ACTION_LABEL.new_session}
        icon={ICONS.new_session} onPress={() => onStart(part || text, Boolean(part))} />
    </View>
  </Modal>;
}

const local = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 16, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  text: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: 12, textAlignVertical: 'top', ...type.body },
});
