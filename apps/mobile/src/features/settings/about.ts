import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';

export interface AppInfo {
  version: string; build: string | null; channel: string | null; runtime: string | null;
  /** The running update's short ID, or null when the app runs the update built into the binary. */
  update: string | null;
  /** When the running update was published. */
  createdAt: string | null;
}

/** What a support request needs: app version, native build, and the update the app runs. */
export function appInfo(): AppInfo {
  const config = Constants.expoConfig;
  // The native number first: an update carries the app config it was published with, not the binary's build number.
  const native = Platform.OS === 'ios' ? Constants.platform?.ios?.buildNumber : Constants.platform?.android?.versionCode;
  const build = native ?? (Platform.OS === 'ios' ? config?.ios?.buildNumber : config?.android?.versionCode);
  let channel: string | null = null; let runtime: string | null = null; let update: string | null = null; let createdAt: string | null = null;
  try {
    channel = Updates.channel ?? null;
    runtime = Updates.runtimeVersion ?? null;
    if (!Updates.isEmbeddedLaunch) {
      update = Updates.updateId?.slice(0, 8) ?? null;
      createdAt = Updates.createdAt ? Updates.createdAt.toISOString() : null;
    }
  } catch { /* Updates is not available in this build. */ }
  return { version: config?.version ?? 'Unknown', build: build === undefined || build === null ? null : String(build), channel, runtime, update, createdAt };
}

export const WEB_APP_URL = 'https://app.talyn.dev';
export const DOCS_URL = 'https://www.talyn.dev/docs';
