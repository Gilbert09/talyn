const { version } = require('../package.json');

const profiles = {
  development: { environment: 'development', channel: 'development', store: false },
  preview: { environment: 'preview', channel: 'preview', store: false },
  'internal-beta': { environment: 'production', channel: 'internal-beta', store: true },
  production: { environment: 'production', channel: 'production', store: true },
};

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
  const publicNames = ['EXPO_PUBLIC_API_ORIGIN', 'EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_KEY', 'EXPO_PUBLIC_AUTH_CALLBACK_URL', 'EXPO_PUBLIC_EAS_PROJECT_ID'];
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
  if (enabled && (!projectId || profile === 'development')) throw new Error('Updates require a project and a release build.');
  const certificate = enabled ? required(env, 'MOBILE_UPDATE_CERTIFICATE') : undefined;
  const keyid = enabled ? required(env, 'MOBILE_UPDATE_KEY_ID') : undefined;
  return {
    profile, version, build, urls,
    runtimeVersion: { policy: 'fingerprint' },
    updates: enabled ? {
      enabled: true, url: `https://u.expo.dev/${projectId}`, checkAutomatically: 'ON_LOAD',
      requestHeaders: { 'expo-channel-name': policy.channel },
      fallbackToCacheTimeout: 0, useEmbeddedUpdate: true,
      codeSigningCertificate: certificate,
      codeSigningMetadata: { keyid, alg: 'rsa-v1_5-sha256' },
    } : { enabled: false },
  };
}

module.exports = { profiles, required, publicUrl, readReleaseSettings };
