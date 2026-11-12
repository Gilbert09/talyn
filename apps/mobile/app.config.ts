import fs from 'node:fs';
import path from 'node:path';

import type { ConfigContext, ExpoConfig } from 'expo/config';

import type { AnalyticsConfig, AppEnvironment, MobileConfig, PurchaseMode } from './src/config';
import { readReleaseSettings } from './release/policy.cjs';
import { withPostHogSymbolUploads } from './plugins/withPostHogSymbolUploads.cjs';

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
    purchaseMode: readPurchaseMode(env),
  };
}

/** `EXPO_PUBLIC_PURCHASE_MODE`: `external` (the default) or `none` for a store build with no purchase links. */
export function readPurchaseMode(env: PublicEnvironment): PurchaseMode {
  const value = env.EXPO_PUBLIC_PURCHASE_MODE?.trim();
  if (!value) return 'external';
  if (value === 'external' || value === 'none') return value;
  throw new Error('EXPO_PUBLIC_PURCHASE_MODE must be external or none.');
}

/**
 * PostHog from `EXPO_PUBLIC_TALYN_POSTHOG_KEY` and `EXPO_PUBLIC_TALYN_POSTHOG_HOST`.
 * No key means analytics is off: the app sends nothing. The host defaults to PostHog US.
 */
export function readAnalyticsConfig(env: PublicEnvironment): AnalyticsConfig | null {
  const key = env.EXPO_PUBLIC_TALYN_POSTHOG_KEY?.trim();
  if (!key) return null;
  if (!/^phc_[A-Za-z0-9_-]+$/.test(key)) throw new Error('EXPO_PUBLIC_TALYN_POSTHOG_KEY must be a PostHog project key (phc_).');
  const host = env.EXPO_PUBLIC_TALYN_POSTHOG_HOST?.trim() || 'https://us.i.posthog.com';
  return { key, host: origin(host, false) };
}

type Environment = 'development' | 'preview' | 'production';

type IdentityEnvironment = Record<string, string | undefined>;

export function getAppIdentity(env: IdentityEnvironment) {
  const environment = env.APP_ENV ?? 'development';
  if (!['development', 'preview', 'production'].includes(environment)) {
    throw new Error('APP_ENV must be development, preview, or production.');
  }

  if (environment === 'production' && (!env.TALYN_MOBILE_IOS_BUNDLE_ID || !env.TALYN_MOBILE_ANDROID_PACKAGE || !env.TALYN_MOBILE_SCHEME)) {
    throw new Error('Production requires explicit app identifiers and scheme.');
  }
  for (const name of ['TALYN_MOBILE_IOS_BUNDLE_ID', 'TALYN_MOBILE_ANDROID_PACKAGE']) {
    const value = env[name];
    if (value && (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){2,}$/.test(value) || /(^|\.)(example|test|invalid)(\.|$)/.test(value))) {
      throw new Error('Use approved reverse-domain app identifiers.');
    }
  }
  if (env.TALYN_MOBILE_SCHEME && !/^[a-z][a-z0-9+.-]+$/.test(env.TALYN_MOBILE_SCHEME)) throw new Error('Use a valid app scheme.');
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

/**
 * Firebase's Android config for push (FCM). `TALYN_MOBILE_GOOGLE_SERVICES_JSON` holds the file as base64: a sensitive
 * EAS text variable, because `eas update` does not receive the contents of an EAS file variable. The fingerprint hashes
 * the file's contents, so a build and an update that decode the same value get the same runtime. Absent means no push.
 */
