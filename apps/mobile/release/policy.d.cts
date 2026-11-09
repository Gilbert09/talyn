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
