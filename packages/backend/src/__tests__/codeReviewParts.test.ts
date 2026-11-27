import { describe, expect, it } from 'vitest';
import {
  CODE_REVIEW_DEFAULT_LENS_ORDER,
  CODE_REVIEW_PART_LINES,
  codeReviewLensReadsPart,
  codeReviewLensRunsOnChunk,
  codeReviewOutputContract,
  codeReviewUnitCount,
  planCodeReviewParts,
} from '@talyn/shared';
import {
  REVIEW_LENSES,
  buildJudgePrompt,
  buildLensPrompt,
  buildSweepPrompt,
  isRepositoryRuleFile,
  lensByKey,
  type ReviewPromptContext,
} from '../services/codeReview/lenses.js';
import { filesForChunk } from '../services/codeReview/unitPure.js';

const file = (filename: string, additions: number, deletions = 0) => ({
  filename,
  status: 'modified',
  additions,
  deletions,
  patch: `@@ -1 +1 @@\n+${filename}`,
});

const ctx = (over: Partial<ReviewPromptContext> = {}): ReviewPromptContext => ({
  ref: 'acme/app#7',
  title: 't',
  body: 'b',
  headBranch: 'feature',
  baseBranch: 'main',
  files: [file('src/a.ts', 10)],
  chunkIndex: 1,
  chunkTotal: 1,
  ...over,
});

const names = (parts: { filename: string }[][]) => parts.map((p) => p.map((f) => f.filename));

describe('planCodeReviewParts', () => {
  it.each([
    ['no files', [], 4, []],
    ['one small file', [file('a.ts', 5)], 4, [['a.ts']]],
    ['a change under one part', [file('a/x.ts', 300), file('b/y.ts', 299)], 4, [['a/x.ts', 'b/y.ts']]],
    ['a single huge file', [file('a/x.ts', 5000)], 4, [['a/x.ts']]],
    ['one part allowed', [file('a/x.ts', 700), file('b/y.ts', 700)], 1, [['a/x.ts', 'b/y.ts']]],
    [
      'two directories that each fill a part',
      [file('b/y.ts', 500), file('a/x.ts', 500)],
      4,
      [['a/x.ts'], ['b/y.ts']],
    ],
    [
      'a directory that fits stays together',
      [file('a/1.ts', 200), file('a/2.ts', 200), file('b/1.ts', 550)],
      4,
      [['a/1.ts', 'a/2.ts'], ['b/1.ts']],
    ],
  ] as const)('%s', (_label, files, maxParts, expected) => {
    expect(names(planCodeReviewParts(files as never, maxParts))).toEqual(expected);
  });

  it('puts a small part together with the next one instead of alone', () => {
    const parts = planCodeReviewParts([file('a/tiny.ts', 10), file('b/big.ts', 800), file('c/z.ts', 500)], 4);
    expect(names(parts)).toEqual([['a/tiny.ts', 'b/big.ts'], ['c/z.ts']]);
  });

  it('packs a directory larger than one part file by file', () => {
    const files = [1, 2, 3, 4].map((i) => file(`big/${i}.ts`, 400));
    expect(names(planCodeReviewParts(files, 4))).toEqual([
      ['big/1.ts'],
      ['big/2.ts'],
      ['big/3.ts'],
      ['big/4.ts'],
    ]);
  });

  it.each([2, 3, 4, 8])('grows the parts so a large change fits in %i', (maxParts) => {
    const files = Array.from({ length: 30 }, (_, i) => file(`d${i}/f.ts`, 400));
    const parts = planCodeReviewParts(files, maxParts);
    expect(parts.length).toBeLessThanOrEqual(maxParts);
    expect(parts.flat().map((f) => f.filename).sort()).toEqual(files.map((f) => f.filename).sort());
  });

  it('counts deletions as changed lines', () => {
    expect(planCodeReviewParts([file('a/x.ts', 0, 700), file('b/y.ts', 0, 700)], 4)).toHaveLength(2);
  });

  it('is the same split whatever order GitHub lists the files in', () => {
    const files = [file('b/y.ts', 500), file('a/x.ts', 500), file('c/z.ts', 500)];
    expect(names(planCodeReviewParts(files, 4))).toEqual(names(planCodeReviewParts([...files].reverse(), 4)));
  });

  it('uses about 600 lines per part', () => {
    expect(CODE_REVIEW_PART_LINES).toBe(600);
  });
});

