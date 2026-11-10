import { billing } from '@talyn/client/native';
import type { BillingOrder, BillingStatus, CheckoutSessionResponse, CreditPackId, SellableTier } from '@talyn/shared';
import Constants from 'expo-constants';

import { useAuth } from '../../auth/AuthProvider';
import { purchaseModeOf, type PurchaseMode } from '../../config';
import { appReturnBase, openReturnFlow } from '../../lib/returnTo';
import { useRemote } from '../more/useRemote';
import { refusesReturnTarget, type Period } from './model';
import { billingReturn } from './returnFlow';

/** The account's plan and usage. Account-wide, so it is keyed by the user, not the workspace. */
export function useBillingStatus(enabled = true) {
  const user = useAuth().user?.id ?? null;
  return useRemote<BillingStatus>(enabled && user ? `billing:${user}` : null, () => billing.status(), { intervalMs: 60_000 });
}

/** Past orders, newest first. An older backend without the route shows none. */
export function useOrders(enabled = true) {
  const user = useAuth().user?.id ?? null;
  return useRemote<BillingOrder[]>(enabled && user ? `billing-orders:${user}` : null, () => billing.orders().catch(() => []));
}

export function appPurchaseMode(): PurchaseMode {
  return purchaseModeOf(Constants.expoConfig?.extra);
}

/**
 * Asks for a hosted page that returns to the app. A server that refuses the
 * return target is asked again without one; the page then returns to the web,
 * and the foreground refresh picks up the change.
 */
export async function withReturnTarget(request: (returnTo?: string) => Promise<CheckoutSessionResponse>, base = appReturnBase()) {
  try {
    return await request(base);
  } catch (error) {
    if (!refusesReturnTarget(error)) throw error;
    return request(undefined);
  }
}

export function requestCheckout(plan: SellableTier, period: Period) {
  return withReturnTarget((returnTo) => billing.checkout(returnTo ? { plan, period, returnTo } : { plan, period }));
}
export function requestCreditCheckout(pack: CreditPackId) {
  return withReturnTarget((returnTo) => billing.creditCheckout(returnTo ? { pack, returnTo } : { pack }));
}
export function requestUsageResetCheckout() {
  return withReturnTarget((returnTo) => billing.usageResetCheckout(returnTo ? { returnTo } : {}));
}
export function requestPortal() {
  return withReturnTarget((returnTo) => billing.portal(returnTo ? { returnTo } : {}));
}

/**
 * Opens the hosted page and waits for the browser to close. Returns whether it
 * came back through the app link, so the caller can show the return screen.
 */
export async function runHostedFlow(url: string, status: BillingStatus | null | undefined) {
  billingReturn.remember(status);
  return openReturnFlow(url, 'billing');
}
