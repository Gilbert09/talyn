// PostHog's Expo config injects a chunk ID into each bundle and its source map,
// which is how PostHog matches a Hermes stack trace to the uploaded map.
const { getPostHogExpoConfig } = require('posthog-react-native/metro');

module.exports = getPostHogExpoConfig(__dirname);
