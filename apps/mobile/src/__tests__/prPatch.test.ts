import { applyPrUpdate, jsonEqual, mergeRowUpdate, mergeSummaryPatch } from '../workflow/prPatch';
import { pr } from './workflowFixtures';

describe('PR echo patches', () => {
  it.each([
    [{ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }, true],
    [{ a: 1 }, { a: 1, b: undefined }, false],
    [[1, 2], [2, 1], false],
    [null, null, true],
  ])('compares %j and %j', (a, b, expected) => expect(jsonEqual(a, b)).toBe(expected));
  it('merges a partial summary and keeps the rest', () => {
    const held = pr().summary;
    const next = mergeSummaryPatch(held, { ciStatus: 'failing_required' });
    expect(next).toMatchObject({ title: held.title, ciStatus: 'failing_required' });
  });
  it.each([[undefined], [{}], [{ title: 'Review current work' }]])('returns the held summary for a no-op patch %j', (patch) => {
    const held = pr().summary; expect(mergeSummaryPatch(held, patch)).toBe(held);
  });
  it('drops a checks slice older than the held one', () => {
    const held = { ...pr().summary, checksAt: 20, ciStatus: 'passing' as const };
    expect(mergeSummaryPatch(held, { checksAt: 10, ciStatus: 'failing_required', title: 'New' })).toMatchObject({ ciStatus: 'passing', title: 'New' });
  });
  it.each([
    ['absent keeps ours', {}, 'queued'],
    ['null clears', { mergeQueue: null }, undefined],
  ] as const)('merge queue: %s', (_name, patch, status) => {
    const row = pr({ mergeQueued: true, mergeQueue: { status: 'queued', position: 1 } });
    expect(mergeRowUpdate(row, { id: row.id, state: 'open', ...patch }).mergeQueue?.status).toBe(status);
  });
  it('keeps row identity when an echo changes nothing', () => {
    const row = pr(); expect(mergeRowUpdate(row, { id: row.id, state: 'open', lastSummary: { title: row.summary.title } })).toBe(row);
  });
  it('keeps list identity when nothing changed', () => {
    const rows = [pr()]; expect(applyPrUpdate(rows, { id: 'pr-one', state: 'open' }).rows).toBe(rows);
  });
});
