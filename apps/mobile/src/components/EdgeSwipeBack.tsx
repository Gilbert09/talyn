import { useEffect, useState, type PropsWithChildren } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useRouter } from 'expo-router';

import { HOME } from '../navigation/routes';

/** Width of the strip on the left edge where a swipe may start, in dp. */
export const EDGE_ZONE = 24;
const DISTANCE_FRACTION = 0.35;
const VELOCITY_THRESHOLD = 800;
const OUT_MS = 180;

/** True when a touch began inside the left edge strip. */
export function inStartZone(x: number): boolean {
  'worklet';
  return x >= 0 && x <= EDGE_ZONE;
}

/** True when a released swipe is far enough, or fast enough, to leave the screen. */
export function shouldGoBack(translationX: number, velocityX: number, width: number): boolean {
  'worklet';
  if (translationX <= 0) return false;
  return translationX > width * DISTANCE_FRACTION || velocityX > VELOCITY_THRESHOLD;
}

/**
 * Android has no edge swipe back with 3-button navigation. This gives a pushed
 * screen the iOS one. On iOS the native stack already does it, so it draws
 * the children as they are.
 */
export function EdgeSwipeBack({ children }: PropsWithChildren) {
  if (Platform.OS !== 'android') return <>{children}</>;
  return <AndroidEdgeSwipeBack>{children}</AndroidEdgeSwipeBack>;
}

function AndroidEdgeSwipeBack({ children }: PropsWithChildren) {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [reduceMotion, setReduceMotion] = useState(false);
  const translateX = useSharedValue(0);
  const allowed = useSharedValue(false);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => { if (mounted) setReduceMotion(enabled); });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { mounted = false; subscription.remove(); };
  }, []);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.navigate(HOME);
  };

  const gesture = Gesture.Pan()
    .hitSlop({ left: 0, width: EDGE_ZONE })
    .activeOffsetX([-1000, 12])
    .failOffsetY([-16, 16])
    .onBegin((event) => {
      allowed.value = inStartZone(event.x);
    })
    .onUpdate((event) => {
      if (!allowed.value || reduceMotion) return;
      translateX.value = Math.max(0, event.translationX);
    })
    .onEnd((event) => {
      if (!allowed.value) return;
      if (shouldGoBack(event.translationX, event.velocityX, width)) {
        if (reduceMotion) {
          scheduleOnRN(goBack);
          return;
        }
        translateX.value = withTiming(width, { duration: OUT_MS, easing: Easing.out(Easing.cubic) }, (finished) => {
          if (finished) scheduleOnRN(goBack);
        });
      } else {
        translateX.value = withSpring(0, { damping: 28, stiffness: 320 });
      }
    })
    .onFinalize(() => {
      allowed.value = false;
    });

  const screenStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
    shadowOpacity: translateX.value > 0 ? 0.25 : 0,
    elevation: translateX.value > 0 ? 8 : 0,
  }));
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[styles.fill, styles.shadow, screenStyle]}>
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  shadow: { shadowColor: '#000', shadowOffset: { width: -2, height: 0 }, shadowRadius: 8 },
});
