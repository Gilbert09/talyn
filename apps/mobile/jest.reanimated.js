// Reanimated has no native side in Jest. This stand-in jumps each animation to
// its end. Layout and entry builders chain their settings, then do nothing.
// `jest.setup.js` mocks Reanimated with it, and `jest.config.js` maps
// `react-native-reanimated/mock` to it, because the expo-router test helpers
// mock Reanimated again with that module.
const React = require('react');
const { View } = require('react-native');

const last = (...values) => values[values.length - 1];
const animation = () => {
  const chain = new Proxy({}, { get: (_target, key) => (typeof key === 'symbol' || key === 'then' ? undefined : () => chain) });
  return chain;
};
const AnimatedView = React.forwardRef(({ entering: _entering, exiting: _exiting, layout: _layout, ...props }, ref) =>
  React.createElement(View, { ...props, ref }));

module.exports = {
  __esModule: true, default: { View: AnimatedView },
  LinearTransition: animation(), FadeIn: animation(), FadeOut: animation(), FadeInDown: animation(),
  useSharedValue: (value) => React.useRef({ value }).current,
  useAnimatedStyle: (fn) => fn(),
  withTiming: (value) => value, withSpring: (value) => value, withSequence: last,
};
