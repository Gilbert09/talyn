const path = require('node:path');

module.exports = {
  preset: 'jest-expo',
  // Resolve Expo-owned modules that npm keeps beside Expo.
  modulePaths: [path.join(path.dirname(require.resolve('expo/package.json')), 'node_modules')],
  setupFiles: ['<rootDir>/jest.setup.js'],
  // `marked` ships ESM as its main entry. Its UMD build runs in Jest without a transform.
  moduleNameMapper: { '^marked$': path.join(path.dirname(require.resolve('marked')), 'marked.umd.js') },
  testMatch: ['<rootDir>/src/__tests__/**/*.test.[jt]s?(x)'],
  clearMocks: true,
  passWithNoTests: false,
};
