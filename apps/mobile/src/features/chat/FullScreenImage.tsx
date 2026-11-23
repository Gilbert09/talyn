import type { ReactNode } from 'react';
import { ActivityIndicator, Image, Modal, Platform, ScrollView, StyleSheet, useWindowDimensions, View, type ImageSourcePropType } from 'react-native';

import { IconButton } from '../../components/UI';
import { withAlpha } from '../../theme/tokens';

/**
 * One image over a dark backdrop, fit to the screen, with a close button.
 * `zoomable` lets the person pinch to zoom on iOS. A null source shows a spinner.
 */
export function FullScreenImage({ source, label, onClose, footer, zoomable = false }: {
  source: ImageSourcePropType | null; label: string; onClose(): void; footer?: ReactNode; zoomable?: boolean;
}) {
  const window = useWindowDimensions();
  const image = source ? <Image source={source} resizeMode="contain" accessibilityLabel={label} style={styles.full} /> : <ActivityIndicator color="#ffffff" />;
  return <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
    <View style={[styles.viewer, { backgroundColor: withAlpha('#000000', 0.92) }]}>
      {source && zoomable && Platform.OS === 'ios'
        ? <ScrollView style={StyleSheet.absoluteFill} contentContainerStyle={styles.zoom} maximumZoomScale={4} minimumZoomScale={1} centerContent
          showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false}>
          <Image source={source} resizeMode="contain" accessibilityLabel={label} style={{ width: window.width, height: window.height * 0.8 }} />
        </ScrollView>
        : image}
      <View style={styles.close}><IconButton label="Close image" symbol={{ ios: 'xmark', android: 'close' }} onPress={onClose} filled /></View>
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  viewer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  zoom: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  full: { width: '100%', height: '80%' },
  close: { position: 'absolute', top: 48, right: 16 },
  footer: { position: 'absolute', bottom: 40, left: 16, right: 16, alignItems: 'center' },
});
