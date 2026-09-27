import { useState } from 'react';
import { ScanSearch } from 'lucide-react';
import { api } from '../../lib/api';
import { usePullRequestStore } from '../../stores/pullRequests';
import { useWorkspaceStore } from '../../stores/workspace';
import { useBillingStore, maybeHandleBillingLimit } from '../../stores/billing';
import { trackEvent } from '../../lib/analytics';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';

/**
 * The one-time introduction to code review, for somebody who already uses Talyn.
 *
 * # Why the primary button DOES the thing
 *
 * "Got it" converts nobody. This modal exists to get the feature switched on, so
 * its primary action reviews one of the user's own pull requests — named, so the
 * offer is concrete — and opens the findings when it lands. The pitch and the
 * demonstration are the same click.
 *
 * # What it will not do
 *
 * It does not offer automatic review to a free account. That is part of Unlimited,
 * and handing somebody a control that refuses them is a worse first impression
 * than not mentioning it.
 */
export function CodeReviewIntroModal({
  open,
  examplePrId,
  onClose,
  onOpenPr,
}: {
  open: boolean;
  examplePrId: string | null;
  onClose: () => void;
  onOpenPr: (prId: string) => void;
}) {
  const rows = usePullRequestStore((s) => s.rows);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const status = useBillingStore((s) => s.status);
  const [busy, setBusy] = useState(false);

  const example = rows.find((r) => r.id === examplePrId);
  // `!== 'free'` rather than `=== 'unlimited'`: with billing switched off the
  // snapshot reports unlimited, and a strict check would hide this from the people
  // developing it.
  const paid = status != null && status.plan !== 'free';

  const reviewIt = async () => {
    if (!example) return;
    setBusy(true);
    try {
      await api.pullRequests.startCodeReview(example.id);
      trackEvent('code_review_intro_converted', { action: 'reviewed_pr', plan: status?.plan });
      onClose();
      onOpenPr(example.id);
    } catch (err) {
      if (!maybeHandleBillingLimit(err, 'code_review_intro')) onClose();
    } finally {
      setBusy(false);
    }
  };

  const turnOnAuto = async () => {
    if (!currentWorkspaceId) return;
    setBusy(true);
    try {
      await api.workspaces.update(currentWorkspaceId, {
        settings: { codeReview: { autoReview: true } } as never,
      });
      trackEvent('code_review_intro_converted', { action: 'enabled_auto', plan: status?.plan });
      onClose();
    } catch (err) {
      if (!maybeHandleBillingLimit(err, 'code_review_intro')) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          trackEvent('code_review_intro_converted', { action: 'dismissed', plan: status?.plan });
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanSearch className="h-4 w-4" />
            Talyn can review your pull requests
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            It reads the change, works out what is actually wrong with it, and gives you a short
            list. You pick what to fix and Talyn fixes it.
          </p>

          {example && (
            <div className="rounded-md border p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Try it on
              </p>
              <p className="mt-0.5 truncate text-sm font-medium">
                {example.summary.title || `${example.owner}/${example.repo}#${example.number}`}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">
                {example.owner}/{example.repo}#{example.number}
              </p>
            </div>
          )}

          {/* The differentiator, stated plainly, because it is the reason to
              prefer this over the bot they have already muted. */}
          <p className="text-xs text-muted-foreground">
            The findings stay in Talyn. Nothing is posted on your pull request unless you turn it
            on in Settings.
          </p>
        </div>

        {/* WRAPPING, not a `sm:` breakpoint. The shared `DialogFooter` stacks on
            `sm:`, which is keyed on the VIEWPORT — and this dialog is `max-w-md`
            (448px) on a screen that is almost always far wider, so the breakpoint
            never fires and three buttons overflow their own container. `flex-wrap`
            measures the thing that actually constrains them. */}
        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Not now
          </Button>
          {paid && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void turnOnAuto()}>
              Review every new PR
            </Button>
          )}
          <Button size="sm" disabled={busy || !example} onClick={() => void reviewIt()}>
            Review this PR
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
