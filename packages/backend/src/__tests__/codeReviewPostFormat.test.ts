/**
 * The text and the line arithmetic behind "Post to PR".
 *
 * GitHub refuses a WHOLE review when one inline comment points at a line that
 * is not in the diff, so the functions that decide "is this line in the diff"
 * are pinned here case by case.
 */
import { describe, expect, it } from 'vitest';
import {
  buildReviewBody,
  commentableRightLines,
  GITHUB_BODY_LIMIT,
  inlineCommentBody,
  placeFinding,
  sortFindingsForPost,
  summaryEntry,
  type LineRange,
  type PostableFinding,
} from '../services/codeReview/postFormat.js';

function finding(over: Partial<PostableFinding> = {}): PostableFinding {
  return {
    id: 'f-1',
    severity: 'major',
    filePath: 'src/a.ts',
    lineStart: 10,
    lineEnd: 10,
    anchorVerified: true,
    title: 'A title',
    body: 'Why it matters.',
    suggestion: null,
    ...over,
  };
}

describe('commentableRightLines', () => {
  it.each<[string, string | null | undefined, LineRange[]]>([
    ['no patch at all (binary, or too large)', undefined, []],
    ['a null patch', null, []],
    ['an empty patch', '', []],
    [
      'one hunk with context, an addition and a deletion',
      ['@@ -10,4 +10,4 @@ function a() {', ' ctx', '-old', '+new', ' ctx', ' ctx'].join('\n'),
      [{ start: 10, end: 13 }],
    ],
    [
      'two hunks, one range each',
      [
        '@@ -1,3 +1,4 @@',
        ' a',
        '+b',
        ' c',
        ' d',
        '@@ -40,2 +41,3 @@ class X {',
        ' e',
        '+f',
        ' g',
      ].join('\n'),
      [
        { start: 1, end: 4 },
        { start: 41, end: 43 },
      ],
    ],
    ['deletions only', ['@@ -5,2 +4,0 @@', '-gone', '-also gone'].join('\n'), []],
    [
      'a deletions-only hunk beside an ordinary one',
      ['@@ -5,2 +4,0 @@', '-gone', '-also gone', '@@ -20,1 +18,2 @@', ' keep', '+add'].join('\n'),
      [{ start: 18, end: 19 }],
    ],
    [
      'a new file',
      ['@@ -0,0 +1,3 @@', '+one', '+two', '+three'].join('\n'),
      [{ start: 1, end: 3 }],
    ],
    [
      'a new file of one line, where the header drops the count',
      ['@@ -0,0 +1 @@', '+only'].join('\n'),
      [{ start: 1, end: 1 }],
    ],
    [
      'the no-newline marker, which is not a line of the file',
      ['@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+c', '\\ No newline at end of file'].join('\n'),
      [{ start: 1, end: 2 }],
    ],
    [
      'an added line whose text starts with @@',
      ['@@ -1,1 +1,2 @@', ' a', '+@@ not a header'].join('\n'),
      [{ start: 1, end: 2 }],
    ],
    ['text with no hunk header', ['+stray', ' line'].join('\n'), []],
  ])('%s', (_label, patch, expected) => {
    expect(commentableRightLines(patch)).toEqual(expected);
  });
});

describe('placeFinding', () => {
  const ranges = new Map<string, LineRange[]>([
    [
      'src/a.ts',
      [
        { start: 10, end: 20 },
        { start: 40, end: 45 },
      ],
    ],
    ['src/deleted-only.ts', []],
  ]);

  it.each<[string, Partial<PostableFinding>, ReturnType<typeof placeFinding>]>([
    ['one line in a hunk', { lineStart: 12, lineEnd: 12 }, { kind: 'inline', path: 'src/a.ts', line: 12 }],
    ['no end line', { lineStart: 12, lineEnd: null }, { kind: 'inline', path: 'src/a.ts', line: 12 }],
    [
      'a range inside one hunk',
      { lineStart: 12, lineEnd: 15 },
      { kind: 'inline', path: 'src/a.ts', line: 15, startLine: 12 },
    ],
    [
      'a range that is the whole hunk',
      { lineStart: 10, lineEnd: 20 },
      { kind: 'inline', path: 'src/a.ts', line: 20, startLine: 10 },
    ],
    [
      'a reversed range',
      { lineStart: 15, lineEnd: 12 },
      { kind: 'inline', path: 'src/a.ts', line: 15, startLine: 12 },
    ],
    [
      'a range across two hunks falls back to its last line',
      { lineStart: 18, lineEnd: 41 },
      { kind: 'inline', path: 'src/a.ts', line: 41 },
    ],
    [
      'a range that starts before the hunk falls back to its last line',
      { lineStart: 5, lineEnd: 11 },
      { kind: 'inline', path: 'src/a.ts', line: 11 },
    ],
    ['a range whose last line is outside the diff', { lineStart: 18, lineEnd: 30 }, { kind: 'summary' }],
    ['one line between two hunks', { lineStart: 30, lineEnd: 30 }, { kind: 'summary' }],
    ['one line past the last hunk', { lineStart: 46, lineEnd: 46 }, { kind: 'summary' }],
    ['an unverified anchor', { anchorVerified: false, lineStart: 12 }, { kind: 'summary' }],
    ['no file', { filePath: '' }, { kind: 'summary' }],
    ['no line', { lineStart: null, lineEnd: null }, { kind: 'summary' }],
    ['line zero', { lineStart: 0, lineEnd: 0 }, { kind: 'summary' }],
    ['a file that is not in the diff', { filePath: 'src/other.ts' }, { kind: 'summary' }],
    ['a file with nothing commentable', { filePath: 'src/deleted-only.ts' }, { kind: 'summary' }],
  ])('%s', (_label, over, expected) => {
    expect(placeFinding(finding(over), ranges)).toEqual(expected);
  });
});

