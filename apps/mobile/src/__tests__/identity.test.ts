import appConfig, { getAppIdentity, readMobileConfig } from '../../app.config';

describe('app identity', () => {
  it.each([
    ['development', 'dev.talyn.mobile.development', 'talyn-mobile-development'],
    ['preview', 'dev.talyn.mobile.preview', 'talyn-mobile-preview'],
    ['production', 'dev.talyn.mobile', 'talyn-mobile'],
  ])('separates the %s identity', (environment, identifier, scheme) => {
    expect(getAppIdentity({ APP_ENV: environment })).toMatchObject({
      environment, iosBundleIdentifier: identifier, androidPackage: identifier, scheme,
    });
  });

  it('uses development when no environment is set', () => {
    expect(getAppIdentity({}).environment).toBe('development');
  });

  it.each(['staging', '', 'prod'])('rejects the unknown environment %s', (environment) => {
    expect(() => getAppIdentity({ APP_ENV: environment })).toThrow('APP_ENV must be');
  });

  it('uses explicit identity overrides', () => {
    expect(getAppIdentity({
      APP_ENV: 'preview',
      TALYN_MOBILE_IOS_BUNDLE_ID: 'org.example.ios.preview',
      TALYN_MOBILE_ANDROID_PACKAGE: 'org.example.android.preview',
      TALYN_MOBILE_SCHEME: 'example-preview',
    })).toMatchObject({
      iosBundleIdentifier: 'org.example.ios.preview',
      androidPackage: 'org.example.android.preview',
      scheme: 'example-preview',
    });
  });
});

const publicValues = {
  EXPO_PUBLIC_API_ORIGIN: 'https://api.example.com',
  EXPO_PUBLIC_SUPABASE_URL: 'https://auth.example.com',
  EXPO_PUBLIC_SUPABASE_KEY: 'sb_publishable_example-public-value',
  EXPO_PUBLIC_AUTH_CALLBACK_URL: 'https://mobile.example.com/callback',
};
describe('public mobile configuration', () => {
  it('allows an unconfigured development shell', () => {
    expect(readMobileConfig({}, 'development', 'talyn-mobile-development')).toBeNull();
  });
  it.each(Object.keys(publicValues))('rejects missing production value %s', (key) => {
    expect(() => readMobileConfig({ ...publicValues, [key]: undefined }, 'production', 'talyn-mobile')).toThrow();
  });
  it('accepts explicit production HTTPS configuration', () => {
    expect(readMobileConfig(publicValues, 'production', 'talyn-mobile')?.callbackUrl).toBe(publicValues.EXPO_PUBLIC_AUTH_CALLBACK_URL);
  });
  it.each([
    'talyn-mobile://auth/callback', 'http://mobile.example.com/callback',
    'https://mobile.example.com/other', 'https://user@mobile.example.com/callback',
    'https://mobile.example.com/callback?code=bad', 'https://mobile.example.com/callback#bad',
  ])('rejects invalid production callback %s', (callback) => {
    expect(() => readMobileConfig({ ...publicValues, EXPO_PUBLIC_AUTH_CALLBACK_URL: callback }, 'production', 'talyn-mobile')).toThrow();
  });
  it.each(['development', 'preview'] as const)('allows the exact %s custom scheme', (environment) => {
    const scheme = `talyn-mobile-${environment}`;
    expect(readMobileConfig({ ...publicValues, EXPO_PUBLIC_AUTH_CALLBACK_URL: `${scheme}://auth/callback` }, environment, scheme)?.callbackUrl).toBe(`${scheme}://auth/callback`);
  });
});

it.each(['sb_secret_do-not-publish', 'not-a-key', `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`])('rejects private or invalid Supabase keys', (key) => {
  expect(() => readMobileConfig({ ...publicValues, EXPO_PUBLIC_SUPABASE_KEY: key }, 'production', 'talyn-mobile')).toThrow('Use a Supabase publishable key');
});
it('accepts a legacy public anon key', () => {
  const key = `header.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.signature`;
  expect(readMobileConfig({ ...publicValues, EXPO_PUBLIC_SUPABASE_KEY: key }, 'production', 'talyn-mobile')?.supabaseKey).toBe(key);
});

describe('push configuration', () => {
  const previous = process.env;
  afterEach(() => { process.env = previous; });
  const build = () => appConfig({ config: {} } as Parameters<typeof appConfig>[0]);
  it('rejects a missing production EAS project', () => {
    process.env = { ...previous, ...publicValues, APP_ENV: 'production' };
    delete process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
    expect(build).toThrow('Production requires EXPO_PUBLIC_EAS_PROJECT_ID');
  });
  it('exports the public project and only alert capabilities', () => {
    const projectId = '10000000-0000-4000-8000-000000000001';
    process.env = { ...previous, ...publicValues, APP_ENV: 'production', EXPO_PUBLIC_EAS_PROJECT_ID: projectId };
    const result = build();
    expect(result.extra?.eas?.projectId).toBe(projectId);
    expect(result.android?.blockedPermissions).toContain('android.permission.RECEIVE_BOOT_COMPLETED');
    expect(result.plugins).toContainEqual(['expo-notifications', { mode: 'production', enableBackgroundRemoteNotifications: false }]);
  });
});
