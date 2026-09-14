import { useEffect } from 'react';
import { planWhatsNew, whatsNewFetchFloor, type WhatsNewCursors } from '@talyn/shared';
import { api } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';
import { releaseVersion } from '../lib/appVersion';

/**
 * Decides whether to open the "What's new" modal on launch.
 *
 * How far this client has read lives in localStorage, per device — like the
 * theme and the auto-keep explainer. It gates an explainer, not an entitlement,
 * so there is nothing here worth a schema column: the worst case of losing it
 * is one extra baseline read on a new machine.
 *
 * Three outcomes:
 *   - No stored cursors (first ever run): record the latest release and show
 *     nothing. A brand-new user wants the app, not a changelog.
 *   - Stored cursors, nothing notable since: record the new high-water mark
 *     and show nothing. Most nightlies land here.
 *   - Stored cursors with notable releases since: open the modal.
 *
 * A build whose version isn't a semver — which is every local build — opts out
 * of all three. Without a version there is no way to tell which releases this
 * build actually contains, and guessing in either direction is worse than
 * saying nothing: no ceiling shows features that aren't here, and recording a
 * baseline from a dev profile would swallow real notes later.
 *
 * Mounted once from MainLayout, which is inside the onboarding gate — so this
 * can never fire over the wizard.
 */

/**
 * One cursor per stream (`''` plus one per gated feature) rather than the
 * single version this used to store.
 *
 * A gated feature's highlights are withheld by the backend, so "the newest
 * release I have read" and "the newest release I have been SHOWN everything
 * from" stopped being the same number the moment anything could be held back.
 * Keeping one number meant a user read straight past a feature they were never
 * offered; a cursor per gate freezes that stream until the feature is released
 * and then replays it. See `planWhatsNew` in @talyn/shared.
 */
export const CURSORS_KEY = 'fastowl:whatsNew:cursors';

/**
 * The single version this stored before cursors, still read for the one-way
 * migration below and deliberately still WRITTEN alongside them.
 *
 * Talyn ships a build every night and the updater can roll a user backwards; a
 * build that only understands this key must not re-show months of notes because
 * a newer one stopped maintaining it.
 */
export const LAST_SEEN_KEY = 'fastowl:whatsNew:lastSeenVersion';

/** Fail toward showing nothing: private mode shouldn't pop a modal every launch. */
export function readCursors(): WhatsNewCursors {
  try {
    const raw = localStorage.getItem(CURSORS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: WhatsNewCursors = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'string') out[key] = value;
        }
        return out;
      }
    }
    // Migration: an existing user arrives here with only the old scalar. Seed
    // the ungated stream from it and let planWhatsNew freeze the gates at the
    // same point — anything withheld BEFORE this moment is not replayed, which
    // is right, because it was already shown to them by the bug this replaced.
    const legacy = localStorage.getItem(LAST_SEEN_KEY);
    return legacy ? { '': legacy } : {};
  } catch {
    return {};
  }
}

export function writeCursors(cursors: WhatsNewCursors): void {
  if (!cursors['']) return;
  try {
    localStorage.setItem(CURSORS_KEY, JSON.stringify(cursors));
    localStorage.setItem(LAST_SEEN_KEY, cursors['']);
  } catch {
    // best-effort
  }
}

/**
 * The running build's version.
 *
 * Baked in by webpack at build time (see .erb/configs/appVersion.ts) so it can
 * be read synchronously — the IPC `app:getVersion()` round-trip resolves after
 * this hook has already decided. A local build reports `dev` or `dev+<sha>`,
 * neither of which is a semver, so the auto-open path simply never fires
 * outside a CI build; Settings → About is how you look at the modal on a dev
 * machine.
 *
 * The "is this a release?" test lives in lib/appVersion so this hook and the
 * analytics `environment` property cannot disagree about what a local build is.
 */
export function currentAppVersion(): string | null {
  return releaseVersion();
}

export function useWhatsNew(): void {
  const checked = useWorkspaceStore((s) => s.whatsNewChecked);
  const markChecked = useWorkspaceStore((s) => s.markWhatsNewChecked);
  const openWhatsNew = useWorkspaceStore((s) => s.openWhatsNew);
  // A user who just finished onboarding installed the app minutes ago. Nothing
  // in the feed is "new" to them, whatever their (absent) stored version says.
  const justOnboarded = useWorkspaceStore((s) => s.justOnboarded);

  useEffect(() => {
    if (checked) return;
    markChecked();

    // See the docblock: an unversioned build cannot answer "do I have this
    // release?", so it doesn't try. Settings → About still opens the modal.
    const currentVersion = currentAppVersion();
    if (!currentVersion) return;

    void (async () => {
      try {
        const cursors = readCursors();

        if (!cursors['']) {
          // A brand-new user gets a baseline and no changelog — they installed
          // the app minutes ago and nothing in the feed is "new" to them.
          if (justOnboarded) {
            const latest = await api.releaseNotes.latest();
            const baseline = latest?.version ?? currentVersion;
            // Every gate baselines here too: `planWhatsNew` freezes each one at
            // the ungated cursor on first sight, so a feature released later
            // replays from this instant rather than from the start of time.
            writeCursors({ '': baseline });
            return;
          }

          // But an EXISTING user reaches here too, and that is the case this
          // branch exists for. A missing key does not mean "new install"; it
          // also means "first run of a build that has this feature", which is
          // every user Talyn already had. Baselining them silently is why the
          // 0.2.64 notes were invisible to everyone who was already using it.
          //
          // Scoped deliberately to the ONE release they are running. "Here is
          // what changed in the update you just got" is the honest claim;
          // replaying months of releases at someone who was using the app the
          // whole time is not, and the size of that modal would grow with the
          // table forever.
          const all = await api.releaseNotes.list();
          const plan = planWhatsNew({
            // Floor, not a real version: the window is already narrowed to the
            // single entry below, so this just means "no lower bound".
            cursors: { '': '0.0.0' },
            currentVersion,
            entries: all.filter((e) => e.version === currentVersion),
            surface: 'desktop' as const,
          });
          // Only the ungated stream is written. Every gate freezes at this same
          // point on the next launch, on first sight — writing them here would
          // say the same thing twice and let the two drift.
          writeCursors({ '': currentVersion });
          if (plan.show.length > 0) openWhatsNew(plan.show);
          return;
        }

        // The floor is the OLDEST cursor, not the ungated one. A gate frozen
        // months ago needs its backlog inside this response on the day it
        // lifts, and asking from the ungated high-water mark returns a window
        // that cannot contain it.
        const entries = await api.releaseNotes.list(whatsNewFetchFloor(cursors));
        const plan = planWhatsNew({
          cursors,
          currentVersion,
          entries,
          surface: 'desktop' as const,
        });

        // Written back whether or not anything is shown: a release whose
        // highlights were all web-only is still read, and leaving it unrecorded
        // means re-fetching and re-evaluating it on every launch forever.
        writeCursors(plan.cursors);

        if (plan.show.length > 0) openWhatsNew(plan.show);
      } catch {
        // Offline, or the backend is mid-deploy. Nothing is written, so the
        // next launch tries again from the same point.
      }
    })();
  }, [checked, justOnboarded, markChecked, openWhatsNew]);
}
