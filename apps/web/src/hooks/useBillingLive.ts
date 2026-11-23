import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { UsageAlertEvent, UsageExhaustedEvent } from '@talyn/shared';
import { wsClient } from '../lib/api';
import { useBillingStore } from '../stores/billing';
import { toast } from '../stores/toast';
import { usageBillingOf } from '../lib/usageBilling';
import { announceExhausted, announceUsageAlert } from '../lib/usageAlerts';

/**
 * Keeps the usage gauge live: the usage WebSocket events, a slow REST poll as
 * the fallback while the tab is visible, and the return from a hosted checkout.
 *
 * The poll runs only when the backend serves usage data. An older backend has
 * nothing to poll for, and the existing focus refresh already covers its plan.
 */
export const USAGE_POLL_MS = 5 * 60_000;

/** After a credit purchase the webhook can lag the redirect by a few seconds. */
const CREDIT_REFRESH_DELAYS_MS = [3_000, 10_000];

export function useBillingLive(): void {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const usageOn = useBillingStore((s) => usageBillingOf(s.status) !== null);

  useEffect(() => {
    const refresh = () => void useBillingStore.getState().refresh();
    const offs = [
      wsClient.on<UsageAlertEvent>('billing:usage_alert', (event) => {
        refresh();
        announceUsageAlert(event);
      }),
      wsClient.on<UsageExhaustedEvent>('billing:exhausted', (event) => {
        refresh();
        announceExhausted(event);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    if (!usageOn) return;
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') void useBillingStore.getState().refresh();
    };
    const timer = window.setInterval(refreshIfVisible, USAGE_POLL_MS);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [usageOn]);

  useEffect(() => {
    const params = new URLSearchParams(search);
    if (params.get('checkout') !== 'success') return;
    const kindParam = params.get('kind');
    const kind = kindParam === 'credits' || kindParam === 'reset' ? kindParam : 'plan';
    params.delete('checkout');
    params.delete('kind');
    const rest = params.toString();
    navigate(`${pathname}${rest ? `?${rest}` : ''}`, { replace: true });

    const store = useBillingStore.getState();
    void store.refresh();
    if (kind === 'reset') {
      for (const delay of CREDIT_REFRESH_DELAYS_MS) {
        window.setTimeout(() => void useBillingStore.getState().refresh(), delay);
      }
      toast.success('Usage reset', 'Your box-hours are back.');
    } else if (kind === 'credits') {
      for (const delay of CREDIT_REFRESH_DELAYS_MS) {
        window.setTimeout(() => void useBillingStore.getState().refresh(), delay);
      }
      toast.success('Payment received', 'Your credits can take a few seconds to show.');
    } else {
      store.startCheckoutPollBurst();
      toast.success('Payment received', 'Your new plan can take a few seconds to show.');
    }
  }, [search, pathname, navigate]);
}
