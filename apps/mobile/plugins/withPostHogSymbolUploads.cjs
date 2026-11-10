// The official `posthog-react-native/expo` config plugin, applied only when the build has an upload key.
// It wires the Hermes source map upload into Gradle and Xcode, and (`uploadNativeSymbols`) the iOS dSYM,
// Android R8 mapping and NDK symbol uploads, so native crashes and release JavaScript stack traces are readable.
//
// Without POSTHOG_CLI_API_KEY the plugin is left out, because its Gradle and Xcode steps fail a build that has
// no CLI or no credentials. It adds only build-time upload steps, so the native fingerprint is the same with
// and without the key: a build that uploads still takes the updates a keyless publish makes.
//
// The app config loads this file, so the fingerprint hashes it. Keep CI and EAS upload logic in
// scripts/posthog-symbols.cjs, where a change does not need a new binary.
const fs = require('node:fs');
const path = require('node:path');
const { posthogUploadCredentials } = require('../release/policy.cjs');

// Under the gitignored .expo/ directory. The CLI reads its credentials from ONE source: the process environment
// only when it holds the key AND the project, otherwise this file. An EAS build holds only the key.
const DOTENV_FILE = '.expo/posthog-cli.env';
const PLATFORMS = ['ios', 'android'];

/** The upload credentials for a profile, or null when it uploads nothing. The development client loads from Metro. */
function symbolUploadCredentials(env, profile) {
  if (!profile || profile === 'development') return null;
  return posthogUploadCredentials(env);
}

function writeCredentials(projectRoot, credentials) {
  const file = path.join(projectRoot, DOTENV_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${Object.entries(credentials).map(([name, value]) => `${name}=${value}`).join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function withPostHogSymbolUploads(config, { profile, env = process.env }) {
  const credentials = symbolUploadCredentials(env, profile);
  if (!credentials) return config;
  const { withDangerousMod } = require('@expo/config-plugins');
  const withPostHog = require('posthog-react-native/expo');
  // Written by prebuild only, never when a command just reads the config.
  for (const platform of PLATFORMS) {
    config = withDangerousMod(config, [platform, async (modConfig) => {
      writeCredentials(modConfig.modRequest.projectRoot, credentials);
      return modConfig;
    }]);
  }
  // `patchMainActivityNewIntent` stays off so a build with the key runs the same MainActivity as one without.
  return withPostHog(config, { uploadNativeSymbols: true, dotenvFile: DOTENV_FILE, patchMainActivityNewIntent: false });
}

module.exports = { DOTENV_FILE, symbolUploadCredentials, writeCredentials, withPostHogSymbolUploads };