describe('filesForChunk', () => {
  const files = [file('a/x.ts', 500), file('b/y.ts', 500), file('c/z.ts', 500)];

  it('returns every file when the review is one part', () => {
    expect(filesForChunk(files, 0, 1)).toEqual(files);
  });

  it.each([0, 1, 2])('returns the planned part %i', (index) => {
    expect(filesForChunk(files, index, 3)).toEqual(planCodeReviewParts(files, 3)[index]);
  });

  it('deals the files out round-robin when the list no longer splits into the frozen count', () => {
    // A push during the review: the cycle froze 5 parts, the files now make 3.
    const all = [0, 1, 2, 3, 4].flatMap((i) => filesForChunk(files, i, 5));
    expect(all.map((f) => f.filename).sort()).toEqual(files.map((f) => f.filename).sort());
  });
});

describe('the whole-PR lens', () => {
  it.each([
    ['correctness', 0, true],
    ['correctness', 1, false],
    ['rules', 0, true],
    ['rules', 2, false],
    ['security', 0, true],
    ['security', 3, true],
    ['custom:skill', 2, true],
  ] as const)('%s on chunk %i runs: %s', (lens, chunk, runs) => {
    expect(codeReviewLensRunsOnChunk(lens, chunk)).toBe(runs);
  });

  it('keeps the shared lens order equal to the prompts', () => {
    expect(REVIEW_LENSES.map((l) => l.key)).toEqual([...CODE_REVIEW_DEFAULT_LENS_ORDER]);
  });
});

describe('codeReviewUnitCount with parts', () => {
  it.each([
    // preset, parts, lenses, whole-PR lenses, expected
    ['quick', 1, undefined, undefined, 1],
    ['standard', 1, undefined, undefined, 6],
    // generalist + rules + 2 lenses x 3 parts + 3 sweeps + 1 judge
    ['standard', 3, undefined, undefined, 12],
    ['standard', 4, 3, 1, 14],
    // Without the generalist every lens reads each part.
    ['standard', 3, 2, 0, 10],
    // generalist + rules + 4 lenses x 2 parts + 2 sweeps + 1 judge
    ['deep', 2, undefined, undefined, 13],
  ] as const)('%s with %i part(s), %s lenses, %s whole: %i', (preset, parts, lenses, whole, expected) => {
    expect(codeReviewUnitCount(preset, parts, lenses, whole)).toBe(expected);
  });
});

describe('isRepositoryRuleFile', () => {
  it.each([
    ['AGENTS.md', true],
    ['products/x/AGENTS.md', true],
    ['AGENTS.override.md', true],
    ['CLAUDE.md', true],
    ['docs/REVIEW.md', true],
    ['.agents/skills/x/SKILL.md', true],
    ['.agents/code-style.md', true],
    ['.claude/commands/fix.md', true],
    ['README.md', false],
    ['src/agents.ts', false],
    ['docs/claude.md', false],
    ['src/agents/AGENT.md', false],
  ] as const)('%s: %s', (path, expected) => {
    expect(isRepositoryRuleFile(path)).toBe(expected);
  });
});

