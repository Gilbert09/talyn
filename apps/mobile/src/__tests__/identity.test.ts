import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import appConfig, { getAppIdentity, readMobileConfig, writeGoogleServicesFile } from '../../app.config';

describe('app identity', () => {
  it.each([
    ['development', 'dev.talyn.mobile.development', 'talyn-mobile-development'],
    ['preview', 'dev.talyn.mobile.preview', 'talyn-mobile-preview'],
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
      TALYN_MOBILE_IOS_BUNDLE_ID: 'org.fixture.ios.preview',
      TALYN_MOBILE_ANDROID_PACKAGE: 'org.fixture.android.preview',
      TALYN_MOBILE_SCHEME: 'example-preview',
    })).toMatchObject({
      iosBundleIdentifier: 'org.fixture.ios.preview',
      androidPackage: 'org.fixture.android.preview',
      scheme: 'example-preview',
    });
  });
});

const publicValues = {
  TALYN_MOBILE_IOS_BUNDLE_ID: 'org.fixture.mobile',
  TALYN_MOBILE_ANDROID_PACKAGE: 'org.fixture.mobile',
  TALYN_MOBILE_SCHEME: 'fixture-mobile',
  MOBILE_BUILD_NUMBER: '1',
  TALYN_MOBILE_SUPPORT_URL: 'https://fixture.dev/support',
  TALYN_MOBILE_PRIVACY_URL: 'https://fixture.dev/privacy',
  TALYN_MOBILE_DELETION_URL: 'https://fixture.dev/delete',
  EXPO_PUBLIC_API_ORIGIN: 'https://api.example.com',
  EXPO_PUBLIC_SUPABASE_URL: 'https://auth.example.com',
  EXPO_PUBLIC_SUPABASE_KEY: 'sb_publishable_example-public-value',
  EXPO_PUBLIC_AUTH_CALLBACK_URL: 'https://mobile.example.com/callback',
};
describe('public mobile configuration', () => {
  it('allows an unconfigured development shell', () => {
    expect(readMobileConfig({}, 'development', 'talyn-mobile-development')).toBeNull();
  });
  it.each(['EXPO_PUBLIC_API_ORIGIN', 'EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_KEY', 'EXPO_PUBLIC_AUTH_CALLBACK_URL'])('rejects missing production value %s', (key) => {
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

it('requires explicit production identity', () => {
  expect(() => getAppIdentity({ APP_ENV: 'production' })).toThrow('explicit app identifiers');
});

describe('push configuration', () => {
  const previous = process.env;
  afterEach(() => { process.env = previous; });
  const build = () => appConfig({ config: {} } as Parameters<typeof appConfig>[0]);
  it.each(['production', 'preview', 'development'])('uses the Talyn EAS project for %s when none is set', (environment) => {
    process.env = { ...previous, ...publicValues, APP_ENV: environment };
    delete process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
    const result = build();
    expect(result.owner).toBe('talyn-app');
    expect(result.extra?.eas?.projectId).toBe('69499768-c478-44c0-8588-355c674515df');
  });
  it.each(['not-a-uuid', '69499768c47844c08588355c674515df'])('rejects the malformed project ID %s', (projectId) => {
    process.env = { ...previous, ...publicValues, APP_ENV: 'production', EXPO_PUBLIC_EAS_PROJECT_ID: projectId };
    expect(build).toThrow('valid public EAS project ID');
  });
  it('exports the public project and only alert capabilities', () => {
    const projectId = '10000000-0000-4000-8000-000000000001';
    process.env = { ...previous, ...publicValues, APP_ENV: 'production', EXPO_PUBLIC_EAS_PROJECT_ID: projectId };
    const result = build();
    expect(result.extra?.eas?.projectId).toBe(projectId);
    expect(result.android?.blockedPermissions).toContain('android.permission.RECEIVE_BOOT_COMPLETED');
    expect(result.plugins).toContainEqual(['expo-notifications', {
      mode: 'production', enableBackgroundRemoteNotifications: false, icon: './assets/notification-icon.png', color: '#a94d2e',
    }]);
  });
});

describe('google-services.json', () => {
  const file = (packages: string[]) => Buffer.from(JSON.stringify({
    project_info: { project_id: 'fixture' },
    client: packages.map((name) => ({ client_info: { android_client_info: { package_name: name } } })),
  })).toString('base64');
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-services-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it.each([undefined, '', '  '])('writes nothing when the value is %p', (value) => {
    expect(writeGoogleServicesFile({ TALYN_MOBILE_GOOGLE_SERVICES_JSON: value }, 'dev.talyn.mobile', dir)).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('writes the decoded file for a listed package', () => {
    const encoded = file(['dev.talyn.mobile', 'dev.talyn.mobile.preview']);
    const written = writeGoogleServicesFile({ TALYN_MOBILE_GOOGLE_SERVICES_JSON: encoded }, 'dev.talyn.mobile.preview', dir);
    expect(written).toBe(path.join(dir, 'google-services.json'));
    expect(fs.readFileSync(written!, 'utf8')).toBe(Buffer.from(encoded, 'base64').toString('utf8'));
  });

  it('refuses a file without the build package', () => {
    expect(() => writeGoogleServicesFile({ TALYN_MOBILE_GOOGLE_SERVICES_JSON: file(['dev.talyn.mobile']) }, 'dev.talyn.mobile.preview', dir))
      .toThrow('no Android app for dev.talyn.mobile.preview');
  });

  it.each([Buffer.from('not json').toString('base64'), '%%%'])('refuses a value that is not the encoded file', (value) => {
    expect(() => writeGoogleServicesFile({ TALYN_MOBILE_GOOGLE_SERVICES_JSON: value }, 'dev.talyn.mobile', dir)).toThrow('must be the base64');
  });
});
