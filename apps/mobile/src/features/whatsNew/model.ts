import { compareVersions, highlightsForSurface, type HighlightKind, type ReleaseNoteEntry } from '@talyn/shared';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The mobile changelog: only the highlights tagged for the mobile app, newest
 * release first. Desktop and web highlights never show here, and mobile
 * highlights never show in the desktop or web modal.
 */
export function mobileReleaseNotes(entries: readonly ReleaseNoteEntry[] | null | undefined): ReleaseNoteEntry[] {
  return highlightsForSurface(entries ?? [], 'mobile').sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * The heading for one release: its date, "12 Nov 2026". Not its version: the
 * release version is the desktop build number, and the mobile app has its own.
 */
export function releaseDateLabel(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'Release';
  const date = new Date(at);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export const KIND_LABEL: Record<HighlightKind, string> = { feature: 'New', improvement: 'Improved', fix: 'Fixed' };
export const KIND_TONE = { feature: 'primary', improvement: 'success', fix: 'muted' } as const satisfies Record<HighlightKind, string>;

export const WHATS_NEW_INTRO = 'Recent changes to the Talyn mobile app.';
export const WHATS_NEW_EMPTY = 'There are no mobile release notes yet.';
