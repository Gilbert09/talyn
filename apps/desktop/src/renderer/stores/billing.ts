import { create } from 'zustand';
import {
  MERGE_QUEUE_LIMIT_ERROR_CODE,
  TASK_LIMIT_ERROR_CODE,
  type BillingStatus,
} from '@talyn/shared';
import { api, ApiError } from '../lib/api';

/**
 * Billing state: the user's plan/usage snapshot plus the upgrade-modal flag.
 *
 * The snapshot is server-authoritative (`GET /billing/status`) — never
 * derived from the local task list, which doesn't span every workspace the
 * user owns. It refreshes on app start, on window focus, on the
 * `subscription:updated` WS push, and in a short poll burst right after a
 * checkout/portal page is opened in the browser (webhooks can lag the
 * checkout by a few seconds, and the WS may be reconnecting at that moment).
 */

const POLL_BURST_INTERVAL_MS = 3_000;
const POLL_BURST_MAX_MS = 2 * 60_000;

interface BillingState {
  status: BillingStatus | null;
  upgradeModalOpen: boolean;
  setStatus: (status: BillingStatus) => void;
  setUpgradeModalOpen: (open: boolean) => void;
  /** Re-fetch the snapshot from the backend. Safe to call repeatedly. */
  refresh: () => Promise<void>;
  /** Start (or restart) the post-checkout poll burst. */
  startCheckoutPollBurst: () => void;
  stopCheckoutPollBurst: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollDeadline = 0;

export const useBillingStore = create<BillingState>((set, get) => ({
  status: null,
  upgradeModalOpen: false,

  setStatus: (status) => {
    set({ status });
    // The burst exists to catch the plan flip; once we're not free (or
    // billing turns out to be off) there's nothing left to poll for.
    if (status.plan !== 'free' || !status.billingEnabled) {
      get().stopCheckoutPollBurst();
    }
  },

  setUpgradeModalOpen: (upgradeModalOpen) => set({ upgradeModalOpen }),

  refresh: async () => {
    try {
      get().setStatus(await api.billing.status());
    } catch {
      // Transient (offline / backend restart) — keep the last snapshot; the
      // next focus/WS/poll tick retries. Enforcement is server-side anyway.
    }
  },

  startCheckoutPollBurst: () => {
    pollDeadline = Date.now() + POLL_BURST_MAX_MS;
    if (pollTimer) return; // already running — just extended the deadline
    pollTimer = setInterval(() => {
      if (Date.now() > pollDeadline) {
        get().stopCheckoutPollBurst();
        return;
      }
      void get().refresh();
    }, POLL_BURST_INTERVAL_MS);
  },

  stopCheckoutPollBurst: () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },
}));

/** The 402 codes the free plan can reject with. */
const BILLING_LIMIT_CODES: ReadonlySet<string> = new Set([
  TASK_LIMIT_ERROR_CODE,
  MERGE_QUEUE_LIMIT_ERROR_CODE,
]);

/**
 * Shared 402 interception: when `err` is a free-plan limit rejection (task
 * concurrency or merge-queue cap), open the upgrade modal (and refresh the
 * snapshot so it shows live usage) and return true. Callers keep their
 * generic error handling for everything else.
 */
export function maybeHandleBillingLimit(err: unknown): boolean {
  if (!(err instanceof ApiError) || !err.code || !BILLING_LIMIT_CODES.has(err.code)) {
    return false;
  }
  const store = useBillingStore.getState();
  void store.refresh();
  store.setUpgradeModalOpen(true);
  return true;
}
