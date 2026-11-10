import type { PRRow } from '@talyn/client/native';
import type { PRFilterDefinition } from '@talyn/shared';

import { effectiveReviewSort, filterMine, filterQueue, filterReviews, filtersActive, liveFilters, matchesRequestedVia, MINE_CHIPS,
  mineChipCounts, NO_FILTERS, parseReviewSortMode, prMatchesText, repoChoices, requestedViaOptions, reviewRequestSearchText,
  reviewSortModes, toggled, type MineChip, type PrFilters } from '../features/prs/filters';
import type { ReviewSortMode } from '../features/prs/lists';
import { buildStackedRows } from '../features/prs/stacks';
import { pr } from './workflowFixtures';

const summary = (patch: Partial<PRRow['summary']>) => ({ ...pr().summary, ...patch });
const row = (id: string, patch: Partial<PRRow> = {}, summaryPatch: Partial<PRRow['summary']> = {}) =>
  pr({ id, number: Number(id.replace(/\D/g, '')) || 1, ...patch, summary: summary(summaryPatch) });
const day = (n: number) => `2026-11-${String(n).padStart(2, '0')}T00:00:00Z`;
const filters = (patch: Partial<PrFilters>): PrFilters => ({ ...NO_FILTERS, ...patch });
const saved = (id: string, criteria: PRFilterDefinition['criteria']): PRFilterDefinition =>
  ({ id, name: id, criteria, createdAt: day(1), updatedAt: day(1) });
const ids = (rows: PRRow[]) => rows.map((item) => item.id);

describe('search', () => {
  const target = row('pr-123', { owner: 'Example', repo: 'Project' }, { title: 'Fix the Login flow' });
  it.each([
    ['login', true], ['fix the', true], ['example/project', true], ['example/project#123', true], ['project#12', true],
    ['123', true], ['#123', true], ['#12', true], ['12', true], ['other', false], ['#999', false], ['example/other', false],
  ])('matches %j: %s', (q, expected) => expect(prMatchesText(target, q)).toBe(expected));

  it('treats a missing title as empty', () => {
    expect(prMatchesText({ owner: 'a', repo: 'b', number: 5, summary: {} }, 'title')).toBe(false);
  });

  it.each([
    [undefined, ''],
    [{ direct: true, teams: [] }, 'direct you'],
    [{ direct: false, teams: ['Org/Core', 'org/web'] }, 'org/core org/web'],
    [{ direct: true, teams: ['org/core'] }, 'direct you org/core'],
  ] as const)('builds review request search text for %j', (via, expected) =>
    expect(reviewRequestSearchText({ reviewRequestVia: via as PRRow['summary']['reviewRequestVia'] })).toBe(expected));
});

describe('My PRs chips', () => {
  const checks = { total: 2, passed: 2, failed: 0, inProgress: 0, skipped: 0 };
  const rows = [
    row('pr-1', { authored: true }, { blockingReason: 'merge_conflicts', reviewDecision: undefined }),
    row('pr-2', { authored: true }, { blockingReason: 'mergeable', reviewDecision: 'APPROVED', checks }),
    row('pr-3', { authored: true }, { blockingReason: 'blocked', reviewDecision: 'REVIEW_REQUIRED' }),
    // Watched, not authored: in the list and the Watching count, out of the other counts.
    row('pr-4', { authored: false, watching: true }, { blockingReason: 'checks_failed', reviewDecision: undefined }),
    row('pr-5', { authored: true, watching: true }, { blockingReason: 'changes_requested', reviewDecision: 'REVIEW_REQUIRED' }),
    // Neither: out of the cohort and every count.
    row('pr-6', { authored: false, watching: false }, { blockingReason: 'merge_conflicts' }),
  ];

  it('counts each chip over every row, like web', () => {
    expect(mineChipCounts(rows)).toEqual({ attention: 2, review: 2, ready: 1, watching: 2 });
    expect(mineChipCounts([])).toEqual({ attention: 0, review: 0, ready: 0, watching: 0 });
  });

  it('keeps web order and labels', () => {
    expect(MINE_CHIPS.map((chip) => chip.label)).toEqual(['Needs attention', 'Needs review', 'Ready to merge', 'Watching']);
  });

  it.each([
    [[], ['pr-1', 'pr-2', 'pr-3', 'pr-4', 'pr-5']],
    [['attention'], ['pr-1', 'pr-4', 'pr-5']],
    [['review'], ['pr-3', 'pr-5']],
    [['ready'], ['pr-2']],
    [['watching'], ['pr-4', 'pr-5']],
    // Chips combine with AND, as on web: each active chip narrows the list further.
    [['attention', 'watching'], ['pr-4', 'pr-5']],
    [['attention', 'review'], ['pr-5']],
    [['attention', 'review', 'watching'], ['pr-5']],
    [['ready', 'attention'], []],
  ] as const)('filters with chips %j', (chips, expected) => {
    const out = filterMine(rows, filters({ chips: [...chips] as MineChip[] }), [], 'asc').rows;
    expect(ids(out).sort()).toEqual([...expected].sort());
  });
});

