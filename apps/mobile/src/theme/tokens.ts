import { useColorScheme } from 'react-native';

// Surfaces and borders match the web tokens. Some light foregrounds are a little
// darker than web so small text keeps 4.5:1 contrast on every surface.
export const palettes = {
  light: {
    background: '#fcfbf8', paper: '#f2ede3', elevated: '#fefdfb', surface: '#ece6da', popover: '#fefdfb',
    text: '#23201b', muted: '#70685b', border: '#ddd4c6',
    primary: '#c25e3a', primaryText: '#fbfaf7', primaryAction: '#a94d2e',
    destructive: '#b42318', destructiveFill: '#dc2626', destructiveFillText: '#ffffff',
    success: '#1f7a40', warning: '#965609', information: '#1659ca', merged: '#6b35a5',
  },
  dark: {
    background: '#211d18', paper: '#181410', elevated: '#29241e', surface: '#322b24', popover: '#29241e',
    text: '#f8f6f1', muted: '#a89f91', border: '#343029',
    primary: '#cf7553', primaryText: '#1b1713', primaryAction: '#cf7553',
    destructive: '#f87171', destructiveFill: '#ba2c2c', destructiveFillText: '#fdf3f3',
    success: '#51cd7e', warning: '#f7c23b', information: '#6eabf7', merged: '#bb97e7',
  },
} as const;

export const radius = { sm: 6, md: 8, lg: 10, pill: 5, round: 999 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 } as const;

/** Font family names, as registered by `useAppFonts`. One family per weight. */
export const fonts = {
  sans: { 400: 'Inter_400Regular', 500: 'Inter_500Medium', 600: 'Inter_600SemiBold', 700: 'Inter_700Bold' },
  display: { 500: 'SpaceGrotesk_500Medium', 600: 'SpaceGrotesk_600SemiBold' },
  mono: { 400: 'JetBrainsMono_400Regular', 500: 'JetBrainsMono_500Medium' },
} as const;
export type FontWeight = 400 | 500 | 600 | 700;
export function sans(weight: FontWeight = 400) { return { fontFamily: fonts.sans[weight] }; }
export function display(weight: 500 | 600 = 600) { return { fontFamily: fonts.display[weight] }; }
export function mono(weight: 400 | 500 = 400) { return { fontFamily: fonts.mono[weight] }; }

export const type = {
  title: { fontSize: 24, lineHeight: 30, letterSpacing: -0.3, ...display(600) },
  heading: { fontSize: 19, lineHeight: 25, letterSpacing: -0.2, ...display(600) },
  rowTitle: { fontSize: 15, lineHeight: 21, ...sans(600) },
  body: { fontSize: 15, lineHeight: 22, ...sans(400) },
  meta: { fontSize: 13, lineHeight: 18, ...sans(400) },
  caption: { fontSize: 12, lineHeight: 16, ...sans(500) },
  section: { fontSize: 12, lineHeight: 16, letterSpacing: 0.6, textTransform: 'uppercase' as const, ...sans(600) },
  mono: { fontSize: 13, lineHeight: 18, ...mono(400) },
} as const;
export type TypeVariant = keyof typeof type;

export function themeForScheme(scheme: string | null | undefined) {
  const mode = scheme === 'dark' ? 'dark' : 'light';
  const tokens = palettes[mode];
  return { ...tokens, mode, card: tokens.paper, accent: tokens.primary,
    statusBarStyle: mode === 'dark' ? 'light-content' as const : 'dark-content' as const };
}
export type Theme = ReturnType<typeof themeForScheme>;

export function useTheme() {
  return themeForScheme(useColorScheme());
}

/** `#rrggbb` at an alpha, for tinted pill and banner fills. */
export function withAlpha(hex: string, alpha: number) {
  const value = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
