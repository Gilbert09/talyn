import { getApiBaseUrl } from '@talyn/client/native';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, View } from 'react-native';

import { useMobileRuntime } from '../../auth/AuthProvider';
import { AppText, IconButton } from '../../components/UI';
import { radius, useTheme, withAlpha } from '../../theme/tokens';
import { attachmentUrl, isImage, type ImageDraft, type MessageImage } from './attachments';

const THUMB = 56;

/** Thumbnails above the text field, each with a remove button and its own upload state. */
export function ComposerImages({ drafts, errors, onRemove, onRetry, onDismissError }: {
  drafts: ImageDraft[]; errors: string[]; onRemove(id: string): void; onRetry(id: string): void; onDismissError(index: number): void;
}) {
  const c = useTheme();
  if (!drafts.length && !errors.length) return null;
  return <View style={styles.strip}>
    {drafts.length ? <View style={styles.thumbs}>
      {drafts.map((draft) => <View key={draft.id} style={styles.thumbWrap}>
        <Pressable accessibilityRole={draft.status === 'error' ? 'button' : 'image'}
          accessibilityLabel={draft.status === 'error' ? `Retry ${draft.name}. ${draft.error ?? 'The upload failed.'}` : `${draft.name}${draft.status === 'uploading' ? ', uploading' : ''}`}
          disabled={draft.status !== 'error'} onPress={() => onRetry(draft.id)}
          style={[styles.thumb, { borderColor: draft.status === 'error' ? c.destructive : c.border, backgroundColor: c.surface }]}>
          <Image source={{ uri: draft.uri }} style={[styles.thumbImage, draft.status !== 'ready' && { opacity: 0.45 }]} />
          {draft.status === 'uploading' ? <View style={styles.overlay}><ActivityIndicator size="small" color={c.text} /></View> : null}
          {draft.status === 'error' ? <View style={styles.overlay}><SymbolView name={{ ios: 'arrow.clockwise', android: 'refresh' }} size={18} tintColor={c.destructive} /></View> : null}
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${draft.name}`} hitSlop={8} onPress={() => onRemove(draft.id)}
          style={[styles.remove, { backgroundColor: c.text }]}>
          <SymbolView name={{ ios: 'xmark', android: 'close' }} size={10} tintColor={c.background} />
        </Pressable>
      </View>)}
    </View> : null}
    {errors.map((message, index) => <Pressable key={`${index}:${message}`} accessibilityRole="button" accessibilityLabel={`${message} Dismiss.`}
      onPress={() => onDismissError(index)} style={styles.error}>
      <AppText variant="caption" tone="destructive" style={{ flex: 1 }}>{message}</AppText>
      <SymbolView name={{ ios: 'xmark', android: 'close' }} size={10} tintColor={c.destructive} />
    </Pressable>)}
  </View>;
}

/** Image attachments on a sent message. Tap one to see it full screen. */
export function MessageImages({ workbenchId, attachments }: { workbenchId: string; attachments: MessageImage[] }) {
  const images = attachments.filter(isImage);
  const [viewing, setViewing] = useState<MessageImage | null>(null);
  if (!images.length) return null;
  return <View style={styles.thumbs}>
    {images.map((image, index) => <MessageThumb key={`${image.path ?? image.name}:${index}`} workbenchId={workbenchId} image={image} onOpen={() => setViewing(image)} />)}
    {viewing ? <ImageViewer workbenchId={workbenchId} image={viewing} onClose={() => setViewing(null)} /> : null}
  </View>;
}

/** The image request carries the sign-in token, so the source is built once the token is known. */
function useImageSource(workbenchId: string, image: MessageImage) {
  const auth = useMobileRuntime().auth as { getAccessToken?: () => Promise<string | null> } | undefined;
  const [source, setSource] = useState<{ uri: string; headers: Record<string, string> } | null>(null);
  useEffect(() => {
    if (!image.path) return;
    let active = true;
    void Promise.resolve(auth?.getAccessToken?.() ?? null).catch(() => null).then((token) => {
      if (active) setSource({ uri: attachmentUrl(getApiBaseUrl(), workbenchId, image.path!), headers: token ? { Authorization: `Bearer ${token}` } : {} });
    });
    return () => { active = false; };
  }, [auth, workbenchId, image.path]);
  return source;
}

function MessageThumb({ workbenchId, image, onOpen }: { workbenchId: string; image: MessageImage; onOpen(): void }) {
  const c = useTheme();
  const source = useImageSource(workbenchId, image);
  const [failed, setFailed] = useState(false);
  const unavailable = !image.path || failed;
  return <Pressable accessibilityRole="button" accessibilityLabel={unavailable ? `${image.name}, image unavailable` : `Open ${image.name}`}
    disabled={unavailable} onPress={onOpen} style={[styles.thumb, { borderColor: c.border, backgroundColor: c.surface }]}>
    {source && !failed ? <Image source={source} style={styles.thumbImage} onError={() => setFailed(true)} />
      : <View style={styles.overlay}>{unavailable ? <SymbolView name={{ ios: 'photo', android: 'image' }} size={20} tintColor={c.muted} /> : <ActivityIndicator size="small" color={c.muted} />}</View>}
  </Pressable>;
}

function ImageViewer({ workbenchId, image, onClose }: { workbenchId: string; image: MessageImage; onClose(): void }) {
  const source = useImageSource(workbenchId, image);
  return <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
    <View style={[styles.viewer, { backgroundColor: withAlpha('#000000', 0.92) }]}>
      {source ? <Image source={source} resizeMode="contain" accessibilityLabel={image.name} style={styles.full} /> : <ActivityIndicator color="#ffffff" />}
      <View style={styles.close}><IconButton label="Close image" symbol={{ ios: 'xmark', android: 'close' }} onPress={onClose} filled /></View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  strip: { gap: 6, paddingHorizontal: 4 },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  thumbWrap: { width: THUMB, height: THUMB },
  thumb: { width: THUMB, height: THUMB, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  thumbImage: { width: '100%', height: '100%' },
  overlay: { ...StyleSheet.absoluteFill as object, alignItems: 'center', justifyContent: 'center' },
  remove: { position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  error: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  viewer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  full: { width: '100%', height: '80%' },
  close: { position: 'absolute', top: 48, right: 16 },
});