describe('My PRs pipeline', () => {
  const rows = [
    row('pr-1', { authored: true, repositoryId: 'repo-a', repo: 'alpha', createdAt: day(1) }, { title: 'Alpha one', labels: ['bug'] }),
    row('pr-2', { authored: true, repositoryId: 'repo-b', repo: 'beta', createdAt: day(2) }, { title: 'Beta two', labels: ['ui'] }),
    row('pr-3', { authored: true, repositoryId: 'repo-a', repo: 'alpha', createdAt: day(3) }, { title: 'Alpha three', labels: ['ui'] }),
    row('pr-4', { watching: true, repositoryId: 'repo-b', repo: 'beta', createdAt: day(4) }, { title: 'Beta four', labels: [] }),
  ];
  const defs = [saved('bugs', { labels: ['bug'] }), saved('ui', { labels: ['ui'] }), saved('beta', { repos: ['example/beta'] })];

  it.each([
    ['nothing', {}, ['pr-4', 'pr-3', 'pr-2', 'pr-1']],
    ['a repository', { repo: { id: 'repo-a', name: 'example/alpha' } }, ['pr-3', 'pr-1']],
    ['a search', { search: '  ALPHA ' }, ['pr-3', 'pr-1']],
    ['a number', { search: '#2' }, ['pr-2']],
    ['a ref', { search: 'example/beta#4' }, ['pr-4']],
    ['one saved filter', { saved: ['bugs'] }, ['pr-1']],
    // Selected saved filters OR together.
    ['two saved filters', { saved: ['bugs', 'ui'] }, ['pr-3', 'pr-2', 'pr-1']],
    ['a saved filter and a repository', { saved: ['ui'], repo: { id: 'repo-b', name: 'example/beta' } }, ['pr-2']],
    ['a saved filter, a search and a chip', { saved: ['beta'], search: 'beta', chips: ['watching'] as MineChip[] }, ['pr-4']],
    ['an unknown saved id', { saved: ['gone'] }, ['pr-4', 'pr-3', 'pr-2', 'pr-1']],
    ['no match', { search: 'nothing here' }, []],
  ] as const)('filters by %s, newest first', (_name, patch, expected) =>
    expect(ids(filterMine(rows, filters(patch as Partial<PrFilters>), defs, 'desc').rows)).toEqual(expected));

  it('sorts oldest first when asked', () => {
    expect(ids(filterMine(rows, NO_FILTERS, defs, 'asc').rows)).toEqual(['pr-1', 'pr-2', 'pr-3', 'pr-4']);
  });
});

