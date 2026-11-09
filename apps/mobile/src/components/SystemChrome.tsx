import { NavigationBar } from 'expo-navigation-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { StatusBar } from 'react-native';

import { useTheme } from '../theme/tokens';

export function SystemChrome() {
  const colors = useTheme();
  useEffect(() => { void SystemUI.setBackgroundColorAsync(colors.background); }, [colors.background]);
  return <><StatusBar barStyle={colors.statusBarStyle} /><NavigationBar style={colors.mode === 'dark' ? 'light' : 'dark'} /></>;
}