describe('inlineCommentBody', () => {
  it.each<[string, Partial<PostableFinding>, string]>([
    ['title and body', {}, '**Should fix: A title**\n\nWhy it matters.'],
    [
      'with a suggestion, which stays plain text',
      { severity: 'blocker', suggestion: 'Use `x` here.' },
      '**Must fix: A title**\n\nWhy it matters.\n\n**Suggested fix**\n\nUse `x` here.',
    ],
    ['an empty body', { severity: 'nit', body: '' }, '**Nitpick: A title**'],
    [
      'an empty body with a suggestion',
      { severity: 'minor', body: '  ', suggestion: 'Do this.' },
      '**Consider: A title**\n\n**Suggested fix**\n\nDo this.',
    ],
    ['a blank suggestion is no suggestion', { suggestion: '  \n' }, '**Should fix: A title**\n\nWhy it matters.'],
    ['an unknown severity is shown as it is', { severity: 'odd' }, '**odd: A title**\n\nWhy it matters.'],
  ])('%s', (_label, over, expected) => {
    expect(inlineCommentBody(finding(over))).toBe(expected);
  });

  it('never writes a GitHub suggestion fence', () => {
    // An applied suggestion replaces the commented lines with the text exactly
    // as written, and the agent's text is not guaranteed to be a replacement.
    const body = inlineCommentBody(finding({ suggestion: 'return a + b;' }));
    expect(body).not.toContain('```suggestion');
    expect(body).not.toContain('```');
  });

  it('leaves a suggestion that is already fenced as it is', () => {
    const fenced = '```ts\nreturn a + b;\n```';
    expect(inlineCommentBody(finding({ suggestion: fenced }))).toContain(fenced);
  });
});

describe('summaryEntry', () => {
  it.each<[string, Partial<PostableFinding>, string]>([
    ['one line', {}, '**Should fix: A title** (`src/a.ts:10`)\n\nWhy it matters.'],
    ['a range', { lineEnd: 14 }, '**Should fix: A title** (`src/a.ts:10-14`)\n\nWhy it matters.'],
    ['a file with no line', { lineStart: null, lineEnd: null }, '**Should fix: A title** (`src/a.ts`)\n\nWhy it matters.'],
    ['no file at all', { filePath: '', lineStart: null }, '**Should fix: A title**\n\nWhy it matters.'],
    [
      'with a suggestion',
      { suggestion: 'Do this.' },
      '**Should fix: A title** (`src/a.ts:10`)\n\nWhy it matters.\n\n**Suggested fix**\n\nDo this.',
    ],
  ])('%s', (_label, over, expected) => {
    expect(summaryEntry(finding(over))).toBe(expected);
  });
});

describe('sortFindingsForPost', () => {
  it('orders by severity, then file, then line', () => {
    const input = [
      finding({ id: 'nit', severity: 'nit', filePath: 'a.ts', lineStart: 1 }),
      finding({ id: 'major-b', severity: 'major', filePath: 'b.ts', lineStart: 1 }),
      finding({ id: 'major-a-9', severity: 'major', filePath: 'a.ts', lineStart: 9 }),
      finding({ id: 'major-a-none', severity: 'major', filePath: 'a.ts', lineStart: null }),
      finding({ id: 'major-a-2', severity: 'major', filePath: 'a.ts', lineStart: 2 }),
      finding({ id: 'blocker', severity: 'blocker', filePath: 'z.ts', lineStart: 50 }),
      finding({ id: 'minor', severity: 'minor', filePath: 'a.ts', lineStart: 1 }),
    ];
    expect(sortFindingsForPost(input).map((f) => f.id)).toEqual([
      'blocker',
      'major-a-2',
      'major-a-9',
      'major-a-none',
      'major-b',
      'minor',
      'nit',
    ]);
    // The input is not reordered in place.
    expect(input[0]!.id).toBe('nit');
  });
});

