import { describe, it, expect } from 'vitest';
import { PALETTE_FOUND_ELSEWHERE, paletteMatchScore, rankPaletteSections, type PaletteEntry, type PaletteSection } from '../lib/paletteSearch';

function entry(id: string, label: string, keywords: PaletteEntry['keywords'] = []): PaletteEntry {
  return { id, label, keywords, content: null, onSelect: () => {} };
}

function section(id: string, entries: PaletteEntry[], over: Partial<PaletteSection> = {}): PaletteSection {
  return { id, heading: id, kind: id, entries, ...over };
}

describe('paletteMatchScore', () => {
  it.each([
    ['', 'Anything'],
    ['   ', 'Anything'],
  ])('an empty search (%p) matches every row', (search, label) => {
    expect(paletteMatchScore(search, label)).toBe(1);
  });

  it.each([
    ['exact', 'home', 'Home', [], 1],
    ['exact, case and spaces ignored', '  HOME ', 'home', [], 1],
    ['label prefix', 'sett', 'Settings: Billing', [], 0.9],
    ['word in the label', 'bill', 'Settings: Billing', [], 0.8],
    ['word after a slash', 'lisbon', 'feat/lisbon', [], 0.8],
    ['inside a word', 'illi', 'Settings: Billing', [], 0.7],
    ['all words, any order', 'billing settings', 'Settings: Billing', [], 0.6],
    ['exact keyword', 'acme/web', 'lisbon', ['acme/web'], 0.5],
    ['keyword prefix', 'acme', 'lisbon', ['acme/web'], 0.45],
    ['word in a keyword', 'web', 'lisbon', ['acme/web'], 0.4],
    ['inside a keyword', 'cme', 'lisbon', ['acme/web'], 0.35],
    ['words across label and keywords', 'lisbon web', 'lisbon', ['acme/web'], 0.3],
    ['no match', 'zzz', 'Settings: Billing', ['acme/web'], 0],
    ['empty keywords are skipped', 'web', 'lisbon', [null, undefined, ''], 0],
  ])('%s', (_name, search, label, keywords, score) => {
    expect(paletteMatchScore(search, label, keywords)).toBeCloseTo(score);
  });

  it.each([
    ['sbil', 'Settings: Billing'],
    ['tgsb', 'Toggle Sidebar'],
  ])('a fuzzy match (%p in %p) scores below every other match', (search, label) => {
    const score = paletteMatchScore(search, label);
    expect(score).toBeGreaterThan(0.1);
    expect(score).toBeLessThanOrEqual(0.2);
  });

  it('scores a tighter fuzzy match higher', () => {
    expect(paletteMatchScore('tsb', 'Toggle Sidebar')).toBeLessThan(paletteMatchScore('tsb', 'the sb'));
  });

  it('does not fuzzy match keywords', () => {
    expect(paletteMatchScore('a1b2', 'lisbon', ['a-1-b-2'])).toBe(0);
  });

  it.each([
    ['exact', 'oslo', 'oslo trip'],
    ['prefix', 'oslo trip', 'trip to oslo'],
    ['word', 'trip to oslo', 'gosloop'],
    ['substring', 'gosloop', 'o-s-l-o'],
  ])('a %s label match ranks above the next tier', (_tier, better, worse) => {
    expect(paletteMatchScore('oslo', better)).toBeGreaterThan(paletteMatchScore('oslo', worse));
  });

  it('a weak label match ranks above a strong keyword match', () => {
    expect(paletteMatchScore('web', 'cobweb')).toBeGreaterThan(paletteMatchScore('web', 'lisbon', ['web']));
  });
});

describe('rankPaletteSections', () => {
  const ids = (search: string, sections: PaletteSection[]) => rankPaletteSections(search, sections).map((r) => r.entry.id);

  it('ranks across sections and drops rows that do not match', () => {
    const sections = [
      section('Session', [entry('s1', 'insights chart'), entry('s2', 'other')]),
      section('Navigate', [entry('n1', 'Insights'), entry('n2', 'Home')]),
    ];
    expect(ids('insights', sections)).toEqual(['n1', 's1']);
    expect(rankPaletteSections('insights', sections).map((r) => r.kind)).toEqual(['Navigate', 'Session']);
  });

  it('keeps section and row order for equal scores', () => {
    const sections = [
      section('a', [entry('a1', 'Fix one'), entry('a2', 'Fix two')]),
      section('b', [entry('b1', 'Fix three')]),
    ];
    expect(ids('fix', sections)).toEqual(['a1', 'a2', 'b1']);
  });

  it('keeps the best matches of a section with a limit', () => {
    const sections = [
      section('archived', [entry('x1', 'xoslo'), entry('x2', 'oslo'), entry('x3', 'oslo two')], { limit: 2 }),
    ];
    expect(ids('oslo', sections)).toEqual(['x2', 'x3']);
  });

  it('matches every row of a section with a match score, below keyword matches', () => {
    const sections = [
      section('Session', [entry('s1', 'Lisbon', ['pyarrow-branch']), entry('s2', 'Oslo')]),
      section('Transcript', [entry('t1', 'Upgrade deps'), entry('t2', 'Pyarrow notes')], { matchScore: PALETTE_FOUND_ELSEWHERE }),
    ];
    expect(ids('pyarrow', sections)).toEqual(['t2', 's1', 't1']);
  });

  it('keeps a match score row above a fuzzy match', () => {
    const sections = [
      section('Session', [entry('s1', 'p-y-a-r-r-o-w')]),
      section('Transcript', [entry('t1', 'Upgrade deps')], { matchScore: PALETTE_FOUND_ELSEWHERE }),
    ];
    expect(ids('pyarrow', sections)).toEqual(['t1', 's1']);
  });

  it.each([
    ['the name match when the name matches', 'oslo', ['s1']],
    ['the transcript match when only the transcript matches', 'pyarrow', ['t1']],
  ])('shows one row of a group: %s', (_name, search, expected) => {
    const sections = [
      section('Session', [{ ...entry('s1', 'Oslo'), group: 'wb:1' }]),
      section('Transcript', [{ ...entry('t1', 'Oslo'), group: 'wb:1' }], { matchScore: PALETTE_FOUND_ELSEWHERE }),
    ];
    expect(ids(search, sections)).toEqual(expected);
  });

  it('keeps rows without a group and rows of other groups', () => {
    const sections = [
      section('Session', [{ ...entry('s1', 'Oslo one'), group: 'wb:1' }, entry('s2', 'Oslo two'), { ...entry('s3', 'Oslo three'), group: 'wb:3' }]),
    ];
    expect(ids('oslo', sections)).toEqual(['s1', 's2', 's3']);
  });

  it('returns every row in order for an empty search', () => {
    const sections = [section('a', [entry('a1', 'One'), entry('a2', 'Two')]), section('b', [entry('b1', 'Three')])];
    expect(ids('', sections)).toEqual(['a1', 'a2', 'b1']);
  });
});
