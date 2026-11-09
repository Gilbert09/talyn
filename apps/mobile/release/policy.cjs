const fs = require('node:fs');
const path = require('node:path');
const { version } = require('../package.json');

// `updates` says whether the profile's binary runs signed EAS updates. The development client loads from Metro.
// `autoUpdate` says whether a push to main publishes an update to the channel without an approval.
const profiles = {
  development: { environment: 'development', channel: 'development', store: false, updates: false, autoUpdate: false },
  preview: { environment: 'preview', channel: 'preview', store: false, updates: true, autoUpdate: true },
  'internal-beta': { environment: 'production', channel: 'internal-beta', store: true, updates: true, autoUpdate: true },
  production: { environment: 'production', channel: 'production', store: true, updates: true, autoUpdate: false },
};

const mobileRoot = path.resolve(__dirname, '..');
const UPDATE_CERTIFICATE = './release/update-certificate.pem';
// The app starts every check itself (src/features/updates). Native code checks only to recover from a launch error.
const CHECK_AUTOMATICALLY = 'ON_ERROR_RECOVERY';

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

/** The public update certificate must be a PEM file inside the app, because EAS reads it from the project archive. */
function updateCertificate(value) {
  const file = path.resolve(mobileRoot, value);
  const relative = path.relative(mobileRoot, file);
  if (path.isAbsolute(value) || !relative || relative.startsWith('..') || !relative.endsWith('.pem')) {
    throw new Error('MOBILE_UPDATE_CERTIFICATE must be a relative .pem path inside apps/mobile.');
  }
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* Reported below. */ }
  if (!text.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(`Signed updates need the public update certificate at apps/mobile/${relative.split(path.sep).join('/')}. Write MOBILE_UPDATE_CERTIFICATE_PEM there first.`);
  }
  return `./${relative.split(path.sep).join('/')}`;
}

function readReleaseSettings(env, environment, projectId) {
  const publicNames = ['EXPO_PUBLIC_API_ORIGIN', 'EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_KEY', 'EXPO_PUBLIC_AUTH_CALLBACK_URL', 'EXPO_PUBLIC_EAS_PROJECT_ID', 'EXPO_PUBLIC_PURCHASE_MODE'];
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
  const certificate = enabled ? updateCertificate(env.MOBILE_UPDATE_CERTIFICATE ?? UPDATE_CERTIFICATE) : undefined;
  const keyid = enabled ? required(env, 'MOBILE_UPDATE_KEY_ID') : undefined;
  return {
    profile, version, build, urls,
    runtimeVersion: { policy: 'fingerprint' },
    updates: enabled ? {
      enabled: true, url: `https://u.expo.dev/${projectId}`, checkAutomatically: CHECK_AUTOMATICALLY,
      requestHeaders: { 'expo-channel-name': policy.channel },
      fallbackToCacheTimeout: 0, useEmbeddedUpdate: true,
      codeSigningCertificate: certificate,
      codeSigningMetadata: { keyid, alg: 'rsa-v1_5-sha256' },
    } : { enabled: false },
  };
}

module.exports = { profiles, required, publicUrl, readReleaseSettings, UPDATE_CERTIFICATE, CHECK_AUTOMATICALLY };
