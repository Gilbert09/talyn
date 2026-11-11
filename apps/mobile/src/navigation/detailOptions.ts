import type { NativeStackNavigationOptions } from 'expo-router';
import { Platform } from 'react-native';

export type Animation = 'default' | 'none' | 'fade' | 'slide_from_bottom' | 'slide_from_right';

/** The root stack options that both navigators understand. */
export type RootStackOptions = Pick<NativeStackNavigationOptions,
  'headerShown' | 'title' | 'headerBackTitle' | 'gestureEnabled' | 'headerStyle' | 'headerTintColor'
  | 'headerTitleStyle' | 'headerShadowVisible' | 'statusBarStyle' | 'contentStyle'> & { animation?: Animation };

/**
 * The push animation of a detail screen. Android slides it in from the right,
 * so the edge swipe back drags the same card the way it came.
 */
export function detailAnimation(os: string = Platform.OS): Animation {
  return os === 'android' ? 'slide_from_right' : 'default';
}

/** The options of a detail screen above the navigation: a header with a back button. */
export function detailOptions(title: string) {
  return { headerShown: true, title, animation: detailAnimation(), headerBackTitle: 'Back' } satisfies RootStackOptions;
}
