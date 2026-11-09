import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';

export interface AppInfo { version: string; build: string | null; channel: string | null; runtime: string | null; update: string | null }

/** What a support request needs: app version, native build, and the update channel the app runs. */
export function appInfo(): AppInfo {
  const config = Constants.expoConfig;
  const build = Platform.OS === 'ios' ? config?.ios?.buildNumber : config?.android?.versionCode;
  let channel: string | null = null; let runtime: string | null = null; let update: string | null = null;
  try {
    channel = Updates.channel ?? null;
    runtime = Updates.runtimeVersion ?? null;
    update = Updates.isEmbeddedLaunch ? null : Updates.updateId?.slice(0, 8) ?? null;
  } catch { /* Updates is not available in this build. */ }
  return { version: config?.version ?? 'Unknown', build: build === undefined || build === null ? null : String(build), channel, runtime, update };
}

export const WEB_APP_URL = 'https://app.talyn.dev';
export const DOCS_URL = 'https://www.talyn.dev/docs';