describe('the repository rules section', () => {
  const lens = lensByKey('correctness')!;

  it('tells every reviewer to read the rules at the base branch', () => {
    const prompt = buildLensPrompt(lens, ctx());
    expect(prompt).toContain('## Repository rules');
    expect(prompt).toContain("git fetch --depth 1 origin 'main'");
    expect(prompt).toContain('A broken rule is a finding even with no runtime failure');
  });

  it.each([
    ['a sweep', buildSweepPrompt(ctx(), [], ['correctness'])],
    ['a judge', buildJudgePrompt(ctx(), [])],
  ])('reaches %s too', (_label, prompt) => {
    expect(prompt).toContain('## Repository rules');
  });

  it('names the rule files the pull request changes and says not to follow them', () => {
    const prompt = buildLensPrompt(lens, ctx({ files: [file('AGENTS.md', 3), file('src/a.ts', 3)] }));
    expect(prompt).toContain('This pull request changes these rule files: AGENTS.md.');
  });

  it('counts a rule file with an unsafe path instead of naming it', () => {
    const prompt = buildLensPrompt(lens, ctx({ files: [file("x/$(rm -rf ~)/AGENTS.md", 3)] }));
    const rules = prompt.slice(prompt.indexOf('## Repository rules'));
    expect(rules).not.toContain('rm -rf');
    expect(rules).not.toContain('changes these rule files');
    expect(rules).toContain('It also changes 1 rule file(s)');
  });

  it.each([
    ['a pinned base commit', { rulesRef: 'abc123def' }, "git fetch --depth 1 origin 'abc123def'"],
    ['no pinned ref', {}, "git fetch --depth 1 origin 'main'"],
  ] as const)('reads the rules at %s', (_label, extra, expected) => {
    expect(buildLensPrompt(lens, ctx(extra))).toContain(expected);
  });

  it('has no fetch command for a rules ref a shell could misread', () => {
    const prompt = buildLensPrompt(lens, ctx({ rulesRef: "abc'; rm -rf ~; '" }));
    expect(prompt).not.toContain('git fetch');
  });

  it('has no fetch command for a base branch name a shell could misread', () => {
    const prompt = buildLensPrompt(lens, ctx({ baseBranch: "main'; rm -rf ~; '" }));
    expect(prompt).not.toContain('git fetch');
    expect(prompt).toContain('ignore its added lines');
  });

  it('finds rule files in the other parts too', () => {
    const prompt = buildLensPrompt(
      lens,
      ctx({ files: [file('src/a.ts', 3)], allFiles: [file('src/a.ts', 3), file('CLAUDE.md', 1)], chunkIndex: 1, chunkTotal: 2 })
    );
    expect(prompt).toContain('This pull request changes these rule files: CLAUDE.md.');
  });
});

describe('a part prompt', () => {
  it('names the files the other parts change', () => {
    const prompt = buildLensPrompt(
      lensByKey('security')!,
      ctx({ files: [file('src/a.ts', 3)], allFiles: [file('src/a.ts', 3), file('lib/b.ts', 9)], chunkIndex: 1, chunkTotal: 2 })
    );
    expect(prompt).toContain('You are reviewing part 1 of 2');
    expect(prompt).toContain('The other parts change:\n  lib/b.ts (+9 -0)');
  });
});

describe('the reporting bar', () => {
  it.each(REVIEW_LENSES.map((l) => [l.key]))('the %s lens is told to keep going and to report only what the change causes', (key) => {
    const prompt = buildLensPrompt(lensByKey(key)!, ctx());
    expect(prompt).toContain('Do not stop at the first problem you find.');
    expect(prompt).toContain('This change introduces it or makes it worse.');
    expect(prompt).toContain('Do not discount a problem because its trigger looks unusual.');
  });

  it('does not tell the judge to keep looking for problems', () => {
    expect(codeReviewOutputContract({ judge: true })).not.toContain('Do not stop at the first problem');
    expect(buildJudgePrompt(ctx(), [])).not.toContain('Do not stop at the first problem');
  });

  it('groups the candidates by file and line, so a duplicate sits beside its twin', () => {
    const c = (id: string, filePath: string, lines: string) => ({
      id, severity: 'minor', filePath, lines, title: id, body: 'b', raisedBy: [],
    });
    const prompt = buildJudgePrompt(ctx(), [c('z1', 'b.ts', '40'), c('a1', 'a.ts', '9'), c('z0', 'b.ts', '3'), c('q', 'a.ts', '?')]);
    const order = ['### q', '### a1', '### z0', '### z1'].map((h) => prompt.indexOf(h));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
  });

  it('tells the judge that rarity is not a reason to drop', () => {
    const prompt = buildJudgePrompt(ctx(), []);
    expect(prompt).toContain('TRY TO REFUTE IT from the code');
    expect(prompt).toContain('## These are NOT reasons to drop');
    expect(prompt).not.toContain('PRECISION OVER RECALL');
  });
});

describe('codeReviewLensReadsPart', () => {
  it.each([
    ['security', ['docs/guide.md', 'README.md'], false],
    ['security', ['docs/guide.md', 'src/a.ts'], true],
    ['security', ['config/app.yaml'], true],
    ['reliability', ['src/a.test.ts', 'tests/b.py'], false],
    ['reliability', ['migrations/0001.sql'], true],
    ['rules', ['tests/b.py'], true],
    ['rules', ['docs/guide.md'], false],
    ['correctness', ['docs/guide.md'], true],
    ['skill:repo:acme/api:house-rules', ['docs/guide.md'], true],
    ['security', [], false],
  ] as const)('%s on %j: %s', (lens, paths, expected) => {
    expect(codeReviewLensReadsPart(lens, paths.map((p) => ({ filename: p })))).toBe(expected);
  });
});
