import { AUTO_KEEP_DEFAULT_ERROR_CODE, AUTO_REVIEW_ERROR_CODE, CONCURRENT_BOX_LIMIT_ERROR_CODE, SIZE_REQUIRES_PRO_ERROR_CODE,
  USAGE_BILLING_ERROR_CODES, USAGE_EXHAUSTED_ERROR_CODE,
  type UsageBillingErrorCode } from '@talyn/shared';
import { router, type Href } from 'expo-router';
import { Alert, type AlertButton } from 'react-native';

import { trackEvent } from './analytics';

export interface BoxRefusal { code: UsageBillingErrorCode; title: string; message: string }

const TITLES: Record<UsageBillingErrorCode, string> = {
  [USAGE_EXHAUSTED_ERROR_CODE]: 'Out of box-hours',
  [SIZE_REQUIRES_PRO_ERROR_CODE]: 'This size needs Pro',
  [CONCURRENT_BOX_LIMIT_ERROR_CODE]: 'All your boxes are busy',
};
const FALLBACK: Record<UsageBillingErrorCode, string> = {
  [USAGE_EXHAUSTED_ERROR_CODE]: 'You have used the box-hours of this period.',
  [SIZE_REQUIRES_PRO_ERROR_CODE]: 'This box size needs the Pro plan.',
  [CONCURRENT_BOX_LIMIT_ERROR_CODE]: 'A new box can start when one stops.',
};

const isBillingCode = (code: unknown): code is UsageBillingErrorCode =>
  typeof code === 'string' && (USAGE_BILLING_ERROR_CODES as readonly string[]).includes(code);

/**
 * The box gate's 402 refusal, with the server's own sentence. Null for any
 * other error. Mirrors web `boxRefusalFromError`.
 */
export function boxRefusal(error: unknown): BoxRefusal | null {
  if (!error || typeof error !== 'object') return null;
  const { code, message, details } = error as { code?: unknown; message?: unknown; details?: Record<string, unknown> };
  if (!isBillingCode(code)) return null;
  const notice = details?.notice && typeof details.notice === 'object' ? details.notice as { message?: unknown } : {};
  const said = typeof notice.message === 'string' && notice.message ? notice.message
    : typeof message === 'string' && message ? message : FALLBACK[code];
  return { code, title: TITLES[code], message: said };
}

/** The server's message for an action that failed, or the fallback. */
export function errorMessage(error: unknown, fallback: string): string {
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
  return typeof message === 'string' && message.trim() ? message : fallback;
}

/** Plan and credits. Read-only when the build sells nothing. */
export const BILLING_ROUTE = '/billing' as Href;
/** Home with the drawer open, where running sessions can be stopped or archived. */
export const SESSIONS_DRAWER_ROUTE = '/sessions' satisfies Href;
export const REPOSITORIES_ROUTE = '/repositories' satisfies Href;

export interface RefusalAction { label: string; href: Href }

/**
 * Where each refusal sends the person. Out of hours and a size the plan cannot
 * start go to Plan and credits. A size refusal also offers the repository's
 * size setting, since a smaller size is the other fix. All boxes busy opens
 * the drawer, where a session can be stopped or archived.
 */
export function refusalActions(code: UsageBillingErrorCode): RefusalAction[] {
  switch (code) {
    case USAGE_EXHAUSTED_ERROR_CODE: return [{ label: 'Plan and credits', href: BILLING_ROUTE }];
    case SIZE_REQUIRES_PRO_ERROR_CODE: return [
      { label: 'Change the box size', href: REPOSITORIES_ROUTE },
      { label: 'Plan and credits', href: { pathname: BILLING_ROUTE as string, params: { note: SIZE_REQUIRES_PRO_ERROR_CODE } } as Href },
    ];
    case CONCURRENT_BOX_LIMIT_ERROR_CODE: return [{ label: 'Show sessions', href: SESSIONS_DRAWER_ROUTE }];
  }
}

/** Web's `paywall_shown` reason for each box gate code. */
const PAYWALL_REASON: Record<UsageBillingErrorCode, string> = {
  [USAGE_EXHAUSTED_ERROR_CODE]: 'usage_exhausted',
  [SIZE_REQUIRES_PRO_ERROR_CODE]: 'size_requires_pro',
  [CONCURRENT_BOX_LIMIT_ERROR_CODE]: 'concurrent_box_limit',
};

/**
 * The refusal with the server's own message, and a button for each way out.
 * `trigger` is the action that hit the wall, as in web's `paywall_shown`.
 */
export function showBoxRefusal(refusal: BoxRefusal, trigger = 'unknown') {
  trackEvent('paywall_shown', { reason: PAYWALL_REASON[refusal.code], trigger });
  const buttons: AlertButton[] = [{ text: 'Close', style: 'cancel' },
    ...refusalActions(refusal.code).map((action) => ({ text: action.label, onPress: () => router.navigate(action.href) }))];
  Alert.alert(refusal.title, refusal.message, buttons);
}

/** Show why an action failed. A box refusal gets its own message. */
export function showActionError(title: string, error: unknown, fallback = 'Please try again.') {
  const refusal = boxRefusal(error);
  if (refusal) { showBoxRefusal(refusal); return; }
  Alert.alert(title, errorMessage(error, fallback));
}

export type PaidFeatureErrorCode = typeof AUTO_REVIEW_ERROR_CODE | typeof AUTO_KEEP_DEFAULT_ERROR_CODE;
export interface PaidFeatureRefusal { code: PaidFeatureErrorCode; title: string; message: string }

// Web's upgrade copy for these two codes (`UsageUpgradeModal`). Nothing was
// used up, so the copy names the feature and not a limit.
const PAID_FEATURES: Record<PaidFeatureErrorCode, { title: string; message: string }> = {
  [AUTO_REVIEW_ERROR_CODE]: {
    title: 'Review every new PR with Pro',
    message: 'Reviewing every new pull request automatically is a Pro feature. You can still review PRs one at a time on Free.',
  },
  [AUTO_KEEP_DEFAULT_ERROR_CODE]: {
    title: 'Keep every new PR green with Pro',
    message: 'Keeping every new PR mergeable is a Pro feature. Talyn watches each PR you open and fixes conflicts and red CI '
      + 'without you asking. You can still turn it on for one PR at a time on Free.',
  },
};

const isPaidFeatureCode = (code: unknown): code is PaidFeatureErrorCode =>
  code === AUTO_REVIEW_ERROR_CODE || code === AUTO_KEEP_DEFAULT_ERROR_CODE;

/**
 * The 402 a free plan gets when it turns on a paid automatic feature, or null
 * for any other error. Web sends these to its upgrade modal
 * (`maybeHandleBillingLimit`).
 */
export function paidFeatureRefusal(error: unknown): PaidFeatureRefusal | null {
  if (!error || typeof error !== 'object') return null;
  const { code, status } = error as { code?: unknown; status?: unknown };
  if (!isPaidFeatureCode(code)) return null;
  if (status !== undefined && status !== 402) return null;
  return { code, ...PAID_FEATURES[code] };
}

/** The paid-feature refusal, with Plan and credits as the way out. */
export function showPaidFeatureRefusal(refusal: PaidFeatureRefusal) {
  Alert.alert(refusal.title, refusal.message, [{ text: 'Close', style: 'cancel' },
    { text: 'Plan and credits', onPress: () => router.navigate(BILLING_ROUTE) }]);
}
