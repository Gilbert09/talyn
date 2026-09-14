import { useEffect } from 'react';
import { planWhatsNew, whatsNewFetchFloor, type WhatsNewCursors } from '@talyn/shared';
import { api } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';

/**
 * Decides whether to open the "What's new" modal on load. The web half of the
 * desktop hook of the same name, with one structural difference.
 *
 * **There is no `currentVersion` here.** The desktop's version is a real semver
 * baked into the build; this app's is `web/<sha>` (see lib/env.ts), which has
 * no order. That is not a gap to work around — it is correct for this client.
 * app.talyn.dev is continuously deployed on every push to main, so it is always
 * at or ahead of the newest cut release, and there is no such thing as a
 * release entry describing code this build does not have. The desktop needs the
 * ceiling precisely because the opposite is true there: the backend knows about
 * tonight's release the moment CI posts it, while the user is still on last
 * night's build.
 *
 * Everything else matches: how far the client has read is per-device
 * localStorage, the first load records a baseline and shows nothing, and
 * highlights that apply only to the desktop are filtered out.
 */

/**
 * One cursor per stream (`''` plus one per gated feature) rather than the
 * single version this used to store. A gated feature's highlights are withheld
 * by the backend, so "the newest release I have read" and "the newest release I
 * have been SHOWN everything from" stopped being the same number. A cursor per
 * gate freezes that stream until the feature is released and then replays it —
 * see `planWhatsNew` in @talyn/shared.
 */
export const CURSORS_KEY = 'fastowl:whatsNew:cursors';

/**
 * The single version this stored before cursors, still read for the one-way
 * migration below and still written alongside them, so a client that only
 * understands this key does not re-show months of notes.
 */
export const LAST_SEEN_KEY = 'fastowl:whatsNew:lastSeenVersion';

/** Fail toward showing nothing: private mode shouldn't pop a modal every load. */
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
    // Migration: an existing user arrives with only the old scalar. Seed the
    // ungated stream from it and let planWhatsNew freeze the gates at the same
    // point on first sight.
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

export function useWhatsNew(): void {
  const checked = useWorkspaceStore((s) => s.whatsNewChecked);
  const markChecked = useWorkspaceStore((s) => s.markWhatsNewChecked);
  const openWhatsNew = useWorkspaceStore((s) => s.openWhatsNew);
  const justOnboarded = useWorkspaceStore((s) => s.justOnboarded);

  useEffect(() => {
    // `whatsNewChecked` is store state rather than a ref because MainLayout is
    // rendered per route here — a component-local guard would re-run this on
    // every navigation.
    if (checked) return;
    markChecked();

    void (async () => {
      try {
        const cursors = readCursors();

        if (!cursors['']) {
          // A brand-new user gets a baseline and no changelog — they signed up
          // minutes ago and nothing in the feed is "new" to them.
          if (justOnboarded) {
            const latest = await api.releaseNotes.latest();
            if (latest) writeCursors({ '': latest.version });
            return;
          }

          // But an EXISTING user reaches here too, and that is the case this
          // branch exists for. A missing key does not mean "new install"; it
          // also means "first load after this feature shipped", which is every
          // user Talyn already had. Baselining them silently is why the 0.2.64
          // notes were invisible to everyone who was already using it.
          //
          // Scoped deliberately to the ONE newest release rather than the whole
          // table — which is what this client is running, since app.talyn.dev
          // deploys on every push and is always at or ahead of the newest cut.
          const all = await api.releaseNotes.list();
          const newest = all[0];
          if (!newest) return;
          const plan = planWhatsNew({
            // Floor, not a real version: the window is already narrowed to the
            // single entry above, so this just means "no lower bound".
            cursors: { '': '0.0.0' },
            currentVersion: null,
            entries: [newest],
            surface: 'web' as const,
          });
          // Only the ungated stream is written. Every gate freezes at this same
          // point on the next load, on first sight.
          writeCursors({ '': newest.version });
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
          currentVersion: null,
          entries,
          surface: 'web' as const,
        });

        writeCursors(plan.cursors);

        if (plan.show.length > 0) openWhatsNew(plan.show);
      } catch {
        // Offline, or the backend is mid-deploy. Nothing is written, so the
        // next load tries again from the same point.
      }
    })();
  }, [checked, justOnboarded, markChecked, openWhatsNew]);
}
