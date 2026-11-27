import { describe, expect, it } from 'vitest';
import { main, remapScoreReply, reviewerEnv, summarise, type GoldenCase } from './golden.js';

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
      { recall: 0, highRecall: 0, visibleRecall: 0, matched: [], missed: ['G1', 'G2', 'G3', 'G4'] },
    ],
    [
      'a malformed reference next to a real one',
      '{"matches":{"G1":["X1","F0"],"G2":["F9","F1"]}}',
      [{ severity: 'major' }],
      { recall: 0.25, highRecall: 0, visibleRecall: 0.25, matched: ['G2'] },
    ],
    [
      'one finding claimed by two golden issues counts once, for the first',
      '{"matches":{"G1":["F1"],"G2":["F1"]}}',
      [{ severity: 'major' }],
      { recall: 0.25, highRecall: 0.5, visibleRecall: 0.25, matched: ['G1'], missed: ['G2', 'G3', 'G4'] },
    ],
    [
      'a shared finding does not hide an issue that has its own',
      '{"matches":{"G1":["F1"],"G2":["F1","F2"]}}',
      [{ severity: 'major' }, { severity: 'nit' }],
      { recall: 0.5, visibleRecall: 0.25, matched: ['G1', 'G2'] },
    ],
    [
      'the same reference twice in one issue',
      '{"matches":{"G3":["F1","F1"]}}',
      [{ severity: 'minor' }],
      { recall: 0.25, visibleRecall: 0.25, matched: ['G3'] },
    ],
  ] as const)('%s', (_label, reply, findings, expected) => {
    expect(summarise(golden, reply, findings as never)).toMatchObject(expected);
  });
});

describe('reviewerEnv', () => {
  const env = {
    PATH: '/bin', LANG: 'C.UTF-8', HTTPS_PROXY: 'http://p', https_proxy: 'http://p',
    ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://a', CLAUDE_CODE_USE_BEDROCK: '1',
    HOME: '/home/me', GITHUB_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 's', NPM_TOKEN: 'n', SSH_AUTH_SOCK: '/s',
  };

  it('keeps what the model call needs and sets HOME', () => {
    expect(reviewerEnv(env, '/tmp/h')).toEqual({
      HOME: '/tmp/h', PATH: '/bin', LANG: 'C.UTF-8', HTTPS_PROXY: 'http://p', https_proxy: 'http://p',
      ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://a', CLAUDE_CODE_USE_BEDROCK: '1',
    });
  });

  it.each(['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'SSH_AUTH_SOCK'])('drops %s', (name) => {
    expect(reviewerEnv(env, '/tmp/h')).not.toHaveProperty(name);
  });
});

describe('main', () => {
  it('refuses to run without --sandboxed, before it reads any file', async () => {
    await expect(
      main(['--case', '/nope.json', '--repo', '/nope', '--files', '/nope', '--pr', '/nope', '--out', '/nope'])
    ).rejects.toThrow('--sandboxed');
  });
});

describe('remapScoreReply', () => {
  const unjudged = [{ dedupeKey: 'a' }, { dedupeKey: 'b' }, { dedupeKey: 'c' }];

  it.each([
    ['keeps a match whose finding survived, at its new position',
      '{"matches":{"G1":["F2"]},"extras":{}}', [{ dedupeKey: 'b' }], { matches: { G1: ['F1'] }, extras: {} }],
    ['drops a match whose finding the judge dropped',
      '{"matches":{"G1":["F1"],"G2":["F3"]}}', [{ dedupeKey: 'c' }], { matches: { G1: [], G2: ['F1'] }, extras: {} }],
    ['moves and drops extras the same way',
      '{"matches":{},"extras":{"F1":"wrong","F3":"real"}}', [{ dedupeKey: 'c' }, { dedupeKey: 'a' }],
      { matches: {}, extras: { F2: 'wrong', F1: 'real' } }],
    ['ignores a reference to no candidate',
      'text {"matches":{"G1":["F9","x"]}} text', [{ dedupeKey: 'a' }], { matches: { G1: [] }, extras: {} }],
  ] as const)('%s', (_label, reply, final, expected) => {
    expect(JSON.parse(remapScoreReply(reply, unjudged, [...final]))).toEqual(expected);
  });

  it('never scores the final list above the candidates', () => {
    const reply = '{"matches":{"G1":["F1"],"G2":["F2"],"G4":["F3"]},"extras":{}}';
    const findings = unjudged.map(() => ({ severity: 'major' as const }));
    const final = [{ dedupeKey: 'c', severity: 'major' as const }];
    const before = summarise(golden, reply, findings);
    const after = summarise(golden, remapScoreReply(reply, unjudged, final), final);
    expect(before.recall).toBe(0.75);
    expect(after).toMatchObject({ recall: 0.25, matched: ['G4'] });
  });
});
