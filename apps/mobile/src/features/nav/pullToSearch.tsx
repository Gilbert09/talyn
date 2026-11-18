import { SymbolView } from 'expo-symbols';
import { useRef, type ReactElement } from 'react';
import { Animated, Platform, RefreshControl, StyleSheet, Text, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { type, useTheme } from '../../theme/tokens';

/** How far past the top of the list a pull must go to open search. */
export const PULL_TO_SEARCH = 64;

export function pulledToSearch(offsetY: number): boolean {
  return offsetY <= -PULL_TO_SEARCH;
}

export interface PullToSearch {
  /** Spread on an `Animated.FlatList`. */
  listProps: {
    alwaysBounceVertical?: boolean;
    scrollEventThrottle?: number;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    onScrollEndDrag?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    refreshControl?: ReactElement;
  };
  /** Drawn behind the list. It shows in the space that a pull opens above the list. */
  hint: ReactElement | null;
}

/**
 * A pull down at the top of a list opens search. iOS reads the bounce past
 * the top. Android has no bounce, so it uses the pull-to-refresh gesture.
 */
export function usePullToSearch(onPull: () => void): PullToSearch {
  const c = useTheme();
  const pull = useRef(new Animated.Value(0)).current;
  if (Platform.OS === 'android') {
    return { listProps: { refreshControl: <RefreshControl refreshing={false} onRefresh={onPull} colors={[c.primaryAction]}
      progressBackgroundColor={c.elevated} /> }, hint: null };
  }
  const opacity = pull.interpolate({ inputRange: [-PULL_TO_SEARCH, -16], outputRange: [1, 0], extrapolate: 'clamp' });
  const scale = pull.interpolate({ inputRange: [-PULL_TO_SEARCH, -16], outputRange: [1, 0.85], extrapolate: 'clamp' });
  return {
    listProps: {
      alwaysBounceVertical: true,
      scrollEventThrottle: 16,
      onScroll: Animated.event([{ nativeEvent: { contentOffset: { y: pull } } }], { useNativeDriver: true }),
      onScrollEndDrag: (event) => { if (pulledToSearch(event.nativeEvent.contentOffset.y)) onPull(); },
    },
    hint: <Animated.View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden
      style={[styles.hint, { opacity, transform: [{ scale }] }]}>
      <SymbolView name={{ ios: 'magnifyingglass', android: 'search' }} size={14} tintColor={c.muted} />
      <Text style={[type.caption, { color: c.muted }]}>Search</Text>
    </Animated.View>,
  };
}

const styles = StyleSheet.create({
  hint: { position: 'absolute', top: 18, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
});
