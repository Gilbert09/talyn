import { getAppIdentity } from '../../app.config';

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
