export type AppEnvironment = 'development' | 'preview' | 'production';

/**
 * How the app may sell plans and credits. `external` opens the web checkout in
 * the browser. `none` shows the plan read-only, with no buy buttons and no
 * links to purchase pages, for store builds.
 */
export type PurchaseMode = 'external' | 'none';
export const PURCHASE_MODES: readonly PurchaseMode[] = ['external', 'none'];

/** The public PostHog project key and ingestion host. Absent means analytics is off. */
export interface AnalyticsConfig {
  key: string;
  host: string;
}

export interface MobileConfig {
  environment: AppEnvironment;
  apiOrigin: string;
  supabaseUrl: string;
  supabaseKey: string;
  callbackUrl: string;
  purchaseMode?: PurchaseMode;
}

/**
 * The purchase mode from the app's `extra` config. Absent means `external`,
 * the default. An unknown value means `none`, so a bad build never sells.
 */
export function purchaseModeOf(extra: unknown): PurchaseMode {
  const mobile = extra && typeof extra === 'object' ? (extra as { mobile?: unknown }).mobile : undefined;
  const value = mobile && typeof mobile === 'object' ? (mobile as { purchaseMode?: unknown }).purchaseMode : undefined;
  if (value === undefined || value === null) return 'external';
  return PURCHASE_MODES.includes(value as PurchaseMode) ? value as PurchaseMode : 'none';
}
