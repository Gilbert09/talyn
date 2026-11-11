import type { Workbench } from '@talyn/shared';
import { SymbolView } from 'expo-symbols';
import { useRef, useState, type ComponentRef, type Ref } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { Button, type Symbol } from '../../components/UI';
import { trackEvent } from '../../lib/analytics';
import { radius, type, useTheme } from '../../theme/tokens';
import { useLocal } from '../../workflow/hooks';
import { canCompose, deliveryLabel, workbenchKind } from '../../workflow/model';
import { isStarting } from '../sessions/Starting';
import { chatActions } from './actions';
import { ComposerImages } from './AttachmentViews';
import { useImageDrafts } from './attachmentDrafts';
import { buildMessageInput, checkImage, imageErrorMessage, sendBlock, type ImageDraft, type PickedImage } from './attachments';
import { showImagePicker } from './imagePicker';

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
  const { workflow, auth } = useMobileRuntime();
  const local = useLocal(chatId); const c = useTheme(); const network = useNetwork();
  const [focused, setFocused] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [images, updateImages] = useImageDrafts(chatId);
  const [imageErrors, setImageErrors] = useState<string[]>([]);
  const [sendingImages, setSendingImages] = useState(false);
  const [imageSendError, setImageSendError] = useState('');
  const picked = useRef(0);
  const chat = item.chats?.find((value) => value.id === chatId);
  const allowed = ready && network === 'online' && canCompose(item, chat) && workflow.canSend();
  const delivery = local.delivery;
  const running = chat?.status === 'running';
  const hasText = Boolean(local.draft.trim());
  const hasImages = images.length > 0;
  const hasDraft = hasText || hasImages;
  const imageBlock = sendBlock({ text: local.draft, drafts: images });
  const blocked = delivery.status === 'failed' || delivery.status === 'unknown';
  const retry = () => Alert.alert('Send this message again?', delivery.status === 'unknown'
    ? 'Delivery is still unknown. The server can receive the same message twice. Check the conversation and queue first.'
    : 'This sends the current draft again.', [
      { text: 'Cancel', style: 'cancel', isPreferred: true },
      { text: 'Send again', onPress: () => { void sendText(true); } },
    ]);
  // Web's `session_message_sent`. The store settles the send without throwing, so the delivery says whether it went.
  const tracked = (queued: boolean, attachments: number) => trackEvent('session_message_sent', {
    queued, plan_mode: Boolean(chat?.planMode), model_id: chat?.model ?? null, attachments_count: attachments });
  const sendText = async (manualRetry = false) => {
    await workflow.send(item.id, chatId, manualRetry);
    const status = workflow.local(chatId).delivery.status;
    if (status === 'sent' || status === 'queued') tracked(status === 'queued', 0);
  };
  const stop = async () => {
    setStopping(true);
    try { await chatActions.stop(chatId); } catch { Alert.alert('Could not stop the agent', 'Try again.'); } finally {
      setStopping(false);
      void workflow.load('workbench', item.id);
    }
  };
  const upload = async (draft: ImageDraft) => {
    updateImages((current) => current.map((value) => value.id === draft.id ? { ...value, status: 'uploading', error: undefined } : value));
    try {
      const attachment = await chatActions.uploadImage(item.id, { uri: draft.uri, name: draft.name, mimeType: draft.mimeType }, async () => (await auth?.getAccessToken?.()) ?? null);
      updateImages((current) => current.map((value) => value.id === draft.id ? { ...value, status: 'ready', attachment } : value));
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : 'The upload failed.';
      updateImages((current) => current.map((value) => value.id === draft.id ? { ...value, status: 'error', error: reason } : value));
    }
  };
  const addImages = (assets: PickedImage[]) => {
    const added: ImageDraft[] = []; const errors: string[] = [];
    for (const asset of assets) {
      const check = checkImage(asset, picked.current++);
      if (check.ok) added.push({ id: `${Date.now()}-${picked.current}`, uri: asset.uri, name: check.name, mimeType: check.mimeType, status: 'uploading' });
      else errors.push(imageErrorMessage(check.name, check.reason));
    }
    if (errors.length) setImageErrors((current) => [...current, ...errors]);
    if (!added.length) return;
    setImageSendError('');
    updateImages((current) => [...current, ...added]);
    added.forEach((draft) => { void upload(draft); });
  };
  const attach = () => showImagePicker(addImages);
  const sendImages = async () => {
    if (imageBlock || sendingImages) return;
    setSendingImages(true); setImageSendError('');
    try {
      const input = buildMessageInput(local.draft.trim(), images);
      const ack = await chatActions.send(chatId, input);
      tracked(ack.queued, input.attachments?.length ?? 0);
      workflow.updateLocal(chatId, { draft: '' });
      updateImages(() => []);
      void workflow.load('workbench', item.id);
      void workflow.load('transcript', chatId);
    } catch {
      setImageSendError('The message may not have been sent. Your text and images are still here. Check the conversation before sending again.');
    } finally { setSendingImages(false); }
  };
  const queued = chat?.queuedMessages.length ?? 0;
  const status = [
    network === 'offline' ? 'Offline. Sending needs a connection.' : network !== 'online' ? 'Checking the connection.' : '',
    chat?.status === 'awaiting_input' ? 'The agent is waiting for your reply.' : '',
    queued ? `${queued} ${queued === 1 ? 'message' : 'messages'} queued` : '',
  ].filter(Boolean).join(' · ');
  const placeholder = running ? 'The agent is working. A message now is queued.'
    : isStarting(item) ? 'The sandbox is starting. A message now is queued.'
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
    {imageSendError ? <Text accessibilityLiveRegion="polite" style={[type.caption, { color: c.destructive, paddingHorizontal: 4 }]}>{imageSendError}</Text> : null}
    {hasImages && imageBlock ? <Text style={[type.caption, { color: c.muted, paddingHorizontal: 4 }]}>{imageBlock}</Text> : null}
    <ComposerImages drafts={images} errors={imageErrors}
      onRemove={(id) => updateImages((current) => current.filter((value) => value.id !== id))}
      onRetry={(id) => { const draft = images.find((value) => value.id === id); if (draft) void upload(draft); }}
      onDismissError={(index) => setImageErrors((current) => current.filter((_, at) => at !== index))} />
    <View style={[styles.field, { borderColor: focused ? c.primary : c.border, backgroundColor: c.elevated }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Attach an image" hitSlop={6} onPress={attach} disabled={!allowed}
        style={[styles.attach, { opacity: allowed ? 1 : 0.4 }]}>
        <SymbolView name={{ ios: 'plus', android: 'add' }} size={18} tintColor={c.muted} />
      </Pressable>
      <TextInput ref={inputRef} multiline accessibilityLabel="Message" accessibilityHint="Drafts stay on this device for this account and workspace."
        value={local.draft} maxLength={20000} onChangeText={(draft) => workflow.updateLocal(chatId, { draft })}
        editable={delivery.status !== 'sending' && !sendingImages} placeholder={placeholder} placeholderTextColor={c.muted} selectionColor={c.primary}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={[styles.input, { color: c.text, opacity: delivery.status === 'sending' ? 0.6 : 1 }]} />
      <View style={styles.buttons}>
        {running && !hasDraft ? <RoundButton label="Stop the agent" symbol={{ ios: 'stop.fill', android: 'stop' }} tone="destructive"
          disabled={stopping} busy={stopping} onPress={() => { void stop(); }} /> : null}
        {!running || hasDraft ? <RoundButton label={running ? 'Queue message' : 'Send message'} symbol={{ ios: 'arrow.up', android: 'arrow_upward' }} tone="primary"
          busy={delivery.status === 'sending' || sendingImages}
          disabled={!allowed || !hasDraft || blocked || delivery.status === 'sending' || sendingImages || (hasImages && Boolean(imageBlock))}
          onPress={() => { if (hasImages) void sendImages(); else void sendText(); }} /> : null}
      </View>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8, gap: 6, width: '100%', maxWidth: 760, alignSelf: 'center' },
  status: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, paddingHorizontal: 4 },
  recovery: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 4, paddingHorizontal: 4 },
  field: { flexDirection: 'row', alignItems: 'flex-end', borderWidth: 1, borderRadius: radius.lg, paddingLeft: 6, paddingRight: 6, paddingVertical: 5 },
  input: { ...type.body, flex: 1, minHeight: 32, maxHeight: MAX_INPUT_HEIGHT, paddingTop: 5, paddingBottom: 5, paddingHorizontal: 0, textAlignVertical: 'top', writingDirection: 'auto' },
  attach: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  buttons: { flexDirection: 'row', gap: 6, paddingLeft: 6 },
  round: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});
