// Bundled fonts load natively. Tests render with them treated as ready.
jest.mock('expo-font', () => ({ ...jest.requireActual('expo-font'), useFonts: () => [true, null] }));

require('react-native-gesture-handler/jestSetup');

// Reanimated and Worklets have no native side in Jest. These stand-ins jump
// each animation to its end and run worklet callbacks at once. The Reanimated
// one is in `jest.reanimated.js`.
jest.mock('react-native-worklets', () => ({ scheduleOnRN: (fn, ...args) => fn(...args) }));
jest.mock('react-native-reanimated', () => require('./jest.reanimated'));
// Gesture Handler then runs its callbacks on the JS thread, as without Reanimated.
jest.mock('react-native-gesture-handler/src/handlers/gestures/reanimatedWrapper', () => ({ Reanimated: undefined, Worklets: undefined }));
jest.mock('react-native-gesture-handler/lib/module/handlers/gestures/reanimatedWrapper', () => ({ Reanimated: undefined, Worklets: undefined }));

// The drawer animates with Reanimated, which has no native side in Jest. This
// one draws the screen and, while open, the drawer content after it.
jest.mock('react-native-drawer-layout', () => {
  const React = require('react');
  const { View } = require('react-native');
  const DrawerProgressContext = React.createContext(undefined);
  function Drawer({ open, renderDrawerContent, children, style }) {
    return React.createElement(View, { style: [{ flex: 1 }, style] }, children,
      open ? React.createElement(View, { testID: 'navigation-drawer' }, renderDrawerContent()) : null);
  }
  return { Drawer, DrawerProgressContext, useDrawerProgress: () => ({ value: 0 }) };
});
jest.mock('expo-splash-screen', () => ({ preventAutoHideAsync: jest.fn(() => Promise.resolve(true)), hideAsync: jest.fn(() => Promise.resolve(true)) }));

// PostHog has native modules. Tests that check analytics mock it themselves; the rest get inert stand-ins.
jest.mock('posthog-react-native', () => {
  function PostHog() {}
  return { __esModule: true, default: PostHog, PostHog, PostHogProvider: ({ children }) => children };
});
