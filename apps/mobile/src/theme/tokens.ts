import { useColorScheme } from 'react-native';

export const palettes = {
  // Deeper ink and clay keep small text readable on paper.
  light: {
    background: '#fcfbf8', elevated: '#ffffff', paper: '#f2ede3', text: '#23201b', muted: '#70685b',
    primary: '#c25e3a', primaryText: '#ffffff', primaryAction: '#a94d2e', border: '#ddd4c6',
    destructive: '#b42318', success: '#1f7a40', warning: '#965609', information: '#2463c0',
  },
  dark: {
    background: '#211d18', elevated: '#29241e', paper: '#181410', text: '#f8f5ef', muted: '#ada28e',
    primary: '#cf7553', primaryText: '#1b1713', primaryAction: '#cf7553', border: '#433b30',
    destructive: '#ff948a', success: '#51cd7e', warning: '#f7c83b', information: '#8bbaf7',
  },
} as const;

export function themeForScheme(scheme: string | null | undefined) {
  const mode = scheme === 'dark' ? 'dark' : 'light';
  const tokens = palettes[mode];
  return { ...tokens, mode, card: tokens.paper, accent: tokens.primary,
    statusBarStyle: mode === 'dark' ? 'light-content' as const : 'dark-content' as const };
}

export function useTheme() {
  return themeForScheme(useColorScheme());
}
