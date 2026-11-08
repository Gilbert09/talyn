const path = require('node:path');

module.exports = {
  preset: 'jest-expo',
  // Resolve Expo-owned modules that npm keeps beside Expo.
  modulePaths: [path.join(path.dirname(require.resolve('expo/package.json')), 'node_modules')],
  testMatch: ['<rootDir>/src/__tests__/**/*.test.[jt]s?(x)'],
  clearMocks: true,
  passWithNoTests: false,
};
