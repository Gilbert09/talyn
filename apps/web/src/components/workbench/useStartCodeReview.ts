import { useState } from 'react';
import { api, type PRRow } from '../../lib/api';
import { toast } from '../../stores/toast';
import { captureAnalyticsException, trackEvent } from '../../lib/analytics';
import { maybeHandleBillingLimit } from '../../stores/billing';
import { usePullRequestStore } from '../../stores/pullRequests';

/** Starts a code review of the pull request, with the toasts and analytics of the PR tab. */
export function useStartCodeReview(pr: Pick<PRRow, 'id'> | null): { busy: boolean; start: () => Promise<void> } {
  const [busy, setBusy] = useState(false);
  const start = async () => {
    if (!pr || busy) return;
    setBusy(true);
    try {
      const next = await api.pullRequests.startCodeReview(pr.id);
      trackEvent('code_review_started', { preset: next.preset, depth: next.preset });
      usePullRequestStore.getState().patchRow(pr.id, { codeReview: next });
      toast.info('Code review started', 'The findings show here when it finishes.');
    } catch (err) {
      captureAnalyticsException(err, { flow: 'code_review_start' });
      if (!maybeHandleBillingLimit(err, 'code_review_start')) {
        toast.error('Could not start the code review', err instanceof Error ? err.message : undefined);
      }
    } finally {
      setBusy(false);
    }
  };
  return { busy, start };
}
