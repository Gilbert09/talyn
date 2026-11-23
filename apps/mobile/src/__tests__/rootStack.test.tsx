import { render } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { detailAnimation, detailOptions } from '../navigation/detailOptions';
import { androidStackOptions, EDGE_ZONE, RootStack } from '../navigation/rootStack';

const mockNativeStack = jest.fn((_props: unknown) => null);
const mockJsStack = jest.fn((_props: unknown) => null);
jest.mock('expo-router', () => ({
  Stack: Object.assign((props: unknown) => mockNativeStack(props), { Screen: () => null, Protected: () => null }),
}));
jest.mock('expo-router/js-stack', () => ({
  Stack: Object.assign((props: unknown) => mockJsStack(props), { Screen: () => null, Protected: () => null }),
}));

const original = Platform.OS;
afterEach(() => {
  Platform.OS = original;
  jest.clearAllMocks();
});

describe('detailAnimation', () => {
  it.each([
    ['android', 'slide_from_right'],
    ['ios', 'default'],
    ['web', 'default'],
  ])('%s -> %s', (os, expected) => {
    expect(detailAnimation(os)).toBe(expected);
  });
});

describe('detailOptions', () => {
  it.each([
    ['android', 'slide_from_right'],
    ['ios', 'default'],
  ] as const)('gives a header, a back title and the %s push animation', (os, animation) => {
    Platform.OS = os;
    expect(detailOptions('Session')).toEqual({ headerShown: true, title: 'Session', animation, headerBackTitle: 'Back' });
  });
});

describe('androidStackOptions', () => {
  it.each([
    ['moves contentStyle to cardStyle', { contentStyle: { backgroundColor: 'red' } }, { cardStyle: { backgroundColor: 'red' } }],
    ['drops statusBarStyle', { statusBarStyle: 'dark' }, {}],
    ['slides a default animation from the right', { animation: 'default' }, { animation: 'slide_from_right' }],
    ['keeps no animation', { animation: 'none' }, { animation: 'none' }],
    ['keeps a fade', { animation: 'fade' }, { animation: 'fade' }],
    ['keeps a slide from the bottom', { animation: 'slide_from_bottom' }, { animation: 'slide_from_bottom' }],
    ['keeps a slide from the right', { animation: 'slide_from_right' }, { animation: 'slide_from_right' }],
    ['adds no keys for missing options', {}, {}],
    ['keeps the shared header options', {
      headerShown: true, title: 'Session', headerBackTitle: 'Back', gestureEnabled: false, headerShadowVisible: false,
      headerTintColor: '#fff', headerStyle: { backgroundColor: '#000' }, headerTitleStyle: { fontSize: 16 },
    }, {
      headerShown: true, title: 'Session', headerBackTitle: 'Back', gestureEnabled: false, headerShadowVisible: false,
      headerTintColor: '#fff', headerStyle: { backgroundColor: '#000' }, headerTitleStyle: { fontSize: 16 },
    }],
  ] as const)('%s', (_name, input, expected) => {
    expect(androidStackOptions(input)).toEqual(expected);
  });
});

describe('RootStack', () => {
  const screenOptions = { headerShown: false, animation: 'none', statusBarStyle: 'dark', contentStyle: { backgroundColor: '#111' } } as const;

  it('renders the JavaScript stack with an edge swipe back on Android', async () => {
    Platform.OS = 'android';
    await render(<RootStack screenOptions={screenOptions}>{null}</RootStack>);
    expect(mockNativeStack).not.toHaveBeenCalled();
    expect(mockJsStack).toHaveBeenCalledWith(expect.objectContaining({
      screenOptions: {
        gestureEnabled: true, gestureDirection: 'horizontal', gestureResponseDistance: EDGE_ZONE,
        headerShown: false, animation: 'none', cardStyle: { backgroundColor: '#111' },
      },
    }));
  });

  it('lets a route turn the Android swipe off', async () => {
    Platform.OS = 'android';
    await render(<RootStack screenOptions={{ gestureEnabled: false }}>{null}</RootStack>);
    expect(mockJsStack).toHaveBeenCalledWith(expect.objectContaining({ screenOptions: expect.objectContaining({ gestureEnabled: false }) }));
  });

  it('renders the native stack with the options unchanged on iOS', async () => {
    Platform.OS = 'ios';
    await render(<RootStack screenOptions={screenOptions}>{null}</RootStack>);
    expect(mockJsStack).not.toHaveBeenCalled();
    expect(mockNativeStack).toHaveBeenCalledWith(expect.objectContaining({ screenOptions }));
  });
});
