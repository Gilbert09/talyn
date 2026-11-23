import { applyPrUpdate, jsonEqual, mergeRowUpdate, mergeSummaryPatch, reuseRows } from '../workflow/prPatch';
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

describe('reusing rows across a list refetch', () => {
  const one = pr({ id: 'pr-one', number: 1 });
  const two = pr({ id: 'pr-two', number: 2 });
  it.each([
    ['no held list', undefined],
    ['an empty held list', []],
  ])('returns the fresh list for %s', (_name, held) => {
    const fresh = [pr()]; expect(reuseRows(held, fresh)).toBe(fresh);
  });
  it('returns the held list when every row is the same', () => {
    const held = [one, two]; expect(reuseRows(held, [pr({ id: 'pr-one', number: 1 }), pr({ id: 'pr-two', number: 2 })])).toBe(held);
  });
  it('keeps unchanged rows and takes changed ones', () => {
    const changed = pr({ id: 'pr-two', number: 2, mergeQueued: true });
    const next = reuseRows([one, two], [pr({ id: 'pr-one', number: 1 }), changed]);
    expect(next).toEqual([one, changed]); expect(next[0]).toBe(one); expect(next[1]).toBe(changed);
  });
  it.each([
    ['a new order', () => [pr({ id: 'pr-two', number: 2 }), pr({ id: 'pr-one', number: 1 })], [two, one]],
    ['a removed row', () => [pr({ id: 'pr-one', number: 1 })], [one]],
    ['an added row', () => [pr({ id: 'pr-one', number: 1 }), pr({ id: 'pr-two', number: 2 }), pr({ id: 'pr-three', number: 3 })], null],
  ] as const)('returns a new list for %s and keeps held rows', (_name, fresh, expected) => {
    const held = [one, two];
    const next = reuseRows(held, fresh());
    expect(next).not.toBe(held);
    if (expected) expected.forEach((row, index) => expect(next[index]).toBe(row));
    else { expect(next[0]).toBe(one); expect(next[1]).toBe(two); expect(next[2].id).toBe('pr-three'); }
  });
  it('takes a row whose nested summary changed', () => {
    const fresh = pr({ id: 'pr-one', number: 1, summary: { ...one.summary, ciStatus: 'failing_required' } });
    expect(reuseRows([one], [fresh])[0]).toBe(fresh);
  });
});
