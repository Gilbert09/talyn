import { useEffect, useState } from 'react';
import { codeReviewOffered } from '@talyn/shared';
import { usePullRequestStore } from '../stores/pullRequests';
import { useWorkspaceStore } from '../stores/workspace';
import { trackEvent } from '../lib/analytics';

/**
 * Introduces code review, once, to somebody who already uses Talyn.
 *
 * A new user meets it in the wizard. An existing one has no reason to open a tab
 * they have never seen, and the changelog is the wrong instrument — a list of
 * release notes informs, and this has to CONVERT: the point is that the feature
 * gets switched on, not that it gets mentioned.
 *
 * # Once ever, not once per day
 *
 * `useDeferredRuns` next door is once per 24 hours, because it announces an
 * ONGOING degradation — there is something new to say each day the PRs stay
 * broken. This has nothing new to say the second time, and re-nagging about a
 * feature somebody declined is how people learn to dismiss modals unread. So the
 * key holds a version stamp rather than a timestamp.
 *
 * # Written on OPEN, not on dismiss
 *
 * Matching where `useDeferredRuns` writes its own: somebody who quits the app
 * mid-modal has still seen it, and a stamp written on dismiss would show it to
 * them again next launch.
 */

const SEEN_KEY = 'talyn:codeReviewIntro:seen';

/** Bump only if the introduction itself changes enough to be worth re-showing. */
const INTRO_VERSION = '1';

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, INTRO_VERSION);
  } catch {
    // Private mode — the module-scope guard below still bounds it to once a launch.
  }
}

/** Module scope, so a re-mount inside one launch cannot re-open it. */
let announcedThisLaunch = false;

/** Exported for tests: should the introduction open, given the guards? */
export function shouldShowCodeReviewIntro(input: {
  offered: boolean;
  onboardingComplete: boolean;
  justOnboarded: boolean;
  openPrCount: number;
  seen: string | null;
}): boolean {
  // Never on the three-state `null` — showing this and then discovering the
  // account is not in the audience is the worst version of it.
  if (!input.offered) return false;
  if (!input.onboardingComplete) return false;
  // Somebody who finished the wizard ninety seconds ago has already seen the
  // step; `useWhatsNew` reads `justOnboarded` for exactly this reason.
  if (input.justOnboarded) return false;
  // The introduction names one of their own pull requests, so it needs one.
  if (input.openPrCount === 0) return false;
  return input.seen !== INTRO_VERSION;
}

export interface CodeReviewIntro {
  open: boolean;
  /** The pull request the introduction offers to review — their own, most recent. */
  examplePrId: string | null;
  dismiss: () => void;
}

export function useCodeReviewIntro(): CodeReviewIntro {
  const features = useWorkspaceStore((s) => s.features);
  const onboardingComplete = useWorkspaceStore((s) => s.onboardingComplete);
  const justOnboarded = useWorkspaceStore((s) => s.justOnboarded);
  const rows = usePullRequestStore((s) => s.rows);
  const [open, setOpen] = useState(false);
  const [examplePrId, setExamplePrId] = useState<string | null>(null);

  useEffect(() => {
    if (announcedThisLaunch || open) return;
    // Their OWN pull requests, most recently updated first: the example has to be
    // something they recognise, and a stranger's PR would read as an odd
    // suggestion.
    const mine = rows
      .filter((r) => r.authored)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    if (
      !shouldShowCodeReviewIntro({
        offered: codeReviewOffered(features),
        onboardingComplete,
        justOnboarded,
        openPrCount: mine.length,
        seen: readSeen(),
      })
    ) {
      return;
    }
    announcedThisLaunch = true;
    writeSeen();
    setExamplePrId(mine[0]?.id ?? null);
    setOpen(true);
    trackEvent('code_review_intro_shown', { open_prs: mine.length });
  }, [features, onboardingComplete, justOnboarded, rows, open]);

  return { open, examplePrId, dismiss: () => setOpen(false) };
}

/** Test seam: forget that this launch has already announced it. */
export function _resetCodeReviewIntroGuard(): void {
  announcedThisLaunch = false;
}
