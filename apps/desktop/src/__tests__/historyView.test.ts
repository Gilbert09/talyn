import { filterAndGroupArchived, relativeTime } from '../renderer/pages/HistoryView';

const wb = (over: Record<string, unknown>) =>
  ({
    id: 'x',
    name: 'Oslo',
    branch: 'feat/a',
    baseBranch: 'main',
    repoFullName: 'o/r',
    status: 'archived',
    archivedAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...over,
  }) as never;

describe('filterAndGroupArchived', () => {
  const all = [
    wb({ id: '1', archivedAt: '2026-10-01T00:00:00Z' }),
    wb({ id: '2', name: 'Lima', archivedAt: '2026-10-05T00:00:00Z' }),
    wb({ id: '3', repoFullName: 'o/other', branch: 'fix/b', archivedAt: '2026-10-03T00:00:00Z' }),
    wb({ id: '4', status: 'active', archivedAt: null }),
  ];

  it.each([
    ['', ['2', '1', '3']],
    ['lima', ['2']],
    ['FIX/B', ['3']],
    ['o/other', ['3']],
    ['nope', []],
  ])('query %p', (q, ids) => {
    const flat = filterAndGroupArchived(all, q).flatMap((g) => g.items.map((i) => i.id));
    expect(flat.sort()).toEqual([...ids].sort());
  });

  it('groups by repo and orders each group newest first', () => {
    const groups = filterAndGroupArchived(all, '');
    expect(groups.find((g) => g.repo === 'o/r')?.items.map((i) => i.id)).toEqual(['2', '1']);
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-10-14T12:00:00Z').getTime();
  it.each([
    ['2026-10-14T11:59:50Z', 'just now'],
    ['2026-10-14T11:30:00Z', '30m ago'],
    ['2026-10-14T07:00:00Z', '5h ago'],
    ['2026-10-11T12:00:00Z', '3d ago'],
    ['2026-07-14T12:00:00Z', '3mo ago'],
    ['2024-10-14T12:00:00Z', '2y ago'],
  ])('%s -> %s', (iso, out) => expect(relativeTime(iso, now)).toBe(out));
});