export function writeGoogleServicesFile(env: Record<string, string | undefined>, androidPackage: string, dir: string): string | undefined {
  const encoded = env.TALYN_MOBILE_GOOGLE_SERVICES_JSON?.trim();
  if (!encoded) return undefined;
  const contents = Buffer.from(encoded, 'base64').toString('utf8');
  let packages: string[];
  try {
    const parsed = JSON.parse(contents) as { client?: { client_info?: { android_client_info?: { package_name?: string } } }[] };
    packages = (parsed.client ?? []).map((client) => client.client_info?.android_client_info?.package_name ?? '');
  } catch {
    throw new Error('TALYN_MOBILE_GOOGLE_SERVICES_JSON must be the base64 of google-services.json.');
  }
  if (!packages.includes(androidPackage)) throw new Error(`google-services.json has no Android app for ${androidPackage}.`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'google-services.json');
  fs.writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

/** The Expo account that owns the EAS project. */
export const EAS_OWNER = 'talyn-app';
/** `@talyn-app/talyn-mobile`. A public identifier, not a credential. */
export const EAS_PROJECT_ID = '69499768-c478-44c0-8588-355c674515df';

/** The EAS project for push and updates. `EXPO_PUBLIC_EAS_PROJECT_ID` overrides the Talyn project, for a fork. */
export function readPushProjectId(env: PublicEnvironment): string {
  const projectId = env.EXPO_PUBLIC_EAS_PROJECT_ID || EAS_PROJECT_ID;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
    throw new Error('Use a valid public EAS project ID.');
  }
  return projectId;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const identity = getAppIdentity(process.env);
  const projectId = readPushProjectId(process.env);

  const release = readReleaseSettings(process.env, identity.environment, projectId);
  const mobile = readMobileConfig(process.env, identity.environment, identity.scheme);
  const httpsCallback = mobile?.callbackUrl.startsWith('https:') ? new URL(mobile.callbackUrl) : null;
  // `.expo` is ignored by git and by EAS uploads.
  const googleServicesFile = writeGoogleServicesFile(process.env, identity.androidPackage, path.join(__dirname, '.expo'));

  // PostHog source map and native symbol uploads, on when the build has POSTHOG_CLI_API_KEY (plugins/withPostHogSymbolUploads.cjs).
  return withPostHogSymbolUploads({
    ...config,
    name: identity.name,
    owner: EAS_OWNER,
    slug: 'talyn-mobile',
    version: release.version,
    icon: '../desktop/assets/icons/1024x1024.png',
    runtimeVersion: release.runtimeVersion,
    updates: release.updates,
    scheme: identity.scheme,
    platforms: ['ios', 'android'],
    userInterfaceStyle: 'automatic',
    ios: {
      bundleIdentifier: identity.iosBundleIdentifier,
      supportsTablet: true,
      buildNumber: release.build,
      privacyManifests: {
        NSPrivacyTracking: false,
        NSPrivacyTrackingDomains: [],
      },
      infoPlist: { NSAppTransportSecurity: { NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: identity.environment === 'development' } },
      ...(httpsCallback ? { associatedDomains: [`applinks:${httpsCallback.hostname}`] } : {}),
    },
    android: {
      package: identity.androidPackage,
      ...(googleServicesFile ? { googleServicesFile } : {}),
      versionCode: Number(release.build),
      permissions: ['android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE', 'android.permission.VIBRATE', 'android.permission.POST_NOTIFICATIONS'],
      blockedPermissions: [
        'android.permission.RECEIVE_BOOT_COMPLETED', 'android.permission.RECORD_AUDIO',
        'android.permission.CAMERA', 'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE', 'android.permission.SYSTEM_ALERT_WINDOW',
      ],
      ...(httpsCallback ? { intentFilters: [{ action: 'VIEW', autoVerify: true,
        category: ['BROWSABLE', 'DEFAULT'],
        data: [
          { scheme: 'https', host: httpsCallback.hostname, path: httpsCallback.pathname },
          ...['sessions', 'threads', 'attention'].map((kind) => ({ scheme: 'https', host: httpsCallback.hostname, pathPrefix: `/${kind}/` })),
        ],
      }] } : {}),
    },
    plugins: ['expo-router', 'expo-dev-client', 'expo-secure-store', ['expo-navigation-bar', { enforceContrast: false }], ['expo-splash-screen', { image: './assets/splash-owl.png', imageWidth: 120, resizeMode: 'contain', backgroundColor: '#fcfbf8', dark: { image: './assets/splash-owl-dark.png', backgroundColor: '#211d18' } }], ['expo-image-picker', { photosPermission: 'Talyn uses your photos when you attach an image to a message.', cameraPermission: 'Talyn uses the camera when you take a photo to attach to a message.', microphonePermission: false }], ['expo-notifications', {
      mode: release.profile === 'development' ? 'development' : 'production', enableBackgroundRemoteNotifications: false,
      // Android draws the small icon as a white silhouette; without one it uses the opaque app icon, a white square.
      icon: './assets/notification-icon.png', color: '#a94d2e',
    }]],
    experiments: { typedRoutes: true },
    extra: { release: { profile: release.profile, urls: release.urls }, appEnvironment: identity.environment, mobile,
      analytics: readAnalyticsConfig(process.env), eas: { projectId } },
  }, { profile: release.profile });
};
