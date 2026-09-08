import { useEffect } from 'react';
import { usePullRequestStore } from '../stores/pullRequests';
import { useBillingStore } from '../stores/billing';
import { trackEvent } from '../lib/analytics';

/**
 * Tells a free user when auto-keep silently stopped keeping their PRs green.
 *
 * The free plan's other two limits announce themselves: they refuse a request
 * the user made, and the 402 becomes the UpgradeModal. This one cannot. A
 * watcher deferral happens on a poll tick with nobody on the other end — the
 * run is skipped, the PR stays broken, and every surface that would normally
 * say so is downstream of an HTTP response that never existed. The user sees
 * a product that quietly got worse.
 *
 * So the deferral is persisted per PR (`autoMergeState.deferredSince`) and
 * this reads it back out of the list the client already has. No new endpoint,
 * no new socket event: the PR rows carry it, and they are already loaded.
 */

/** Once per 24h, remembered across launches. */
const LAST_SHOWN_KEY = 'talyn-deferred-runs-last-shown';
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

function readLastShown(): number {
  try {
    return Number(localStorage.getItem(LAST_SHOWN_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeLastShown(at: number): void {
  try {
    localStorage.setItem(LAST_SHOWN_KEY, String(at));
  } catch {
    // Private mode — the in-memory guard below still bounds it to once a launch.
  }
}

/** Exported for tests: should the modal open, given the two guards? */
export function shouldAnnounceDeferral(
  deferredCount: number,
  lastShownAt: number,
  now: number,
): boolean {
  if (deferredCount === 0) return false;
  return now - lastShownAt >= COOLDOWN_MS;
}

/**
 * Opens the UpgradeModal at most ONCE per launch, and at most once per 24h.
 *
 * Both bounds matter and neither is sufficient alone. Per-launch alone nags
 * whoever quits and reopens the app all day. The 24h floor alone would let a
 * long-lived window go a week without mentioning an ongoing degradation.
 *
 * It fires only while something is deferred RIGHT NOW, so a user whose slots
 * freed up is never shown a wall they are no longer standing at.
 */
export function useDeferredRuns(): void {
  const rows = usePullRequestStore((s) => s.rows);
  const plan = useBillingStore((s) => s.status?.plan);

  useEffect(() => {
    // Upgrading is the fix, so there is nothing to say to someone who already
    // has. Waiting for the status to load also stops the modal racing ahead of
    // a snapshot that would have said `unlimited`.
    if (!plan || plan !== 'free') return;
    if (announcedThisLaunch) return;

    const deferred = rows.filter((r) => r.autoMergeState?.deferredSince);
    const now = Date.now();
    if (!shouldAnnounceDeferral(deferred.length, readLastShown(), now)) return;

    announcedThisLaunch = true;
    writeLastShown(now);
    trackEvent('paywall_shown', {
      // Same event as the 402 path so the funnel has one denominator; the
      // reason is what separates "we refused you" from "this quietly stopped".
      reason: 'task_deferred',
      trigger: 'auto_keep_deferred',
      deferred_prs: deferred.length,
      plan,
    });
    useBillingStore.getState().setUpgradeModalOpen(true, 'task_deferred');
  }, [rows, plan]);
}

/**
 * Module scope, not store state: "this launch" is the lifetime of the loaded
 * renderer, and a component-level guard would reset every time MainLayout
 * remounted (a workspace switch does exactly that).
 */
let announcedThisLaunch = false;

/** Test seam — resets the per-launch guard. */
export function _resetDeferredRunsGuard(): void {
  announcedThisLaunch = false;
}
