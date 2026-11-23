import type { ExpoConfig } from 'expo/config';

export const SHARE_EXTENSION_INFO: string;
export const SHARE_EXTENSION_TARGET: string;
export const SHARE_INTENT_OPTIONS: {
  readonly iosActivationRules: Readonly<Record<string, number | boolean>>;
  readonly androidIntentFilters: readonly string[];
};
export function withShareIntent(config: ExpoConfig): ExpoConfig;
export default withShareIntent;
