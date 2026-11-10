import type { ExpoConfig } from 'expo/config';

export const profiles: Record<string, { environment: string; channel: string; store: boolean; updates: boolean; autoUpdate: boolean }>;
export const CHECK_AUTOMATICALLY: string;
export function required(env: Record<string, string | undefined>, name: string): string;
export function publicUrl(value: string, name: string): string;
export function readReleaseSettings(env: Record<string, string | undefined>, environment: string, projectId?: string): {
  profile: string;
  version: string;
  build: string;
  urls: Record<string, string>;
  runtimeVersion: ExpoConfig['runtimeVersion'];
  updates: ExpoConfig['updates'];
};
export const POSTHOG_SYMBOL_UPLOADS: Readonly<{ projectId: string; host: string; keyName: 'POSTHOG_CLI_API_KEY' }>;
export function posthogUploadCredentials(env: Record<string, string | undefined>): {
  POSTHOG_CLI_API_KEY: string;
  POSTHOG_CLI_PROJECT_ID: string;
  POSTHOG_CLI_HOST: string;
} | null;
