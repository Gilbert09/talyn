import type { Workbench } from '@talyn/shared';
import { SymbolView } from 'expo-symbols';
import { useState, type ComponentRef, type Ref } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { Button, type Symbol } from '../../components/UI';
import { radius, type, useTheme } from '../../theme/tokens';
import { useLocal } from '../../workflow/hooks';
import { canCompose, deliveryLabel, workbenchKind } from '../../workflow/model';
import { chatActions } from './actions';

/** About six lines of body text, then the field scrolls. */
const MAX_INPUT_HEIGHT = 6 * 22 + 18;

function RoundButton({ label, symbol, onPress, disabled, tone, busy = false }: {
  label: string; symbol: Symbol; onPress(): void; disabled: boolean; tone: 'primary' | 'destructive'; busy?: boolean;
}) {
  const c = useTheme();
  const background = disabled ? c.surface : tone === 'primary' ? c.primaryAction : c.destructiveFill;
  const foreground = disabled ? c.muted : tone === 'primary' ? c.primaryText : c.destructiveFillText;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, busy }} disabled={disabled}
    onPress={onPress} hitSlop={6} style={({ pressed }) => [styles.round, { backgroundColor: background, opacity: pressed ? 0.75 : 1 }]}>
    {busy ? <ActivityIndicator size="small" color={foreground} /> : <SymbolView name={symbol} size={16} tintColor={foreground} />}
  </Pressable>;
}

/**
 * The message field, with send inside it and Stop while the agent works.
 * `ready` is false only while the conversation has not loaded or cannot be
 * read. A background refresh never blocks sending; the server checks.
 */
export function Composer({ item, chatId, ready, inputRef }: { item: Workbench; chatId: string; ready: boolean; inputRef?: Ref<ComponentRef<typeof TextInput>> }) {
  const { workflow } = useMobileRuntime();
  const local = useLocal(chatId); const c = useTheme(); const network = useNetwork();
  const [focused, setFocused] = useState(false);
  const [stopping, setStopping] = useState(false);
  const chat = item.chats?.find((value) => value.id === chatId);
  const allowed = ready && network === 'online' && canCompose(item, chat) && workflow.canSend();
  const delivery = local.delivery;
  const running = chat?.status === 'running';
  const hasDraft = Boolean(local.draft.trim());
  const blocked = delivery.status === 'failed' || delivery.status === 'unknown';
  const retry = () => Alert.alert('Send this message again?', delivery.status === 'unknown'
    ? 'Delivery is still unknown. The server can receive the same message twice. Check the conversation and queue first.'
    : 'This sends the current draft again.', [
      { text: 'Cancel', style: 'cancel', isPreferred: true },
      { text: 'Send again', onPress: () => { void workflow.send(item.id, chatId, true); } },
    ]);
  const stop = async () => {
    setStopping(true);
    try { await chatActions.stop(chatId); } catch { Alert.alert('Could not stop the agent', 'Try again.'); } finally {
      setStopping(false);
      void workflow.load('workbench', item.id);
    }
  };
  const queued = chat?.queuedMessages.length ?? 0;
  const status = [
    network === 'offline' ? 'Offline. Sending needs a connection.' : network !== 'online' ? 'Checking the connection.' : '',
    chat?.status === 'awaiting_input' ? 'The agent is waiting for your reply.' : '',
    queued ? `${queued} ${queued === 1 ? 'message' : 'messages'} queued` : '',
  ].filter(Boolean).join(' · ');
  const placeholder = running ? 'The agent is working. A message now is queued.'
    : chat?.status === 'awaiting_input' ? 'Reply to the agent' : workbenchKind(item) === 'thread' ? 'Ask the thread' : 'Ask the agent';
  return <View style={[styles.wrap, { backgroundColor: c.background, borderColor: c.border }]}>
    {status || delivery.status !== 'idle' ? <View style={styles.status}>
      {delivery.status !== 'idle' ? <Text accessibilityLiveRegion="polite" accessibilityRole="text"
        style={[type.caption, { color: delivery.status === 'failed' ? c.destructive : c.muted }]}>{deliveryLabel(delivery.status)}</Text> : null}
      {status ? <Text style={[type.caption, { color: chat?.status === 'awaiting_input' ? c.information : c.muted, flexShrink: 1 }]}>
        {delivery.status !== 'idle' ? `· ${status}` : status}</Text> : null}
    </View> : null}
    {delivery.status === 'unknown' ? <View style={styles.recovery}>
      <Text style={[type.caption, { color: c.muted, flexBasis: '100%' }]}>
        {delivery.checked ? 'History and queue were refreshed. Delivery is still unknown.' : 'Messages are never resent automatically.'}</Text>
      <Button size="sm" variant="quiet" title="Check delivery" disabled={!allowed} onPress={() => { void workflow.checkDelivery(item.id, chatId); }} />
      {delivery.checked ? <Button size="sm" variant="quiet" title="Review and resend" disabled={!allowed || !hasDraft} onPress={retry} /> : null}
    </View> : delivery.status === 'failed' ? <View style={styles.recovery}>
      <Button size="sm" variant="quiet" title="Retry message" disabled={!allowed || !hasDraft} onPress={retry} />
    </View> : null}
    <View style={[styles.field, { borderColor: focused ? c.primary : c.border, backgroundColor: c.elevated }]}>
      <TextInput ref={inputRef} multiline accessibilityLabel="Message" accessibilityHint="Drafts stay on this device for this account and workspace."
        value={local.draft} maxLength={20000} onChangeText={(draft) => workflow.updateLocal(chatId, { draft })}
        editable={delivery.status !== 'sending'} placeholder={placeholder} placeholderTextColor={c.muted} selectionColor={c.primary}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={[styles.input, { color: c.text, opacity: delivery.status === 'sending' ? 0.6 : 1 }]} />
      <View style={styles.buttons}>
        {running && !hasDraft ? <RoundButton label="Stop the agent" symbol={{ ios: 'stop.fill', android: 'stop' }} tone="destructive"
          disabled={stopping} busy={stopping} onPress={() => { void stop(); }} /> : null}
        {!running || hasDraft ? <RoundButton label={running ? 'Queue message' : 'Send message'} symbol={{ ios: 'arrow.up', android: 'arrow_upward' }} tone="primary"
          busy={delivery.status === 'sending'} disabled={!allowed || !hasDraft || blocked || delivery.status === 'sending'}
          onPress={() => { void workflow.send(item.id, chatId); }} /> : null}
      </View>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8, gap: 6, width: '100%', maxWidth: 760, alignSelf: 'center' },
  status: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, paddingHorizontal: 4 },
  recovery: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 4, paddingHorizontal: 4 },
  field: { flexDirection: 'row', alignItems: 'flex-end', borderWidth: 1, borderRadius: radius.lg, paddingLeft: 12, paddingRight: 6, paddingVertical: 5 },
  input: { ...type.body, flex: 1, minHeight: 32, maxHeight: MAX_INPUT_HEIGHT, paddingTop: 5, paddingBottom: 5, paddingHorizontal: 0, textAlignVertical: 'top', writingDirection: 'auto' },
  buttons: { flexDirection: 'row', gap: 6, paddingLeft: 6 },
  round: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});