describe('buildReviewBody', () => {
  it.each<[string, number, number, string]>([
    ['inline only, one', 1, 0, '1 finding, as inline comment.'],
    ['inline only, many', 3, 0, '3 findings, as inline comments.'],
    ['summary only', 0, 2, '2 findings.'],
    ['both', 2, 1, '3 findings: 2 as inline comments, 1 below.'],
    ['both, one inline', 1, 2, '3 findings: 1 as inline comment, 2 below.'],
  ])('writes the count line for %s', (_label, inlineCount, summaryCount, line) => {
    const summaryFindings = Array.from({ length: summaryCount }, (_, i) =>
      finding({ id: `s-${i}`, lineStart: i + 1, lineEnd: i + 1 })
    );
    const out = buildReviewBody({ shaShort: 'abc1234', inlineCount, summaryFindings });
    const lines = out.body.split('\n\n');
    expect(lines[0]).toBe('Findings from a Talyn code review of abc1234.');
    expect(lines[1]).toBe(line);
    expect(out.included).toHaveLength(summaryCount);
    expect(out.leftOut).toHaveLength(0);
    expect(out.body.includes('### Findings without an inline comment')).toBe(summaryCount > 0);
  });

  it('lists the summary findings most serious first', () => {
    const out = buildReviewBody({
      shaShort: 'abc1234',
      inlineCount: 0,
      summaryFindings: [
        finding({ id: 'nit', severity: 'nit', title: 'Small' }),
        finding({ id: 'blocker', severity: 'blocker', title: 'Big' }),
      ],
    });
    expect(out.included.map((f) => f.id)).toEqual(['blocker', 'nit']);
    expect(out.body.indexOf('Must fix: Big')).toBeLessThan(out.body.indexOf('Nitpick: Small'));
  });

  it('fits exactly at the limit', () => {
    const one = buildReviewBody({ shaShort: 'abc1234', inlineCount: 0, summaryFindings: [finding()] });
    const exact = buildReviewBody({
      shaShort: 'abc1234',
      inlineCount: 0,
      summaryFindings: [finding()],
      limit: one.body.length,
    });
    expect(exact.included).toHaveLength(1);
    expect(exact.leftOut).toHaveLength(0);
  });

  it('leaves whole findings out at GitHub\'s limit and says how many', () => {
    // Three findings of ~30k characters. Two fit in 65536, three do not.
    const big = (id: string, severity: string) =>
      finding({ id, severity, title: id, body: 'x'.repeat(30_000) });
    const out = buildReviewBody({
      shaShort: 'abc1234',
      inlineCount: 1,
      summaryFindings: [big('c', 'minor'), big('a', 'blocker'), big('b', 'major')],
    });
    expect(out.body.length).toBeLessThanOrEqual(GITHUB_BODY_LIMIT);
    expect(out.included.map((f) => f.id)).toEqual(['a', 'b']);
    expect(out.leftOut.map((f) => f.id)).toEqual(['c']);
    // The count is what is actually on the pull request: 1 inline and 2 here.
    expect(out.body).toContain('3 findings: 1 as inline comment, 2 below.');
    expect(out.body.endsWith('1 finding did not fit in this comment and is not shown here. You can read it in Talyn.')).toBe(true);
    // No finding is cut: each body that is present is present in full.
    expect(out.body.match(/x{30000}/g)).toHaveLength(2);
    expect(out.body).not.toContain('Consider: c');
  });

  it.each([
    [1, '1 finding did not fit in this comment and is not shown here. You can read it in Talyn.'],
    [2, '2 findings did not fit in this comment and are not shown here. You can read them in Talyn.'],
  ])('leaves out all %i when none fits', (count, trailer) => {
    const out = buildReviewBody({
      shaShort: 'abc1234',
      inlineCount: 0,
      summaryFindings: Array.from({ length: count }, (_, i) =>
        finding({ id: `f-${i}`, lineStart: i + 1, body: 'y'.repeat(70_000) })
      ),
    });
    expect(out.included).toHaveLength(0);
    expect(out.leftOut).toHaveLength(count);
    expect(out.body.endsWith(trailer)).toBe(true);
    expect(out.body.length).toBeLessThanOrEqual(GITHUB_BODY_LIMIT);
  });
});
