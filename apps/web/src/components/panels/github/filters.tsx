import { ArrowUpDown, FilterX, Sparkles } from 'lucide-react';

export type SortDir = 'asc' | 'desc';

/**
 * Reset every filter on the page at once — the repo dropdown, the toggles, the
 * saved-filter chips, and the search box. Hidden while nothing is filtering, so
 * the bar doesn't carry a control that would do nothing.
 */
export function ClearFiltersButton({ active, onClear }: { active: boolean; onClear: () => void }) {
  if (!active) return null;
  return (
    <button
      type="button"
      onClick={onClear}
      className="flex items-center gap-1 rounded-md border px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
      title="Clear every filter on this page, including the search box"
    >
      <FilterX className="h-3 w-3" />
      Clear
    </button>
  );
}

/** Repo dropdown — native select keeps the bar compact + keyboard-friendly. */
export function RepoFilter({
  value,
  onChange,
  repos,
}: {
  value: string;
  onChange: (v: string) => void;
  repos: Array<{ id: string; name: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 rounded-md border bg-background px-2 py-0 text-xs leading-7"
    >
      <option value="all">All repos</option>
      {repos.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </select>
  );
}

/** Created-at sort toggle (newest/oldest first). */
export function SortToggle({ sortDir, onToggle }: { sortDir: SortDir; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-1 rounded-md border px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
      title={`Sorted by created date — ${
        sortDir === 'desc' ? 'newest first' : 'oldest first'
      }. Click to flip.`}
    >
      <ArrowUpDown className="h-3 w-3" />
      {sortDir === 'desc' ? 'Newest' : 'Oldest'}
    </button>
  );
}

/**
 * How the Reviews page is ordered.
 *
 * A superset of {@link SortDir}'s two states rather than a replacement for it:
 * `SortToggle` is also driven by My PRs, where `sortDir` additionally feeds
 * `buildStackedRows`, and that page is not being reordered. Two controls, one
 * shared comparator for the date modes.
 */
export type ReviewSortMode = 'newest' | 'oldest' | 'priority';

/** The cycle order of {@link ReviewSortToggle}. */
const REVIEW_SORT_CYCLE: ReviewSortMode[] = ['newest', 'oldest', 'priority'];

const REVIEW_SORT_LABEL: Record<ReviewSortMode, string> = {
  newest: 'Newest',
  oldest: 'Oldest',
  priority: 'Priority',
};

/**
 * The Reviews page's sort control — newest / oldest / priority.
 *
 * Cycles rather than showing three segments. The filter bar is a row of compact
 * `h-7` controls and a segmented control unbalances it; cycling also keeps the
 * muscle memory of the two-state toggle this replaces, with the label always
 * naming the mode that is active.
 *
 * `offerPriority` is the feature gate. When it is false the control has exactly
 * two states and behaves identically to `SortToggle` — a user outside the
 * audience sees no trace of the third.
 */
export function ReviewSortToggle({
  mode,
  onChange,
  offerPriority,
  modelInstalled = false,
  eventsUntilPersonalized,
  nEvents,
}: {
  mode: ReviewSortMode;
  onChange: (next: ReviewSortMode) => void;
  offerPriority: boolean;
  /** Whether a personalized model is serving. Changes the tooltip only. */
  modelInstalled?: boolean;
  /** How many more reviews before a personal model is attempted. */
  eventsUntilPersonalized?: number;
  /** Reviews behind the current model, for the same sentence. */
  nEvents?: number;
}) {
  const cycle = offerPriority
    ? REVIEW_SORT_CYCLE
    : REVIEW_SORT_CYCLE.filter((m) => m !== 'priority');
  // A stored 'priority' can outlive the flag being taken away, so fall back
  // rather than rendering a mode the cycle no longer contains.
  const current = cycle.includes(mode) ? mode : 'newest';
  const next = cycle[(cycle.indexOf(current) + 1) % cycle.length];

  const title =
    current === 'priority'
      ? modelInstalled
        ? `Sorted by what you're most likely to review next — learned from your own review history${
            nEvents ? ` (${nEvents} reviews)` : ''
          }, plus each PR's current state. Click for ${REVIEW_SORT_LABEL[next].toLowerCase()} first.`
        : // Says WHY it is not personalized, and what would change that. A
          // feature that quietly does less than its name promises is worse than
          // one that explains itself.
          `Sorted by each PR's current state, its size, and how long it has waited.${
            eventsUntilPersonalized
              ? ` Personalized ordering turns on after about ${eventsUntilPersonalized} more reviews.`
              : ''
          } Click for ${REVIEW_SORT_LABEL[next].toLowerCase()} first.`
      : `Sorted by created date — ${
          current === 'newest' ? 'newest first' : 'oldest first'
        }. Click for ${REVIEW_SORT_LABEL[next].toLowerCase()}.`;

  return (
    <button
      type="button"
      data-attr="pr-review-sort-toggle"
      onClick={() => onChange(next)}
      className="flex items-center gap-1 rounded-md border px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
      title={title}
    >
      {current === 'priority' ? (
        <Sparkles className="h-3 w-3" />
      ) : (
        <ArrowUpDown className="h-3 w-3" />
      )}
      {REVIEW_SORT_LABEL[current]}
    </button>
  );
}

/**
 * Whether two PRs are ordered by {@link compareByCreated} under this mode.
 * `priority` has its own comparator and never reaches here.
 */
export function sortDirForMode(mode: ReviewSortMode): SortDir {
  return mode === 'oldest' ? 'asc' : 'desc';
}

/**
 * Whether a PR matches a (lowercased, trimmed) search query by its title,
 * `owner/repo`, `owner/repo#number` ref, or bare PR number. A leading `#` on
 * the query is ignored so both `#123` and `123` match the number.
 */
export function prMatchesText(
  r: { owner: string; repo: string; number: number; summary: { title?: string } },
  q: string
): boolean {
  const title = r.summary.title?.toLowerCase() ?? '';
  const repo = `${r.owner}/${r.repo}`.toLowerCase();
  const ref = `${repo}#${r.number}`;
  const num = String(r.number);
  return (
    title.includes(q) ||
    ref.includes(q) ||
    num.includes(q.replace(/^#/, ''))
  );
}

/** Order two PRs by when they were opened on GitHub (DB createdAt fallback). */
export function compareByCreated(
  a: { summary: { createdAt?: string }; createdAt: string },
  b: { summary: { createdAt?: string }; createdAt: string },
  sortDir: SortDir
): number {
  const ta = new Date(a.summary.createdAt || a.createdAt).getTime();
  const tb = new Date(b.summary.createdAt || b.createdAt).getTime();
  return sortDir === 'desc' ? tb - ta : ta - tb;
}
