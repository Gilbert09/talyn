import type { ExpoConfig } from 'expo/config';

export const DOTENV_FILE: string;
export function symbolUploadCredentials(env: Record<string, string | undefined>, profile: string | undefined): Record<string, string> | null;
export function writeCredentials(projectRoot: string, credentials: Record<string, string>): void;
export function withPostHogSymbolUploads(config: ExpoConfig, options: { profile: string; env?: Record<string, string | undefined> }): ExpoConfig;
