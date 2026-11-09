import { CONCURRENT_BOX_LIMIT_ERROR_CODE, SIZE_REQUIRES_PRO_ERROR_CODE, USAGE_BILLING_ERROR_CODES, USAGE_EXHAUSTED_ERROR_CODE,
  type UsageBillingErrorCode } from '@talyn/shared';
import { Alert } from 'react-native';

import { openExternal } from '../components/Workflow';
import { WEB_APP_URL } from '../features/settings/about';

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

/** Plans and credits are managed on the web, so a refusal points there. */
export function showBoxRefusal(refusal: BoxRefusal) {
  Alert.alert(refusal.title, `${refusal.message} Manage your plan in Talyn on the web.`, [
    { text: 'Close', style: 'cancel' },
    { text: 'Open Talyn on the web', onPress: () => openExternal(WEB_APP_URL) },
  ]);
}

/** Show why an action failed. A box refusal gets its own message. */
export function showActionError(title: string, error: unknown, fallback = 'Please try again.') {
  const refusal = boxRefusal(error);
  if (refusal) { showBoxRefusal(refusal); return; }
  Alert.alert(title, errorMessage(error, fallback));
}
