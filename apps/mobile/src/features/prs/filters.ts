import type { PRRow, PRSummaryShape } from '@talyn/client/native';
import { loadReviewSortMode, parsePullRequestUrl, prMatchesAnyFilter, type PRFilterCriteria, type PRFilterDefinition } from '@talyn/shared';

import { isAwaitingReview, isNeedsAttention, isReadyToMerge, mineCohort, queueCohort, reviewCohort, sortReviews,
  type ReviewSortMode, type SortDir } from './lists';
import { buildStackedRows, type StackMeta } from './stacks';

// ---------------------------------------------------------------------------
// The filter bar on the PR pages. Ports the web filter row and its pipeline.
// ---------------------------------------------------------------------------

export type MineChip = 'attention' | 'review' | 'ready' | 'watching';

/** The My PRs toggle chips, in web order. Each active chip narrows the list further. */
export const MINE_CHIPS: ReadonlyArray<{ key: MineChip; label: string; test(row: PRRow): boolean }> = [
  { key: 'attention', label: 'Needs attention', test: isNeedsAttention },
  { key: 'review', label: 'Needs review', test: isAwaitingReview },
  { key: 'ready', label: 'Ready to merge', test: isReadyToMerge },
  { key: 'watching', label: 'Watching', test: (row) => row.watching },
];

/** Web chip counts: over every row, the first three for PRs you opened, Watching for what you watch. */
export function mineChipCounts(rows: PRRow[]): Record<MineChip, number> {
  const counts: Record<MineChip, number> = { attention: 0, review: 0, ready: 0, watching: 0 };
  for (const row of rows) {
    for (const chip of MINE_CHIPS) {
      if ((chip.key === 'watching' || row.authored) && chip.test(row)) counts[chip.key]++;
    }
  }
  return counts;
}

export const SORT_LABEL: Record<ReviewSortMode, string> = { newest: 'Newest', oldest: 'Oldest', priority: 'Priority' };

/** A stored sort, read like web `loadReviewSortMode`: Priority unless the value says newest or oldest. */
export function parseReviewSortMode(value: string | null | undefined): ReviewSortMode {
  return loadReviewSortMode({ getItem: () => value ?? null });
}

/** The modes the Reviews sort offers. Priority only for accounts that have it. */
export function reviewSortModes(priorityOffered: boolean): ReviewSortMode[] {
  return priorityOffered ? ['newest', 'oldest', 'priority'] : ['newest', 'oldest'];
}

/** A stored Priority can outlive the feature, so it falls back to Newest, like web. */
export function effectiveReviewSort(mode: ReviewSortMode, priorityOffered: boolean): ReviewSortMode {
  return mode === 'priority' && !priorityOffered ? 'newest' : mode;
}

export interface RepoChoice { id: string; name: string }

