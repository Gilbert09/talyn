import { act, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { Platform, Text } from 'react-native';

const original = Platform.OS;
afterEach(() => { Platform.OS = original; });

describe('RootStack on Android', () => {
  it('pushes a guarded detail route with its header on the Android stack', async () => {
    Platform.OS = 'android';
    // The stack picks its route components when the module loads, so it loads after the platform is set.
    const { RootStack } = require('../navigation/rootStack') as typeof import('../navigation/rootStack');
    await renderRouter({
      _layout: () => <RootStack screenOptions={{ headerShown: false, animation: 'none' }}>
        <RootStack.Screen name="index" />
        <RootStack.Protected guard={true}>
          <RootStack.Screen name="usage" options={{ headerShown: true, title: 'Detail title', animation: 'slide_from_right' }} />
        </RootStack.Protected>
      </RootStack>,
      index: () => <Text>home</Text>,
      usage: () => <Text>detail body</Text>,
    }, { initialUrl: '/' });
    expect(screen.getByText('home')).toBeTruthy();
    await act(async () => { router.push('/usage'); });
    expect(await screen.findByText('detail body')).toBeTruthy();
    expect(screen.getByText('Detail title', { includeHiddenElements: true })).toBeTruthy();
    // The screen below stays mounted, so a swipe back shows it under the card.
    expect(screen.getByText('home', { includeHiddenElements: true })).toBeTruthy();
  });
});
