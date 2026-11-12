import type { PRRow } from '@talyn/client/native';
import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { AppText } from '../../components/UI';
import { useTheme } from '../../theme/tokens';

export const QUEUE_ICON = { ios: 'list.number', android: 'format_list_numbered' } as const;

/** How far a row must travel, as a share of the screen width, before letting go acts on it. */
const SWIPE_COMMIT_SHARE = 0.3;

/**
 * A list row that queues or dequeues its pull request when swiped past a
 * threshold in either direction, like archiving in Gmail. Short of the
 * threshold the row springs back and nothing happens.
 */
export function QueueSwipeRow({ row, queued = row.mergeQueued, busy, onQueue, children }: {
  row: PRRow; queued?: boolean; busy: boolean; onQueue(row: PRRow): void; children: ReactNode;
}) {
  const c = useTheme();
  const { width } = useWindowDimensions();
  const threshold = width * SWIPE_COMMIT_SHARE;
  const x = useSharedValue(0);
  const armed = useSharedValue(0);
  const past = useSharedValue(false);
  const commit = () => onQueue(row);

  const pan = usePanGesture({
    enabled: !busy,
    testID: `queue-swipe-${row.id}`,
    // Horizontal travel starts the swipe. Vertical travel first leaves the list to scroll.
    activeOffsetX: [-16, 16],
    failOffsetY: [-12, 12],
    onUpdate: (event) => {
      x.value = event.translationX;
      const over = Math.abs(event.translationX) >= threshold;
      if (over !== past.value) {
        past.value = over;
        armed.value = withTiming(over ? 1 : 0, { duration: 120 });
      }
    },
    onDeactivate: (event) => {
      if (!event.canceled && Math.abs(event.translationX) >= threshold) {
        scheduleOnRN(commit);
        // Slide off in the swipe direction, then come back with the new queue state.
        x.value = withSequence(withTiming(Math.sign(event.translationX) * width, { duration: 160 }), withTiming(0, { duration: 220 }));
      } else {
        x.value = withSpring(0, { damping: 20, stiffness: 220 });
      }
      past.value = false;
      armed.value = withTiming(0, { duration: 380 });
    },
  });

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const armedStyle = useAnimatedStyle(() => ({ opacity: armed.value }));
  const label = queued ? 'Dequeue' : 'Queue';
  const fill = queued ? c.muted : c.primaryAction;
  const ink = queued ? c.background : c.primaryText;
  // Both sides carry the label. The opaque row covers the side it has not left.
  const sides = (tint: string) => <View style={local.sides}>
    {[0, 1].map((side) => <View key={side} style={local.side}>
      <SymbolView name={QUEUE_ICON} size={18} tintColor={tint} />
      <AppText variant="meta" style={{ color: tint }}>{label}</AppText>
    </View>)}
  </View>;

  return <View style={local.clip}>
    <View style={[StyleSheet.absoluteFill, { backgroundColor: c.surface }]} importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden>
      {sides(c.muted)}
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: fill }, armedStyle]}>{sides(ink)}</Animated.View>
    </View>
    <GestureDetector gesture={pan}>
      {/* Opaque, or the action behind the row shows through before any swipe. */}
      <Animated.View style={[{ backgroundColor: c.background }, rowStyle]}>{children}</Animated.View>
    </GestureDetector>
  </View>;
}

const local = StyleSheet.create({
  clip: { overflow: 'hidden' },
  sides: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20 },
  side: { alignItems: 'center', gap: 4 },
});
