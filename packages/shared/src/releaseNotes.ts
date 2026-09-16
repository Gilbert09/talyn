// Release notes — the "What's new" feed behind the modal both front ends show
// after an update.
//
// Talyn cuts a stable release EVERY NIGHT, and most nights carry a handful of
// commits that no user would notice. Two consequences shape everything here:
//
//   1. The unit the user sees is not a release, it's the span between the
//      version they last saw and the one they're running — which may be a
//      dozen nightlies. `shouldShowWhatsNew` returns that span, and returns
//      nothing at all when the span has no user-facing content.
//   2. What reaches a highlight has to be filtered twice: once mechanically
//      (`filterReleaseCommits`, which drops merge commits, non-user commit
//      types and internal scopes), and once editorially by the model in CI.
//   3. A feature that is still behind a flag is NOT dropped — it is TAGGED with
//      the flag that gates it (`requiresFeature`), withheld from everybody by
//      the backend while `availability` says `'gated'`, and replayed the moment
//      that flips. See `planWhatsNew` at the bottom of this file; the seen-state
//      is one cursor per gate for exactly that reason.
//
// Everything in this file is pure and lives in @talyn/shared on purpose. The
// CI generator, the backend, the desktop renderer and apps/web all depend on
// the same version ordering and the same show/don't-show rule; `apps/web` is a
// deliberate fork of the desktop renderer, so a second copy of this logic is
// how the two clients start disagreeing about what a user has already seen.

import {
  FEATURE_FLAGS,
  gateForScopeIn,
  type FeatureFlagKey,
  type FeatureFlagRegister,
} from './featureFlags.js';

/** What kind of change a highlight describes. Drives the modal's icon. */
export type HighlightKind = 'feature' | 'fix' | 'improvement';

/** Which client a highlight is relevant to. A change can land on both. */
export type ReleaseSurface = 'desktop' | 'web';

/** One user-facing line in the modal. Written by the CI generator. */
export interface ReleaseHighlight {
  /** Short, sentence case, no trailing period. */
  title: string;
  /** One sentence, written for a user rather than for a reviewer. */
  description: string;
  kind: HighlightKind;
  /**
   * Non-empty. A highlight that applies to neither client should not have
   * been generated at all.
   */
  surfaces: ReleaseSurface[];
  /**
   * The feature flag this highlight was published under, when it describes a
   * gated feature. A flag KEY from `FEATURE_FLAGS`, stored as a plain string so
   * a row written months ago still parses after the flag has been deleted.
   *
   * Absent means "nothing gates this". Present does not mean "hidden": the
   * backend decides that per request against the CURRENT register, so a
   * highlight tagged `loops` becomes visible the day Loops goes general.
   */
  requiresFeature?: string;
}

/** One release, as served by `GET /api/v1/release-notes`. */
export interface ReleaseNoteEntry {
  /** `X.Y.Z`, matching the GitHub release tag without the `v`. */
  version: string;
  /** ISO 8601. */
  publishedAt: string;
  /**
   * May be empty: a nightly with nothing user-facing still gets a row, so the
   * `?since=` window stays correct and the version is never re-summarised.
   *
   * Gated highlights are already gone by the time a client sees this — the
   * backend strips them, so their text never leaves the server.
   */
  highlights: ReleaseHighlight[];
  /**
   * Every feature currently being withheld, as flag keys.
   *
   * Response-level metadata rather than a property of this release: it is the
   * backend's whole gate set at request time, repeated on each entry, and a
   * client must read it as such. Two consequences that are easy to get wrong:
   *
   *   - It is NOT "what was stripped from this release". A gate with no content
   *     in the fetched range still has to appear, or the client advances that
   *     gate's cursor past the point it was frozen at and loses the backlog.
   *   - It is repeated per entry so `GET /release-notes` stays a JSON ARRAY. An
   *     envelope would be tidier and would also make every already-installed
   *     desktop build throw on the response it no longer recognises.
   *
   * Only flag keys travel — never the withheld text. The keys are already in
   * every shipped client bundle.
   */
  gatedFeatures?: string[];
}