describe('stacks', () => {
  // pr-2 is on pr-1, pr-3 is on pr-2, and pr-4 is also on pr-1. pr-5 is alone, pr-6 is in another repository.
  const rows = [
    row('pr-1', { createdAt: day(1) }, { headBranch: 'one', baseBranch: 'main' }),
    row('pr-2', { createdAt: day(5) }, { headBranch: 'two', baseBranch: 'one' }),
    row('pr-3', { createdAt: day(6) }, { headBranch: 'three', baseBranch: 'two' }),
    row('pr-4', { createdAt: day(3) }, { headBranch: 'four', baseBranch: 'one' }),
    row('pr-5', { createdAt: day(4) }, { headBranch: 'five', baseBranch: 'main' }),
    row('pr-6', { createdAt: day(2), repositoryId: 'repo-two' }, { headBranch: 'six', baseBranch: 'one' }),
  ];

  it.each([
    ['desc', ['pr-5', 'pr-6', 'pr-1', 'pr-2', 'pr-3', 'pr-4']],
    ['asc', ['pr-1', 'pr-4', 'pr-2', 'pr-3', 'pr-6', 'pr-5']],
  ] as const)('keeps a stack together root first, %s', (dir, expected) => {
    const { ordered, meta } = buildStackedRows(rows, dir);
    expect(ids(ordered)).toEqual(expected);
    expect(meta.get('pr-1')).toEqual({ depth: 0, stacked: true, parentNumber: null });
    expect(meta.get('pr-3')).toEqual({ depth: 2, stacked: true, parentNumber: 2 });
    expect(meta.get('pr-4')).toEqual({ depth: 1, stacked: true, parentNumber: 1 });
    expect(meta.get('pr-5')).toEqual({ depth: 0, stacked: false, parentNumber: null });
    expect(meta.get('pr-6')).toEqual({ depth: 0, stacked: false, parentNumber: null });
  });

  it('does not link a closed child', () => {
    const { meta } = buildStackedRows([rows[0], { ...rows[1], state: 'closed' }], 'desc');
    expect(meta.get('pr-2')).toEqual({ depth: 0, stacked: false, parentNumber: null });
  });

  it('shows a child as a root when its parent is filtered out', () => {
    const { ordered, meta } = buildStackedRows([rows[1], rows[2]], 'desc');
    expect(ids(ordered)).toEqual(['pr-2', 'pr-3']);
    expect(meta.get('pr-2')?.parentNumber).toBeNull();
  });

  it('never drops a row on a base and head cycle', () => {
    const cycle = [row('pr-1', {}, { headBranch: 'a', baseBranch: 'b' }), row('pr-2', {}, { headBranch: 'b', baseBranch: 'a' })];
    expect(ids(buildStackedRows(cycle, 'desc').ordered).sort()).toEqual(['pr-1', 'pr-2']);
  });

  it('returns nothing for no rows', () => expect(buildStackedRows([], 'desc').ordered).toEqual([]));
});

describe('Review requests', () => {
  const via = (direct: boolean, teams: string[]) => ({ reviewRequestVia: { direct, teams } });
  const rows = [
    row('pr-1', { createdAt: day(1), repositoryId: 'repo-a' }, { title: 'One', ...via(true, []) }),
    row('pr-2', { createdAt: day(2), repositoryId: 'repo-b' }, { title: 'Two', ...via(false, ['org/web']) }),
    row('pr-3', { createdAt: day(3), repositoryId: 'repo-a' }, { title: 'Three', ...via(false, ['org/core', 'org/web']) }),
    row('pr-4', { createdAt: day(4), reviewHiddenAt: day(5) }, { title: 'Hidden', ...via(false, ['org/api']) }),
    row('pr-5', { createdAt: day(5), reviewRequested: false }, { title: 'Not asked', ...via(false, ['org/zzz']) }),
  ];

  it('offers directly, then teams by name, from every review request', () => {
    expect(requestedViaOptions(rows)).toEqual([{ value: 'direct', label: 'Directly' }, { value: 'team:org/api', label: '@org/api' },
      { value: 'team:org/core', label: '@org/core' }, { value: 'team:org/web', label: '@org/web' }]);
    expect(requestedViaOptions([row('pr-9')])).toEqual([]);
  });

  it.each([
    ['direct', via(true, []), true], ['direct', via(false, ['x']), false], ['team:x', via(false, ['x']), true],
    ['team:x', via(true, []), false], ['team:x', {}, false], ['other', via(false, []), true],
  ] as const)('matches %s on %j: %s', (value, s, expected) =>
    expect(matchesRequestedVia(s as Pick<PRRow['summary'], 'reviewRequestVia'>, value)).toBe(expected));

  it.each([
    ['nothing', {}, 'newest', ['pr-3', 'pr-2', 'pr-1']],
    ['oldest', {}, 'oldest', ['pr-1', 'pr-2', 'pr-3']],
    ['a repository', { repo: { id: 'repo-a', name: 'a' } }, 'newest', ['pr-3', 'pr-1']],
    ['direct', { requestedVia: 'direct' }, 'newest', ['pr-1']],
    ['a team', { requestedVia: 'team:org/web' }, 'newest', ['pr-3', 'pr-2']],
    ['a search on the requester', { search: 'org/core' }, 'newest', ['pr-3']],
    ['a search on "you"', { search: 'you' }, 'newest', ['pr-1']],
    ['a search on the title', { search: 'two' }, 'newest', ['pr-2']],
    ['a saved filter', { saved: ['one'] }, 'newest', ['pr-1']],
    ['a team and a repository', { requestedVia: 'team:org/web', repo: { id: 'repo-b', name: 'b' } }, 'newest', ['pr-2']],
  ] as const)('filters by %s', (_name, patch, mode, expected) => {
    const defs = [saved('one', { authors: ['example-author'], repos: ['example/project'] }), saved('none', { authors: ['nobody'] })];
    const scoped = (patch as Partial<PrFilters>).saved ? rows.map((item) => item.id === 'pr-1' ? item
      : { ...item, summary: { ...item.summary, author: 'someone-else' } }) : rows;
    expect(ids(filterReviews(scoped, filters(patch as Partial<PrFilters>), defs, { mode: mode as ReviewSortMode, now: 0 }))).toEqual(expected);
  });
});

