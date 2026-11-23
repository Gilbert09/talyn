const { version } = require('../package.json');

// `updates` says whether the profile's binary runs EAS updates. The development client loads from Metro.
// `autoUpdate` says whether a push to main publishes an update to the channel without an approval.
const profiles = {
  development: { environment: 'development', channel: 'development', store: false, updates: false, autoUpdate: false },
  preview: { environment: 'preview', channel: 'preview', store: false, updates: true, autoUpdate: true },
  'internal-beta': { environment: 'production', channel: 'internal-beta', store: true, updates: true, autoUpdate: true },
  production: { environment: 'production', channel: 'production', store: true, updates: true, autoUpdate: false },
};

// The app starts every check itself (src/features/updates). Native code checks only to recover from a launch error.
const CHECK_AUTOMATICALLY = 'ON_ERROR_RECOVERY';

// PostHog error tracking symbol uploads: Hermes source maps for EAS updates and native builds, iOS dSYMs,
// Android R8 mappings and NDK symbols. The project and host are public. The personal API key is a secret
// (scopes `error tracking write` and `organization read`) and only ever comes from the environment.
// With no key, every upload is skipped and the build or publish goes on.
const POSTHOG_SYMBOL_UPLOADS = Object.freeze({ projectId: '459813', host: 'https://us.posthog.com', keyName: 'POSTHOG_CLI_API_KEY' });

/** The `POSTHOG_CLI_*` values the PostHog CLI needs, or null when the key is not set. */
function posthogUploadCredentials(env) {
  const key = env[POSTHOG_SYMBOL_UPLOADS.keyName]?.trim();
  if (!key) return null;
  // A project key (phc_) cannot upload. Catch the paste early rather than as an opaque 401.
  if (!/^phx_[A-Za-z0-9_-]+$/.test(key)) throw new Error(`${POSTHOG_SYMBOL_UPLOADS.keyName} must be a PostHog personal API key (phx_).`);
  return { POSTHOG_CLI_API_KEY: key, POSTHOG_CLI_PROJECT_ID: POSTHOG_SYMBOL_UPLOADS.projectId, POSTHOG_CLI_HOST: POSTHOG_SYMBOL_UPLOADS.host };
}

function required(env, name) {
  const value = env[name];
  if (!value || value.trim() !== value) throw new Error(`Set ${name}.`);
  return value;
}

function publicUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port ||
    /(^|\.)(localhost|invalid|test|example\.(com|org|net))$/.test(url.hostname)) {
    throw new Error(`Use an approved public HTTPS URL for ${name}.`);
  }
  return url.href;
}

function readReleaseSettings(env, environment, projectId) {
  const publicNames = ['EXPO_PUBLIC_API_ORIGIN', 'EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_KEY', 'EXPO_PUBLIC_AUTH_CALLBACK_URL', 'EXPO_PUBLIC_EAS_PROJECT_ID', 'EXPO_PUBLIC_PURCHASE_MODE',
    'EXPO_PUBLIC_TALYN_POSTHOG_KEY', 'EXPO_PUBLIC_TALYN_POSTHOG_HOST'];
  // Expo CLI sets this internal path before Metro reads the app configuration again.
  if (Object.keys(env).some((name) => name.startsWith('EXPO_PUBLIC_') && name !== 'EXPO_PUBLIC_PROJECT_ROOT' && !publicNames.includes(name))) throw new Error('Review unexpected public build variables.');
  const profile = env.EAS_BUILD_PROFILE ?? env.MOBILE_RELEASE_PROFILE ?? environment;
  const policy = profiles[profile];
  if (!policy || policy.environment !== environment) throw new Error('Release profile and APP_ENV must match.');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use a numeric mobile package version.');
  const build = env.MOBILE_BUILD_NUMBER ?? (policy.store ? required(env, 'MOBILE_BUILD_NUMBER') : '1');
  if (!/^[1-9]\d{0,8}$/.test(build) || Number(build) > 2100000000) throw new Error('Use a positive store build number.');
  const urls = policy.store ? Object.fromEntries(['SUPPORT', 'PRIVACY', 'DELETION'].map((name) =>
    [name.toLowerCase(), publicUrl(required(env, `TALYN_MOBILE_${name}_URL`), name)])) : {};
  if (env.MOBILE_UPDATES_ENABLED && !['0', '1'].includes(env.MOBILE_UPDATES_ENABLED)) throw new Error('Use 0 or 1 for MOBILE_UPDATES_ENABLED.');
  const enabled = env.MOBILE_UPDATES_ENABLED === '1';
  if (enabled && !policy.updates) throw new Error('The development client loads from Metro. Set MOBILE_UPDATES_ENABLED=0 for it.');
  if (enabled && !projectId) throw new Error('Updates require the EAS project ID.');
  return {
    profile, version, build, urls,
    runtimeVersion: { policy: 'fingerprint' },
    updates: enabled ? {
      enabled: true, url: `https://u.expo.dev/${projectId}`, checkAutomatically: CHECK_AUTOMATICALLY,
      requestHeaders: { 'expo-channel-name': policy.channel },
      // Unsigned by decision (2026-11-09): EAS code signing needs a paid EAS plan. A certificate here would make
      // the binary reject every unsigned update, and adding one later needs a new binary, not an update.
      fallbackToCacheTimeout: 0, useEmbeddedUpdate: true,
    } : { enabled: false },
  };
}

module.exports = { profiles, required, publicUrl, readReleaseSettings, CHECK_AUTOMATICALLY, POSTHOG_SYMBOL_UPLOADS, posthogUploadCredentials };