// ============================================================================
// Versions
// ============================================================================

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** `"v0.2.61"` / `"0.2.61"` → `{0, 2, 61}`. `null` for anything else. */
export function parseVersion(value: string | null | undefined): ParsedVersion | null {
  if (!value) return null;
  const m = VERSION_RE.exec(value.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * A single orderable integer for a version — what `release_notes.sort_key`
 * stores, so `?since=` is one indexed comparison rather than a string sort
 * (`"0.2.9"` sorts after `"0.2.10"` as text).
 *
 * The 10^6 stride per component is not decoration: Talyn ships a patch every
 * night, so a 10^3 stride would collide after under three years. At 10^6 the
 * result stays an exact JS integer (< 2^53) for any major below ~9000.
 */
export function versionSortKey(value: string | ParsedVersion): number {
  const v = typeof value === 'string' ? parseVersion(value) : value;
  if (!v) return -1;
  return v.major * 1_000_000_000_000 + v.minor * 1_000_000 + v.patch;
}

/** Standard comparator: negative when `a` is older. Unparseable sorts first. */
export function compareVersions(a: string, b: string): number {
  return versionSortKey(a) - versionSortKey(b);
}

// ============================================================================
// Commit filtering
// ============================================================================

export interface ParsedCommit {
  /** `feat`, `fix`, `chore`, … */
  type: string;
  /** The `(scope)`, when present. */
  scope: string | null;
  /** The subject with the type/scope prefix and the trailing `(#N)` removed. */
  subject: string;
  /** The PR number from a trailing `(#N)`, when the commit was squash-merged. */
  pr: number | null;
  /** The line as it appeared, for prompts and debugging. */
  raw: string;
  /**
   * The feature flag this commit's scope says it belongs to, or `null`.
   *
   * Set by {@link filterReleaseCommits} from the register, never by hand. A
   * tagged commit is still summarised — it is grouped and stamped rather than
   * discarded, which is what lets the release be announced later.
   */
  gate: FeatureFlagKey | null;
}

const CONVENTIONAL_RE =
  /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?!?: (?<subject>.+?)(?:\s\(#(?<pr>\d+)\))?$/i;

/**
 * Parses a conventional-commit subject line. Returns `null` for anything that
 * isn't one — including the `Merge pull request #N from …` commits GitHub
 * writes on a merge-commit merge, which is exactly what we want dropped.
 *
 * The trailing `(#N)` is optional because only squash merges through the
 * GitHub UI carry it; most of Talyn's commits land by direct push and have no
 * PR number at all.
 */
export function parseConventionalCommit(
  subject: string,
  register: FeatureFlagRegister = FEATURE_FLAGS,
): ParsedCommit | null {
  const line = subject.split('\n')[0]?.trim() ?? '';
  if (!line) return null;
  const m = CONVENTIONAL_RE.exec(line);
  if (!m?.groups) return null;
  const scope = m.groups.scope?.toLowerCase() ?? null;
  return {
    type: m.groups.type.toLowerCase(),
    scope,
    subject: m.groups.subject.trim(),
    pr: m.groups.pr ? Number(m.groups.pr) : null,
    raw: line,
    gate: gateForScopeIn(register, scope) as FeatureFlagKey | null,
  };
}

/**
 * Commit types that can produce a highlight. `docs`, `chore`, `refactor`,
 * `test`, `ci`, `style` and `build` never describe something a user of the app
 * can observe, so they never reach the model.
 */
export const USER_FACING_TYPES: readonly string[] = ['feat', 'fix', 'perf'];

/**
 * Scopes whose changes a Talyn user cannot see from inside the app: `admin` is
 * the operator console (admin.talyn.dev), `marketing` is the public website,
 * and the rest are build/observability plumbing.
 *
 * These are permanently invisible — nothing will ever make a `chore(deps)` bump
 * worth announcing. A real product surface that is merely not available YET is
 * a different thing entirely and is never dropped: see `releaseScopes` and
 * `availability` in `featureFlags.ts`.
 *
 * Exported so the list can be tuned without editing the filter.
 */
export const INTERNAL_SCOPES: readonly string[] = [
  'admin',
  'ci',
  // Our own release-notes pipeline. A user cannot see it, and it was reaching
  // the model every time it changed — which the model then correctly discarded.
  'release-notes',
  'debug',
  'deps',
  'build',
  'test',
  'marketing',
  'docs',
];

/**
 * The mechanical pre-filter: what the model in CI is even allowed to consider.
 * Everything it drops is dropped without judgement; everything it keeps is
 * still subject to the model's editorial pass, which is where "would a user
 * notice this?" gets answered.
 *
 * Note what it does NOT drop. A commit for a feature still behind a flag comes
 * back with `gate` set, is summarised like any other, and is withheld later by
 * the backend. That used to be a drop, against a hand-written list of scopes in
 * this file, and the list is why Loops was announced to every user who could
 * not open it: the list said `['fleet']` and nobody remembered to add `loops`.
 * The register already knew.
 *
 * `register` defaults to the live one and exists so this behaviour stays
 * testable once every real flag is general — at which point no live flag can
 * demonstrate a withheld commit. See `FeatureFlagRegister`.
 */
export function filterReleaseCommits(
  subjects: readonly string[],
  register: FeatureFlagRegister = FEATURE_FLAGS,
): ParsedCommit[] {
  const kept: ParsedCommit[] = [];
  for (const subject of subjects) {
    const parsed = parseConventionalCommit(subject, register);
    if (!parsed) continue;
    if (!USER_FACING_TYPES.includes(parsed.type)) continue;
    if (parsed.scope && INTERNAL_SCOPES.includes(parsed.scope)) continue;
    kept.push(parsed);
  }
  return kept;
}

/**
 * Which clients a commit's scope implies. `desktop` and `web` are the two
 * forks; everything else (backend, shared, a bare scope-less commit) reaches
 * both. A starting point for the generator — the model may override it when
 * the subject says otherwise.
 */
export function surfacesForScope(scope: string | null): ReleaseSurface[] {
  if (scope === 'desktop') return ['desktop'];
  if (scope === 'web') return ['web'];
  return ['desktop', 'web'];
}

/** The `kind` a commit type implies, before the model refines it. */
export function kindForCommitType(type: string): HighlightKind {
  if (type === 'feat') return 'feature';
  if (type === 'perf') return 'improvement';
  return 'fix';
}

// ============================================================================
// What to show, and what to remember having shown
// ============================================================================

/**
 * Drop every highlight that doesn't apply to this client, and every entry
 * thereby left empty.
 *
 * Used on both paths into the modal — the launch check below and the
 * Settings → About button, which reads the whole changelog rather than a span.
 * Shared so the two cannot disagree about what a release contains: a desktop
 * user opening the changelog should not see the line about a web-only change
 * simply because they arrived from a different button.
 *
 * Says nothing about gating. By the time an entry is here the backend has
 * already removed what is withheld, so Settings → About cannot leak a gated
 * feature either.
 */
export function highlightsForSurface(
  entries: readonly ReleaseNoteEntry[],
  surface: ReleaseSurface
): ReleaseNoteEntry[] {
  return entries
    .map((entry) => ({
      ...entry,
      highlights: entry.highlights.filter((h) => h.surfaces.includes(surface)),
    }))
    .filter((entry) => entry.highlights.length > 0);
}

/**
 * How far through the feed this client has read — one version per stream.
 *
 * The key is a feature flag key, and `''` is the ungated stream that carries
 * almost everything. A single scalar was enough while gated work was simply
 * never written down; it stopped being enough the moment a highlight could be
 * withheld, because "seen" and "not shown to you yet" are different facts and
 * one number cannot hold both.
 *
 * How a gate's cursor behaves is the whole mechanism:
 *
 *   - The first time the client hears that a gate exists, that gate's cursor is
 *     FROZEN at wherever the ungated stream had reached. Nothing published
 *     after that instant can be read past.
 *   - While the gate is up the cursor does not move, however many launches go
 *     by, because nothing under it was ever shown.
 *   - When the gate comes down, the cursor is still parked where it was, so the
 *     whole backlog renders at once — on the first launch after the feature
 *     became real to that user, which is when they can act on it.
 *
 * That replaces an obligation a human had to remember (edit a list of scopes in
 * the same commit that removes the gate, or the feature ships to everybody and
 * is never mentioned) with something that cannot be forgotten.
 */
export type WhatsNewCursors = Record<string, string>;

/** The ungated stream's key. Spelled out so no call site invents `'none'`. */
export const UNGATED_STREAM = '';

export interface WhatsNewPlanInput {
  /** What this client has read so far. `{}` on a first run — see the hooks. */
  cursors: WhatsNewCursors;
  /**
   * The version actually running, when the client has an orderable one. The
   * desktop passes its semver; `apps/web` passes `null`, because its build id
   * is a commit sha (`web/<sha>`) that cannot be compared — and because web is
   * continuously deployed, so it is always at or ahead of the latest cut.
   */
  currentVersion: string | null;
  /** Whatever the backend returned, in any order. */
  entries: readonly ReleaseNoteEntry[];
  /** Which client is asking. Highlights for the other one are dropped. */
  surface: ReleaseSurface;
}

export interface WhatsNewPlan {
  /** The entries to render, newest first. Empty means: show nothing. */
  show: ReleaseNoteEntry[];
  /**
   * The cursors to persist, always — including when `show` is empty. A release
   * whose highlights were all for the other surface is still read, and leaving
   * it unrecorded means re-fetching and re-evaluating it on every launch
   * forever.
   */
  cursors: WhatsNewCursors;
}

/**
 * The oldest version any stream still has to read from — the `?since=` the
 * client must ask the backend for.
 *
 * Not the ungated cursor: a gate frozen six months ago needs its backlog in the
 * response on the day it lifts, and asking from the ungated high-water mark
 * would return a window that cannot contain it. `null` means "no floor, send
 * the lot", which is the correct answer on a first run.
 */
export function whatsNewFetchFloor(cursors: WhatsNewCursors): string | null {
  let floor: string | null = null;
  let floorKey = Number.POSITIVE_INFINITY;
  for (const version of Object.values(cursors)) {
    const key = versionSortKey(version);
    if (key < 0) return null; // an unparseable cursor: ask for everything
    if (key < floorKey) {
      floorKey = key;
      floor = version;
    }
  }
  return floor;
}

/**
 * What to render on launch, and what to write back — answered together.
 *
 * Deliberately one function returning both. They were two (`shouldShowWhatsNew`
 * plus `nextSeenVersion`), each re-deriving the same window from the same
 * input, and with per-gate cursors that duplication becomes a way for the modal
 * to show a highlight while the cursor it advances says it never did.
 */
export function planWhatsNew(input: WhatsNewPlanInput): WhatsNewPlan {
  const cursors: WhatsNewCursors = { ...input.cursors };
  const ungated = cursors[UNGATED_STREAM];
  // No baseline means this client has never read anything, and a first run
  // shows nothing — a brand-new user wants the app, not a changelog. The hooks
  // establish the baseline before ever getting here.
  if (versionSortKey(ungated ?? '') < 0) return { show: [], cursors: input.cursors };

  // The ceiling matters on the desktop: the backend knows about tonight's
  // release the moment CI posts it, but the user is still running last night's
  // build. Showing them a feature they don't have yet would both confuse them
  // AND burn the entry — they'd never see it again after the update landed.
  const current = parseVersion(input.currentVersion);
  const ceiling = current ? versionSortKey(current) : Number.POSITIVE_INFINITY;

  const inRange = input.entries
    .filter((e) => versionSortKey(e.version) <= ceiling)
    .sort((a, b) => versionSortKey(b.version) - versionSortKey(a.version));
  if (inRange.length === 0) return { show: [], cursors: input.cursors };

  // Every gate the backend is currently withholding. Read off the entries
  // rather than off this client's own copy of the register on purpose: a
  // desktop build can be nights behind the backend, and a gate it has never
  // heard of still has to freeze.
  const withheld = new Set<string>();
  for (const entry of inRange) {
    for (const key of entry.gatedFeatures ?? []) withheld.add(key);
  }

  // Every gate this response mentions at all: the withheld ones, plus any gate
  // whose highlights are being SERVED because it has already come down.
  const known = new Set<string>(withheld);
  for (const entry of inRange) {
    for (const h of entry.highlights) {
      if (h.requiresFeature) known.add(h.requiresFeature);
    }
  }

  // Freeze on first sight, at the ungated high-water mark. This also handles a
  // gate that came down before this client ever heard of it: its cursor starts
  // level with the ungated stream, so its backlog is whatever the ungated
  // stream had not read either — no replay of ancient history.
  for (const key of known) {
    if (cursors[key] === undefined) cursors[key] = ungated;
  }

  const show = inRange
    .map((entry) => {
      const entryKey = versionSortKey(entry.version);
      return {
        ...entry,
        highlights: entry.highlights.filter((h) => {
          if (!h.surfaces.includes(input.surface)) return false;
          const stream = h.requiresFeature ?? UNGATED_STREAM;
          return entryKey > versionSortKey(cursors[stream] ?? ungated);
        }),
      };
    })
    .filter((entry) => entry.highlights.length > 0);

  // Advance, never retreat. `inRange` is not filtered to "above the cursor" —
  // it cannot be, because each stream has its own — so the newest entry in the
  // window is routinely OLDER than a cursor that is already past it. The
  // desktop hits this on every launch where the ceiling sits above the newest
  // published release, and an unguarded write would walk the cursor backwards
  // and re-show the same modal.
  const newest = inRange[0].version;
  const newestKey = versionSortKey(newest);
  for (const key of Object.keys(cursors)) {
    if (key !== UNGATED_STREAM && withheld.has(key)) continue;
    if (newestKey > versionSortKey(cursors[key])) cursors[key] = newest;
  }

  return { show, cursors };
}
