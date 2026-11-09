import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, View } from 'react-native';

import { useTheme } from '../../theme/tokens';

/** An opacity that breathes while `active`. Still when reduce motion is on. */
function usePulse(active: boolean, duration = 700) {
  const value = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) { value.setValue(1); return undefined; }
    let loop: Animated.CompositeAnimation | null = null;
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled || reduced) return;
      loop = Animated.loop(Animated.sequence([
        Animated.timing(value, { toValue: 0.3, duration, useNativeDriver: true }),
        Animated.timing(value, { toValue: 1, duration, useNativeDriver: true }),
      ]));
      loop.start();
    }).catch(() => undefined);
    return () => { cancelled = true; loop?.stop(); value.setValue(1); };
  }, [active, duration, value]);
  return value;
}

/** A small status dot. Amber and pulsing while running, red on error, muted when done. */
export function StatusDot({ state, size = 6 }: { state: 'running' | 'error' | 'done' | 'waiting'; size?: number }) {
  const c = useTheme();
  const opacity = usePulse(state === 'running');
  const color = state === 'running' ? c.warning : state === 'error' ? c.destructive : state === 'waiting' ? c.information : c.muted;
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: state === 'done' ? 0.6 : opacity }} />;
}

/** Three dots that show the agent is writing. */
export function TypingDots() {
  const c = useTheme();
  const opacity = usePulse(true, 500);
  return <View accessibilityLabel="Agent is writing" style={styles.dots}>
    {[0, 1, 2].map((index) => <Animated.View key={index}
      style={[styles.dot, { backgroundColor: c.muted, opacity: index === 1 ? opacity : Animated.subtract(1.3, opacity) }]} />)}
  </View>;
}

const styles = StyleSheet.create({
  dots: { flexDirection: 'row', gap: 4, paddingVertical: 6, alignItems: 'center' },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
});
