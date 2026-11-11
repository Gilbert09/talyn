// Bundled fonts load natively. Tests render with them treated as ready.
jest.mock('expo-font', () => ({ ...jest.requireActual('expo-font'), useFonts: () => [true, null] }));

require('react-native-gesture-handler/jestSetup');

jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { __esModule: true, default: ({ children }) => React.createElement(View, null, children) };
});

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

// Reanimated and Worklets have no native side in Jest. Screens that import them render with these stand-ins.
jest.mock('react-native-worklets', () => ({ scheduleOnRN: (fn) => fn() }));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const identity = (value) => value;
  return {
    __esModule: true,
    default: { View, createAnimatedComponent: identity },
    Easing: { out: identity, cubic: identity },
    useSharedValue: (value) => ({ value }),
    useAnimatedStyle: (fn) => fn(),
    withSpring: identity,
    withTiming: identity,
    useEvent: () => jest.fn(),
    useHandler: () => ({ context: {}, doDependenciesDiffer: false, useWeb: false }),
  };
});

// PostHog has native modules. Tests that check analytics mock it themselves; the rest get inert stand-ins.
jest.mock('posthog-react-native', () => {
  function PostHog() {}
  return { __esModule: true, default: PostHog, PostHog, PostHogProvider: ({ children }) => children };
});
