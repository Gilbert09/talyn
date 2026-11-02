import {
  PLAN_LIMITS,
  formatBoxHoursUsage,
  type UsageAlertEvent,
  type UsageExhaustedEvent,
} from '@talyn/shared';
import { useToastStore, type ToastAction } from '../stores/toast';
import { useBillingStore } from '../stores/billing';
import { formatShortDate } from './usageBilling';

/**
 * The 50/80/100% alerts and the "out of hours" alert, as toasts.
 *
 * The backend sends each alert once per threshold per period, but a reconnect,
 * a second tab or a reload can deliver the same fact again, so each one is
 * remembered by period and threshold and shown once.
 */

const SEEN_KEY = 'talyn-usage-alerts-seen';
const ALERT_TTL_MS = 12_000;
/** Plenty for a year of periods at three thresholds each; older keys are dropped. */
const MAX_SEEN = 48;

function readSeen(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

const seenThisLoad = new Set<string>();

/** True the first time `key` is seen; false after that, across reloads when storage works. */
export function firstTimeFor(key: string): boolean {
  if (seenThisLoad.has(key)) return false;
  const seen = readSeen();
  seenThisLoad.add(key);
  if (seen.includes(key)) return false;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, key].slice(-MAX_SEEN)));
  } catch {
    // Private mode: the in-memory set still bounds it to once per load.
  }
  return true;
}

/** Test seam. */
export function _resetUsageAlerts(): void {
  seenThisLoad.clear();
  try {
    localStorage.removeItem(SEEN_KEY);
  } catch {
    // ignore
  }
}

function show(variant: 'info' | 'error', title: string, description: string, action: ToastAction): void {
  const id = useToastStore.getState().add({ variant, title, description, action });
  window.setTimeout(() => useToastStore.getState().dismiss(id), ALERT_TTL_MS);
}

function actionFor(creditsAllowed: boolean): ToastAction {
  const open = useBillingStore.getState().setUpgradeModalOpen;
  return creditsAllowed
    ? { label: 'Add credits', onClick: () => open(true, 'add_credits') }
    : { label: 'Upgrade', onClick: () => open(true, 'upgrade') };
}

export function announceUsageAlert(event: UsageAlertEvent): void {
  if (!firstTimeFor(`${event.periodEnd}:${event.thresholdPct}`)) return;
  const usage = formatBoxHoursUsage(event.usedWsec, event.includedWsec);
  const reset = formatShortDate(event.periodEnd);
  const creditsAllowed = PLAN_LIMITS[event.tier]?.creditsAllowed ?? false;
  if (event.thresholdPct >= 100) {
    show(
      'error',
      'You have used all your included box-hours',
      creditsAllowed
        ? `${usage}. New boxes now use your credits. Hours reset on ${reset}.`
        : `${usage}. New boxes can start again on ${reset}.`,
      actionFor(creditsAllowed)
    );
    return;
  }
  show(
    'info',
    `You have used ${event.thresholdPct}% of your box-hours`,
    `${usage} this period. Hours reset on ${reset}.`,
    actionFor(creditsAllowed)
  );
}

export function announceExhausted(event: UsageExhaustedEvent): void {
  if (!firstTimeFor(`${event.periodEnd}:exhausted`)) return;
  const reset = formatShortDate(event.periodEnd);
  show(
    'error',
    'Out of hours: new boxes paused',
    event.creditsAllowed
      ? 'Your box-hours and credits are used up. Running turns finish. Add credits to start new boxes.'
      : `Your box-hours are used up. Running turns finish. New boxes can start again on ${reset}.`,
    actionFor(event.creditsAllowed)
  );
}
