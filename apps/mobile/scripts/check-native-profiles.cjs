const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { profiles } = require('../release/policy.cjs');
const { checkCertificate, assertRuntime } = require('./release.cjs');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const publicCertificate = path.join(root, 'release/update-certificate.pem');
for (const name of ['android', 'ios', 'release/update-certificate.pem']) {
  if (fs.existsSync(path.join(root, name))) throw new Error('Remove only disposable generated native files before this check.');
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talyn-native-fixture-'));
try {
  // This temporary key has no service access. Only its test certificate enters generated native configuration.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Native configuration fixture',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'certificate.pem')], { stdio: 'ignore' });
  fs.copyFileSync(path.join(dir, 'certificate.pem'), publicCertificate);
  checkCertificate(publicCertificate, path.join(dir, 'key.pem'));
  const otherKey = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(path.join(dir, 'other-key.pem'), otherKey, { mode: 0o600 });
  assert.throws(() => checkCertificate(publicCertificate, path.join(dir, 'other-key.pem')), /does not match/);
  for (const [profile, policy] of Object.entries(profiles)) {
    const env = {
      ...process.env, CI: 'true', EXPO_NO_DOTENV: '1', EXPO_NO_TELEMETRY: '1', APP_ENV: policy.environment,
      MOBILE_RELEASE_PROFILE: profile, EAS_BUILD_PROFILE: profile, MOBILE_BUILD_NUMBER: '42',
      TALYN_MOBILE_IOS_BUNDLE_ID: `org.fixture.mobile${policy.store ? '' : `.${profile}`}`,
      TALYN_MOBILE_ANDROID_PACKAGE: `org.fixture.mobile${policy.store ? '' : `.${profile}`}`, TALYN_MOBILE_SCHEME: `fixture-${profile}`,
      EXPO_PUBLIC_API_ORIGIN: 'https://api.fixture.dev', EXPO_PUBLIC_SUPABASE_URL: 'https://auth.fixture.dev',
      EXPO_PUBLIC_SUPABASE_KEY: 'sb_publishable_fixture', EXPO_PUBLIC_AUTH_CALLBACK_URL: 'https://mobile.fixture.dev/callback',
      EXPO_PUBLIC_EAS_PROJECT_ID: '10000000-0000-4000-8000-000000000001',
      TALYN_MOBILE_SUPPORT_URL: 'https://fixture.dev/support', TALYN_MOBILE_PRIVACY_URL: 'https://fixture.dev/privacy', TALYN_MOBILE_DELETION_URL: 'https://fixture.dev/deletion',
      MOBILE_UPDATES_ENABLED: profile === 'development' ? '0' : '1', MOBILE_UPDATE_KEY_ID: 'fixture', MOBILE_UPDATE_CERTIFICATE: './release/update-certificate.pem',
    };
    execFileSync(process.execPath, [require.resolve('expo/bin/cli'), 'prebuild', '--clean', '--no-install', '--platform', 'all'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync(process.execPath, [path.join(__dirname, 'inspect-native.cjs')], { cwd: root, env, stdio: 'inherit' });
    if (profile === 'preview') {
      const fingerprint = (patch = {}) => execFileSync(process.execPath, ['-e',
        "require('@expo/fingerprint').createFingerprintAsync(process.cwd(), { platforms: ['android'], concurrentIoLimit: 2 }).then(result => process.stdout.write(result.hash))"],
      { cwd: root, env: { ...env, ...patch }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      const installedRuntime = fingerprint();
      assert(/^[a-f0-9]{40,64}$/.test(installedRuntime));
      const changedRuntime = fingerprint({ EXPO_PUBLIC_AUTH_CALLBACK_URL: 'https://native-change.fixture.dev/callback' });
      assert.throws(() => assertRuntime(changedRuntime, installedRuntime), /Build a new binary/);
      console.log('Changed native link configuration produces a different Expo fingerprint and blocks the update.');
    }
    console.log(`${profile}: generated native inspection passed with inert fixtures.`);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(publicCertificate, { force: true });
  fs.rmSync(path.join(root, 'android'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'ios'), { recursive: true, force: true });
}
