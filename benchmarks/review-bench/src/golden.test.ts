import { describe, expect, it } from 'vitest';
import { summarise, type GoldenCase } from './golden.js';

const golden: GoldenCase = {
  repo: 'o/r', pr: 1, head: 'h', base: 'b',
  issues: [
    { id: 'G1', severity: 'high', file: 'a.ts', summary: 's' },
    { id: 'G2', severity: 'medium', file: 'a.ts', summary: 's' },
    { id: 'G3', severity: 'medium', file: 'b.ts', summary: 's' },
    { id: 'G4', severity: 'high', file: 'b.ts', summary: 's' },
  ],
};

describe('summarise', () => {
  it.each([
    [
      'no matches',
      '{"matches":{},"extras":{}}',
      [{ severity: 'major' }],
      { recall: 0, highRecall: 0, visibleRecall: 0, visibleWrong: 0, missed: ['G1', 'G2', 'G3', 'G4'] },
    ],
    [
      'a match through a visible finding',
      '{"matches":{"G1":["F1"],"G2":[]},"extras":{}}',
      [{ severity: 'major' }],
      { recall: 0.25, highRecall: 0.5, visibleRecall: 0.25, matched: ['G1'] },
    ],
    [
      'a match only through a nit counts for recall, not for visible recall',
      '{"matches":{"G2":["F2"],"G3":["F1"]},"extras":{"F3":"wrong","F4":"wrong"}}',
      [{ severity: 'minor' }, { severity: 'nit' }, { severity: 'nit' }, { severity: 'blocker' }],
      { recall: 0.5, highRecall: 0, visibleRecall: 0.25, visibleWrong: 1 },
    ],
    [
      'prose around the JSON',
      'Here it is:\n{"matches":{"G4":["F1"]}}\nDone.',
      [{ severity: 'major' }],
      { recall: 0.25, highRecall: 0.5, extras: {} },
    ],
    [
      'a reference to a finding that does not exist',
      '{"matches":{"G1":["F9"]}}',
      [{ severity: 'major' }],
      { recall: 0.25, visibleRecall: 0 },
    ],
  ] as const)('%s', (_label, reply, findings, expected) => {
    expect(summarise(golden, reply, findings as never)).toMatchObject(expected);
  });
});
