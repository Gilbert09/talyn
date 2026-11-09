import { render } from '@testing-library/react-native';
import { Platform, Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { EDGE_ZONE, EdgeSwipeBack, inStartZone, shouldGoBack } from '../components/EdgeSwipeBack';

jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), canGoBack: () => true, navigate: jest.fn() }) }));

describe('shouldGoBack', () => {
  it.each([
    [200, 0, 400, true],
    [141, 0, 400, true],
    [140, 0, 400, false],
    [20, 801, 400, true],
    [20, 800, 400, false],
    [0, 2000, 400, false],
    [-50, 2000, 400, false],
    [100, -900, 400, false],
  ])('translation %d, velocity %d, width %d -> %s', (translationX, velocityX, width, expected) => {
    expect(shouldGoBack(translationX, velocityX, width)).toBe(expected);
  });
});

describe('inStartZone', () => {
  it.each([
    [0, true], [10, true], [EDGE_ZONE, true], [EDGE_ZONE + 1, false], [200, false], [-1, false],
  ])('x %d -> %s', (x, expected) => {
    expect(inStartZone(x)).toBe(expected);
  });
});

describe('EdgeSwipeBack', () => {
  const original = Platform.OS;
  afterEach(() => { Platform.OS = original; });

  it.each(['ios', 'android'] as const)('renders its children on %s', async (os) => {
    Platform.OS = os;
    const { getByText } = await render(<GestureHandlerRootView><EdgeSwipeBack><Text>content</Text></EdgeSwipeBack></GestureHandlerRootView>);
    expect(getByText('content')).toBeTruthy();
  });
});