describe('review sort', () => {
  it.each([
    [null, 'priority'], [undefined, 'priority'], ['newest', 'newest'], ['oldest', 'oldest'], ['priority', 'priority'], ['bogus', 'priority'],
  ] as const)('reads stored %j as %s', (value, expected) => expect(parseReviewSortMode(value)).toBe(expected));

  it.each([
    ['priority', true, 'priority'], ['priority', false, 'newest'], ['newest', false, 'newest'], ['oldest', true, 'oldest'],
  ] as const)('runs %s with priority offered %s as %s', (mode, offered, expected) => expect(effectiveReviewSort(mode, offered)).toBe(expected));

  it.each([[true, ['newest', 'oldest', 'priority']], [false, ['newest', 'oldest']]] as const)('offers modes with priority %s', (offered, expected) =>
    expect(reviewSortModes(offered)).toEqual(expected));
});

describe('filter state', () => {
  it.each([
    [{}, false], [{ search: '   ' }, false], [{ search: 'x' }, true], [{ repo: { id: 'r', name: 'r' } }, true],
    [{ chips: ['ready'] as MineChip[] }, true], [{ saved: ['a'] }, true], [{ requestedVia: 'direct' }, true],
  ] as const)('is active for %j: %s', (patch, expected) => expect(filtersActive(filters(patch as Partial<PrFilters>))).toBe(expected));

  it('drops a deleted saved filter and a request option that is gone', () => {
    const state = filters({ saved: ['a', 'gone'], requestedVia: 'team:old' });
    expect(liveFilters(state, { savedIds: ['a'], requestedVia: [{ value: 'direct', label: 'Directly' }] }))
      .toEqual({ ...state, saved: ['a'], requestedVia: null });
  });

  it('keeps the same object when nothing is stale', () => {
    const state = filters({ saved: ['a'], requestedVia: 'direct' });
    expect(liveFilters(state, { savedIds: ['a', 'b'], requestedVia: [{ value: 'direct', label: 'Directly' }] })).toBe(state);
  });

  it.each([[[], 'a', ['a']], [['a'], 'a', []], [['a', 'b'], 'a', ['b']], [['b'], 'a', ['b', 'a']]] as const)('toggles %j with %s', (list, value, expected) =>
    expect(toggled(list, value)).toEqual(expected));

  it('lists the repositories present, by name', () => {
    expect(repoChoices([row('pr-1', { repositoryId: 'b', repo: 'zeta' }), row('pr-2', { repositoryId: 'a', repo: 'alpha' }),
      row('pr-3', { repositoryId: 'b', repo: 'zeta' })])).toEqual([{ id: 'a', name: 'example/alpha' }, { id: 'b', name: 'example/zeta' }]);
  });

  it('searches the merge queue only inside the queue', () => {
    const rows = [row('pr-1', { mergeQueued: true }, { title: 'Queued fix' }), row('pr-2', { mergeQueued: false }, { title: 'Queued not' }),
      row('pr-3', { mergeQueued: true }, { title: 'Other' })];
    expect(ids(filterQueue(rows, ''))).toEqual(['pr-1', 'pr-3']);
    expect(ids(filterQueue(rows, ' QUEUED '))).toEqual(['pr-1']);
    expect(ids(filterQueue(rows, '#3'))).toEqual(['pr-3']);
  });
});
