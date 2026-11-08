import type { ConfigContext, ExpoConfig } from 'expo/config';

type Environment = 'development' | 'preview' | 'production';

type IdentityEnvironment = Record<string, string | undefined>;

export function getAppIdentity(env: IdentityEnvironment) {
  const environment = env.APP_ENV ?? 'development';
  if (!['development', 'preview', 'production'].includes(environment)) {
    throw new Error('APP_ENV must be development, preview, or production.');
  }

  const suffix = environment === 'production' ? '' : `.${environment}`;
  const schemeSuffix = environment === 'production' ? '' : `-${environment}`;

  return {
    environment: environment as Environment,
    name: environment === 'production' ? 'Talyn' : `Talyn (${environment})`,
    iosBundleIdentifier: env.TALYN_MOBILE_IOS_BUNDLE_ID ?? `dev.talyn.mobile${suffix}`,
    androidPackage: env.TALYN_MOBILE_ANDROID_PACKAGE ?? `dev.talyn.mobile${suffix}`,
    scheme: env.TALYN_MOBILE_SCHEME ?? `talyn-mobile${schemeSuffix}`,
  };
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const identity = getAppIdentity(process.env);

  return {
    ...config,
    name: identity.name,
    slug: 'talyn-mobile',
    version: '0.1.0',
    scheme: identity.scheme,
    platforms: ['ios', 'android'],
    userInterfaceStyle: 'automatic',
    ios: {
      bundleIdentifier: identity.iosBundleIdentifier,
      supportsTablet: true,
    },
    android: {
      package: identity.androidPackage,
    },
    plugins: ['expo-router', 'expo-dev-client'],
    experiments: { typedRoutes: true },
    extra: { appEnvironment: identity.environment },
  };
};