/** The repositories present in a page's rows, by name. */
export function repoChoices(rows: PRRow[]): RepoChoice[] {
  const byId = new Map<string, string>();
  for (const row of rows) if (!byId.has(row.repositoryId)) byId.set(row.repositoryId, `${row.owner}/${row.repo}`);
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export interface RequestedViaOption { value: string; label: string }

/** Web "Requested via" options: directly, then each team by name, from every review request. */
export function requestedViaOptions(rows: PRRow[]): RequestedViaOption[] {
  const teams = new Set<string>();
  let direct = false;
  for (const row of rows) {
    const via = row.reviewRequested ? row.summary.reviewRequestVia : undefined;
    if (!via) continue;
    if (via.direct) direct = true;
    for (const team of via.teams) teams.add(team);
  }
  return [...(direct ? [{ value: 'direct', label: 'Directly' }] : []),
    ...[...teams].sort().map((team) => ({ value: `team:${team}`, label: `@${team}` }))];
}

export function matchesRequestedVia(summary: Pick<PRSummaryShape, 'reviewRequestVia'>, value: string): boolean {
  const via = summary.reviewRequestVia;
  if (!via) return false;
  if (value === 'direct') return via.direct;
  if (value.startsWith('team:')) return via.teams.includes(value.slice(5));
  return true;
}

/**
 * Web `prMatchesText`, for a lowercased and trimmed query: the title, the
 * `owner/repo#number` ref, or the number. A leading `#` is ignored for the number.
 * A GitHub PR URL matches only that PR.
 */
export function prMatchesText(row: Pick<PRRow, 'owner' | 'repo' | 'number'> & { summary: { title?: string } }, q: string): boolean {
  const url = parsePullRequestUrl(q);
  if (url) return url.number === row.number && `${url.owner}/${url.repo}`.toLowerCase() === `${row.owner}/${row.repo}`.toLowerCase();
  const ref = `${row.owner}/${row.repo}#${row.number}`.toLowerCase();
  return (row.summary.title ?? '').toLowerCase().includes(q) || ref.includes(q) || String(row.number).includes(q.replace(/^#/, ''));
}

/** Web `reviewRequestSearchText` without the viewer's login, which mobile does not have. */
export function reviewRequestSearchText(summary: Pick<PRSummaryShape, 'reviewRequestVia'>): string {
  const via = summary.reviewRequestVia;
  if (!via) return '';
  return [...(via.direct ? ['direct', 'you'] : []), ...via.teams].join(' ').toLowerCase();
}

export interface PrFilters {
  repo: RepoChoice | null;
  search: string;
  chips: MineChip[];
  /** Selected saved filter ids. */
  saved: string[];
  requestedVia: string | null;
}

export const NO_FILTERS: PrFilters = Object.freeze({ repo: null, search: '', chips: [], saved: [], requestedVia: null }) as PrFilters;

/**
 * Drop choices that no longer exist: a deleted saved filter, or a team that
 * no longer asks. Web drops them too, or the page filters against nothing.
 */
export function liveFilters(filters: PrFilters, known: { savedIds: string[]; requestedVia: RequestedViaOption[] }): PrFilters {
  const saved = filters.saved.filter((id) => known.savedIds.includes(id));
  const requestedVia = filters.requestedVia && known.requestedVia.some((option) => option.value === filters.requestedVia) ? filters.requestedVia : null;
  return saved.length === filters.saved.length && requestedVia === filters.requestedVia ? filters : { ...filters, saved, requestedVia };
}

export function filtersActive(filters: PrFilters): boolean {
  return Boolean(filters.repo || filters.search.trim() || filters.chips.length || filters.saved.length || filters.requestedVia);
}

export function toggled<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

const criteriaFor = (definitions: PRFilterDefinition[], ids: string[]): PRFilterCriteria[] =>
  definitions.filter((definition) => ids.includes(definition.id)).map((definition) => definition.criteria);

const query = (filters: PrFilters) => filters.search.trim().toLowerCase();

/**
 * My PRs, as web filters it: repository, then search, then the chips (all
 * active chips must match), then saved filters (any selected one may match).
 * Stacks stay together in the chosen order.
 */
export function filterMine(rows: PRRow[], filters: PrFilters, definitions: PRFilterDefinition[], sortDir: SortDir):
  { rows: PRRow[]; meta: Map<string, StackMeta> } {
  let out = mineCohort(rows);
  if (filters.repo) out = out.filter((row) => row.repositoryId === filters.repo!.id);
  const q = query(filters);
  if (q) out = out.filter((row) => prMatchesText(row, q));
  for (const chip of MINE_CHIPS) if (filters.chips.includes(chip.key)) out = out.filter(chip.test);
  const criteria = criteriaFor(definitions, filters.saved);
  if (criteria.length) out = out.filter((row) => prMatchesAnyFilter(row, criteria));
  const { ordered, meta } = buildStackedRows(out, sortDir);
  return { rows: ordered, meta };
}

/** Review requests, as web filters them: repository, search, requested via, saved filters, then the sort. */
export function filterReviews(rows: PRRow[], filters: PrFilters, definitions: PRFilterDefinition[],
  options: { mode: ReviewSortMode; now: number }): PRRow[] {
  let out = reviewCohort(rows);
  if (filters.repo) out = out.filter((row) => row.repositoryId === filters.repo!.id);
  const q = query(filters);
  if (q) out = out.filter((row) => prMatchesText(row, q) || reviewRequestSearchText(row.summary).includes(q));
  if (filters.requestedVia) out = out.filter((row) => matchesRequestedVia(row.summary, filters.requestedVia!));
  const criteria = criteriaFor(definitions, filters.saved);
  if (criteria.length) out = out.filter((row) => prMatchesAnyFilter(row, criteria));
  return sortReviews(out, options);
}

/** The merge queue only searches. Its grouping stays as it is. */
export function filterQueue(rows: PRRow[], search: string): PRRow[] {
  const q = search.trim().toLowerCase();
  const out = queueCohort(rows);
  return q ? out.filter((row) => prMatchesText(row, q)) : out;
}
