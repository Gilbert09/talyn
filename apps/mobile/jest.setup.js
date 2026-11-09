// Bundled fonts load natively. Tests render with them treated as ready.
jest.mock('expo-font', () => ({ ...jest.requireActual('expo-font'), useFonts: () => [true, null] }));
