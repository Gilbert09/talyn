import { Stack as NativeStack } from 'expo-router';
import { Stack as JSStack, type StackNavigationOptions } from 'expo-router/js-stack';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';

import { detailAnimation, type RootStackOptions } from './detailOptions';

/** Width of the strip on the left edge where a swipe back may start on Android, in dp. */
export const EDGE_ZONE = 24;

/**
 * Converts the root options for the JavaScript stack on Android. That stack
 * draws each header inside its card and follows an edge swipe back, so the
 * header and the screen below move with the finger.
 */
export function androidStackOptions(options: RootStackOptions): StackNavigationOptions {
  // The status bar style comes from `SystemChrome`. The JavaScript stack has no such option.
  const { contentStyle, statusBarStyle: _statusBarStyle, animation, ...rest } = options;
  const converted: StackNavigationOptions = { ...rest };
  if (contentStyle !== undefined) converted.cardStyle = contentStyle;
  if (animation !== undefined) converted.animation = animation === 'default' ? detailAnimation('android') : animation;
  return converted;
}

const ANDROID_BASE: StackNavigationOptions = { gestureEnabled: true, gestureDirection: 'horizontal', gestureResponseDistance: EDGE_ZONE };

/**
 * The root stack. iOS uses the native stack and its own swipe back. Android
 * uses the JavaScript stack: the native one there has no swipe back, and a
 * drag drawn above it left the native header and an empty screen behind.
 */
export function RootStack({ screenOptions, children }: { screenOptions: RootStackOptions; children: ReactNode }) {
  if (Platform.OS === 'android') {
    return <JSStack screenOptions={{ ...ANDROID_BASE, ...androidStackOptions(screenOptions) }}>{children}</JSStack>;
  }
  return <NativeStack screenOptions={screenOptions}>{children}</NativeStack>;
}

// The JavaScript stack takes the native option names for every per-route option the root layout sets.
// The `animation` of a detail route must come from `detailAnimation`, so Android slides it.
RootStack.Screen = (Platform.OS === 'android' ? JSStack.Screen : NativeStack.Screen) as typeof NativeStack.Screen;
RootStack.Protected = Platform.OS === 'android' ? JSStack.Protected : NativeStack.Protected;
