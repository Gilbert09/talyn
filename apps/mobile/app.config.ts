import type { ConfigContext, ExpoConfig } from 'expo/config';

import type { AppEnvironment, MobileConfig } from './src/config';

type PublicEnvironment = Record<string, string | undefined>;

function origin(value: string, development: boolean): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use an origin URL.');
  if (url.protocol !== 'https:' && !(development && url.protocol === 'http:')) throw new Error('Use HTTPS.');
  return url.origin;
}

function publicSupabaseKey(key: string): string {
  if (/^sb_publishable_[a-zA-Z0-9_-]+$/.test(key)) return key;
  try {
    const parts = key.split('.');
    if (parts.length === 3 && JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role === 'anon') return key;
  } catch { /* Invalid public key. */ }
  throw new Error('Use a Supabase publishable key or legacy anon key.');
}

export function readMobileConfig(env: PublicEnvironment, environment: AppEnvironment, scheme: string): MobileConfig | null {
  const values = [env.EXPO_PUBLIC_API_ORIGIN, env.EXPO_PUBLIC_SUPABASE_URL,
    env.EXPO_PUBLIC_SUPABASE_KEY, env.EXPO_PUBLIC_AUTH_CALLBACK_URL];
  if (values.every((value) => !value) && environment !== 'production') return null;
  if (values.some((value) => !value)) throw new Error('Set all four public mobile configuration values.');
  const [api, supabase, key, callback] = values as string[];
  const url = new URL(callback);
  if (url.username || url.password || url.search || url.hash || url.port || !url.hostname || url.pathname !== '/callback') {
    throw new Error('Use an explicit callback URL with the /callback path.');
  }
  if (url.protocol !== 'https:' && url.protocol !== `${scheme}:`) throw new Error('The callback scheme does not match this app.');
  if (environment === 'production' && url.protocol !== 'https:') throw new Error('Production requires an HTTPS callback.');
  return {
    environment, apiOrigin: origin(api, environment === 'development'),
    supabaseUrl: origin(supabase, environment === 'development'), supabaseKey: publicSupabaseKey(key), callbackUrl: callback,
  };
}

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

  const mobile = readMobileConfig(process.env, identity.environment, identity.scheme);
  const httpsCallback = mobile?.callbackUrl.startsWith('https:') ? new URL(mobile.callbackUrl) : null;

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
      ...(httpsCallback ? { associatedDomains: [`applinks:${httpsCallback.hostname}`] } : {}),
    },
    android: {
      package: identity.androidPackage,
      ...(httpsCallback ? { intentFilters: [{ action: 'VIEW', autoVerify: true,
        category: ['BROWSABLE', 'DEFAULT'],
        data: [{ scheme: 'https', host: httpsCallback.hostname, path: httpsCallback.pathname }],
      }] } : {}),
    },
    plugins: ['expo-router', 'expo-dev-client', 'expo-secure-store'],
    experiments: { typedRoutes: true },
    extra: { appEnvironment: identity.environment, mobile },
  };
};
