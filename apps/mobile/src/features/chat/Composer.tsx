import type { Workbench } from '@talyn/shared';
import { Alert, ScrollView, StyleSheet, Text } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { Input, Pill } from '../../components/UI';
import { Action, Body, workflowStyles } from '../../components/Workflow';
import { type, useTheme } from '../../theme/tokens';
import { useLocal } from '../../workflow/hooks';
import { canCompose, deliveryLabel } from '../../workflow/model';

/**
 * Text composer. `ready` is false only while the conversation has not loaded or
 * cannot be read. A background refresh never blocks sending; the server checks.
 */
export function Composer({ item, chatId, ready }: { item: Workbench; chatId: string; ready: boolean }) {
  const { workflow } = useMobileRuntime();
  const local = useLocal(chatId); const colors = useTheme(); const network = useNetwork();
  const chat = item.chats?.find((value) => value.id === chatId);
  const allowed = ready && network === 'online' && canCompose(item, chat) && workflow.canSend();
  const delivery = local.delivery;
  const retry = () => Alert.alert('Send this message again?', delivery.status === 'unknown'
    ? 'Delivery is still unknown. The server can receive the same message twice. Check the conversation and queue first.'
    : 'This sends the current draft again.', [
      { text: 'Cancel', style: 'cancel', isPreferred: true },
      { text: 'Send again', onPress: () => { void workflow.send(item.id, chatId, true); } },
    ]);
  return <ScrollView style={[styles.wrap, { backgroundColor: colors.background, borderColor: colors.border }]} contentContainerStyle={workflowStyles.footer} keyboardShouldPersistTaps="handled">
    {network !== 'online' ? <Pill label={network === 'offline' ? 'Offline' : 'Checking connection'} tone="warning" /> : null}
    {chat?.status === 'awaiting_input' ? <Body muted>A text response is needed. Permission and terminal actions need Talyn on the web.</Body> : null}
    {chat?.queuedMessages.length ? <Body muted label={`Server queue: ${chat.queuedMessages.length} messages`}>Server queue: {chat.queuedMessages.length} messages</Body> : null}
    <Input multiline accessibilityLabel="Message" accessibilityHint="Text only. Drafts stay in memory in this account and workspace."
      value={local.draft} maxLength={20000} onChangeText={(draft) => workflow.updateLocal(chatId, { draft })}
      editable={delivery.status !== 'sending'} placeholder="Write a message" style={workflowStyles.input} />
    {network !== 'online' ? <Body muted>Sending needs a confirmed internet connection.</Body> : null}
    {delivery.status !== 'idle' ? <Text accessibilityLiveRegion="polite" accessibilityRole="status" style={[type.meta, { color: colors.muted }]}>{deliveryLabel(delivery.status)}</Text> : null}
    {delivery.status === 'unknown' ? <><Body muted>Delivery is unknown. Messages are never resent automatically.</Body>
      <Action label="Check delivery" disabled={!allowed} onPress={() => { void workflow.checkDelivery(item.id, chatId); }} />
      {delivery.checked ? <><Body muted>History and server queue were refreshed. Delivery remains unknown.</Body>
        <Action label="Review and resend" disabled={!allowed || !local.draft.trim()} onPress={retry} /></> : null}</>
      : delivery.status === 'failed' ? <Action label="Retry message" disabled={!allowed || !local.draft.trim()} onPress={retry} />
        : <Action primary label="Send message" disabled={!allowed || !local.draft.trim() || delivery.status === 'sending'} onPress={() => { void workflow.send(item.id, chatId); }} />}
  </ScrollView>;
}

const styles = StyleSheet.create({
  wrap: { maxHeight: '50%', flexGrow: 0, borderTopWidth: StyleSheet.hairlineWidth },
});
