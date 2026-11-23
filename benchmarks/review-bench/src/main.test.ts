import { describe, expect, it, vi } from 'vitest';
import { CODE_REVIEW_FINDINGS_SENTINEL, parseCodeReviewFindings, type RawCodeReviewFinding } from '@talyn/shared';
import { anchorVerifier, keyFor } from '../../../packages/backend/src/services/codeReview/unitPure.js';
import type { ReviewPromptContext } from '../../../packages/backend/src/services/codeReview/lenses.js';
import {
  applyJudge, assertUnitEnvironment, mapFinding, mergeFindings, parseDiff, readSettings, review, UnitEnvironmentError, validateOutput,
  type AgentUnit, type Candidate, type ContractOutput,
} from './main.js';

const finding = (overrides: Partial<RawCodeReviewFinding> = {}): RawCodeReviewFinding => ({
  severity: 'major', category: 'correctness', file: 'src/a.ts', lineStart: 2, lineEnd: 3,
  anchor: 'return value;', title: 'An empty value causes a crash', body: 'An empty value reaches the caller and causes a crash.',
  suggestion: null, confidence: 90, ...overrides,
});
const message = (findings: RawCodeReviewFinding[] = [], dropped: { id: string; reason: string }[] = []) =>
  `${CODE_REVIEW_FINDINGS_SENTINEL}\n\`\`\`json\n${JSON.stringify({ schema: 1, findings, dropped })}\n\`\`\``;
const candidate = (overrides: Partial<RawCodeReviewFinding> = {}): Candidate => {
  const raw = finding(overrides);
  return { ...raw, dedupeKey: keyFor(raw, false), seenCount: 1, lenses: ['correctness'] };
};
const context = (count = 1): ReviewPromptContext => ({
  ref: 'owner/repo#42', title: 'Test change', body: '', headBranch: 'pr-42', baseBranch: 'base',
  chunkIndex: 1, chunkTotal: 1,
  files: Array.from({ length: count }, (_, index) => ({
    filename: index ? `src/file-${index}.ts` : 'src/a.ts', status: 'modified', additions: 1, deletions: 0,
    patch: '@@ -1 +1,2 @@\n context\n+return value;',
  })),
});

describe('parseDiff', () => {
  it.each([
    ['added', 'new file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new', 'new.ts', 1, 0],
    ['removed', 'deleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old', 'old.ts', 0, 1],
    ['renamed', 'similarity index 100%\nrename from old.ts\nrename to new.ts', 'new.ts', 0, 0],
    ['renamed', 'similarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-old\n+new', 'new.ts', 1, 1],
    ['modified', 'index 123..456 100644\nBinary files a/old.ts and b/new.ts differ', 'new.ts', 0, 0],
    ['modified', 'old mode 100644\nnew mode 100755', 'new.ts', 0, 0],
  ])('parses %s: %s', (status, body, filename, additions, deletions) => {
    const [file] = parseDiff(`diff --git a/old.ts b/new.ts\n${body}\n`);
    expect(file).toMatchObject({ filename, status, additions, deletions });
    expect(file?.patch).toBe(body.includes('@@') ? body.slice(body.indexOf('@@')) : undefined);
  });

  it('keeps multiple hunks and excludes file headers from counts', () => {
    const patch = '@@ -1,2 +1,2 @@\n context\n-old\n+new\n@@ -10 +10,2 @@\n unchanged\n+++code\n\\ No newline at end of file';
    expect(parseDiff(`diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n${patch}`)).toEqual([
      { filename: 'a.ts', status: 'modified', additions: 2, deletions: 1, patch },
    ]);
  });

  it('keeps files separate and resets binary patch state', () => {
    const diff = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n'
      + 'diff --git a/pic.png b/pic.png\nnew file mode 100644\nBinary files /dev/null and b/pic.png differ\n';
    expect(parseDiff(diff)).toEqual([
      { filename: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' },
      { filename: 'pic.png', status: 'added', additions: 0, deletions: 0 },
    ]);
  });

  it.each([
    ['a file.ts', 'a file.ts'],
    ['"a\\tfile.ts"', 'a\tfile.ts'],
    ['"caf\\303\\251.ts"', 'café.ts'],
  ])('decodes Git paths: %s', (path, expected) => {
    expect(parseDiff(`diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to ${path}\n`)[0]?.filename).toBe(expected);
  });

  it('reads quoted file headers', () => {
    expect(parseDiff('diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n'
      + '--- "a/caf\\303\\251.ts"\n+++ "b/caf\\303\\251.ts"\n@@ -1 +1 @@\n-a\n+b')[0]?.filename).toBe('café.ts');
  });

  it('accepts an empty diff and rejects invalid nonempty input', () => {
    expect(parseDiff('')).toEqual([]);
    expect(() => parseDiff('not a diff')).toThrow();
    expect(() => parseDiff('diff --git malformed')).toThrow();
  });
});

describe('mapFinding', () => {
  it.each(['./src/a.ts', '/src/a.ts', '/./src/a.ts', 'src\\a.ts'])('normalizes %s', (file) => {
    expect(mapFinding(finding({ file }), 'talyn-review')?.file).toBe('src/a.ts');
  });
  it.each(['', '../secret', 'src/../../secret', 'C:\\secret', 'src/./a.ts', 'src\0/a.ts'])('rejects %s', (file) => {
    expect(mapFinding(finding({ file }), 'agent')).toBeNull();
  });
  it.each([
    [42, 45, 42, 45], [42, null, 42, 42], [42, 12, 42, 42],
    [null, null, 1, 1], [0, -1, 1, 1], [-3, 4, 1, 4],
  ])('maps lines %s to %s', (lineStart, lineEnd, start, end) => {
    expect(mapFinding(finding({ lineStart, lineEnd }), 'agent')).toMatchObject({ start_line: start, end_line: end });
  });
  it('finds a multiline anchor with changed whitespace', () => {
    const mapped = mapFinding(finding({ lineStart: null, lineEnd: null, anchor: 'call(x); return value;' }),
      'agent', '// heading\n  call(x);\n  return value;\n');
    expect(mapped).toMatchObject({ start_line: 2, end_line: 3 });
  });
  it('retains explicit lines, severity, body, and suggested fixes', () => {
    const mapped = mapFinding(finding({ suggestion: 'Return a default value.' }), 'agent', 'return value;');
    expect(mapped).toMatchObject({ start_line: 2, end_line: 3, producer: 'agent' });
    expect(mapped?.message).toBe('[major] An empty value causes a crash — An empty value reaches the caller and causes a crash.\nSuggested fix: Return a default value.');
    expect(mapFinding(finding({ body: 'x'.repeat(20_000) }), 'agent')?.message.length).toBe(12_000);
  });
});

describe('deduplication and judge application', () => {
  it('merges counts and lenses, retains severity, and updates the stored body and lines', () => {
    const stored = new Map<string, Candidate>();
    mergeFindings(stored, [finding()], 'correctness', () => false);
    mergeFindings(stored, [finding({ severity: 'minor', body: 'Updated explanation.', lineStart: 7 })], 'security', () => false);
    mergeFindings(stored, [finding({ severity: 'blocker' })], 'security', () => false);
    expect([...stored.values()]).toMatchObject([{ seenCount: 3, lenses: ['correctness', 'security'], severity: 'blocker' }]);
    expect(stored.size).toBe(1);
    const latest = new Map<string, Candidate>();
    mergeFindings(latest, [finding(), finding({ body: 'Updated explanation.', lineStart: 7 })], 'correctness', () => false);
    expect([...latest.values()][0]).toMatchObject({ body: 'Updated explanation.', lineStart: 7, seenCount: 2 });
  });

  it('uses the production anchor verifier for dedupe keys', () => {
    const verified = anchorVerifier(context().files);
    expect(verified(finding())).toBe(true);
    expect(verified(finding({ anchor: 'deleted line' }))).toBe(false);
    const stored = new Map<string, Candidate>();
    mergeFindings(stored, [finding()], 'correctness', verified);
    expect([...stored.keys()]).toEqual([keyFor(finding(), true)]);
  });

  it('matches a keep by ID and applies corrected severity and body', () => {
    const original = candidate();
    const other = candidate({ title: 'Other issue' });
    const judged = parseCodeReviewFindings(message([finding({
      id: original.dedupeKey, title: 'Reworded title', severity: 'minor', body: 'Corrected consequence.',
    })]));
    expect(applyJudge([original, other], judged, () => false)).toEqual([
      { ...original, severity: 'minor', body: 'Corrected consequence.' },
    ]);
  });

  it('matches legacy keeps with the opposite anchor verification result', () => {
    const original = candidate();
    expect(applyJudge([original], parseCodeReviewFindings(message([finding()])), () => true)).toHaveLength(1);
  });

  it('applies only named drops when a keep cannot be matched', () => {
    const original = candidate();
    const other = candidate({ title: 'Other issue' });
    const judged = parseCodeReviewFindings(message([finding({ title: 'Unknown issue', id: 'unknown' })],
      [{ id: other.dedupeKey, reason: 'The caller checks this value.' }]));
    expect(applyJudge([original, other], judged, () => false, vi.fn())).toEqual([original]);
  });

  it('gives matched keeps priority over named drops', () => {
    const original = candidate();
    const judged = parseCodeReviewFindings(message([finding({ id: original.dedupeKey })],
      [{ id: original.dedupeKey, reason: 'Conflicting output.' }]));
    expect(applyJudge([original], judged, () => false)).toHaveLength(1);
  });

  it('drops all candidates for a valid empty judge response', () => {
    expect(applyJudge([candidate()], parseCodeReviewFindings(message()), () => false)).toEqual([]);
  });

  it('keeps all candidates when the judge fails', () => {
    const candidates = [candidate()];
    const log = vi.fn();
    expect(applyJudge(candidates, { ok: false, error: 'Timed out.' }, () => false, log)).toBe(candidates);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unjudged'));
  });
});

describe('orchestration with a fake runner', () => {
  it.each(['lens', 'sweep', 'judge'])('fails the PR when the %s cannot inspect the checkout', async (kind) => {
    await expect(review(context(), readSettings({}), async (unit) => {
      if (unit.kind === kind) throw new UnitEnvironmentError('Shell environment failed.');
      return message([finding()]);
    }, vi.fn())).rejects.toThrow('Shell environment failed');
  });

  it.each([
    [[1, 127], true], [[1, 0], false], [[0], false], [[], false],
  ])('checks command exit codes %j', (codes, failed) => {
    const events = codes.map((exit_code) => JSON.stringify({
      type: 'item.completed', item: { type: 'command_execution', exit_code, aggregated_output: '' },
    })).join('\n');
    const check = () => assertUnitEnvironment(events, '');
    if (failed) expect(check).toThrow('Every shell command failed');
    else expect(check).not.toThrow();
  });

  it.each([
    ['quick', 1, 1, 0, 0], ['standard', 1, 3, 1, 1],
    ['deep', 25, 5, 1, 1], ['deep', 26, 10, 2, 1], ['deep', 51, 15, 3, 1],
  ] as const)('runs %s with %s files in production order', async (preset, fileCount, lenses, sweeps, judges) => {
    const settings = { ...readSettings({ RB_CONFIG_PRESET: preset }), concurrency: 2, judgeModel: 'judge-model' };
    const calls: AgentUnit[] = [];
    let active = 0;
    let peak = 0;
    let finishedLenses = 0;
    let finishedSweeps = 0;
    await review(context(fileCount), settings, async (unit) => {
      calls.push(unit);
      active++;
      peak = Math.max(peak, active);
      if (unit.kind !== 'lens') expect(finishedLenses).toBe(lenses);
      if (unit.kind === 'judge') expect(finishedSweeps).toBe(sweeps);
      await Promise.resolve();
      active--;
      if (unit.kind === 'lens') finishedLenses++;
      if (unit.kind === 'sweep') finishedSweeps++;
      return message(unit.kind === 'lens' ? [finding()] : []);
    });
    expect(calls.filter((unit) => unit.kind === 'lens')).toHaveLength(lenses);
    expect(calls.filter((unit) => unit.kind === 'sweep')).toHaveLength(sweeps);
    expect(calls.filter((unit) => unit.kind === 'judge')).toHaveLength(judges);
    expect(peak).toBe(Math.min(2, lenses));
    if (judges) {
      const judge = calls.at(-1)!;
      expect(judge.model).toBe('judge-model');
      expect(judge.prompt).toContain(keyFor(finding(), true));
      expect(judge.prompt).toContain('2-3');
    }
    if (fileCount > 25) {
      expect(calls[0]?.prompt).toContain(`part 1 of ${Math.ceil(fileCount / 25)}`);
      expect(calls[0]?.prompt).not.toContain('src/file-1.ts');
      expect(calls[5]?.prompt).toContain('src/file-1.ts');
    }
  });

  it('passes deduped coverage to the sweep and all candidates to the judge', async () => {
    const sweepFinding = finding({ file: 'src/sweep.ts', title: 'Sweep issue' });
    const calls: AgentUnit[] = [];
    await review(context(), readSettings({}), async (unit) => {
      calls.push(unit);
      return message(unit.kind === 'lens' ? [finding()] : unit.kind === 'sweep' ? [sweepFinding] : []);
    });
    const sweep = calls.find((unit) => unit.kind === 'sweep')!;
    expect(sweep.prompt.match(/An empty value causes a crash/g)).toHaveLength(1);
    const judge = calls.at(-1)!;
    expect(judge.prompt).toContain(keyFor(finding(), true));
    expect(judge.prompt).toContain(keyFor(sweepFinding, false));
    for (const lens of ['correctness', 'security', 'reliability', 'sweep']) expect(judge.prompt).toContain(lens);
  });

  it.each(['throws', 'unparseable'])('fails when every lens %s', async (failure) => {
    const runner = vi.fn(async () => {
      if (failure === 'throws') throw new Error('Process failed.');
      return 'Invalid output';
    });
    await expect(review(context(), readSettings({}), runner, vi.fn())).rejects.toThrow('Every lens unit failed');
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('continues after a partial lens failure and skips the judge for empty findings', async () => {
    const calls: AgentUnit[] = [];
    expect(await review(context(), readSettings({}), async (unit) => {
      calls.push(unit);
      return unit.lens === 'security' ? 'Invalid output' : message();
    }, vi.fn())).toEqual([]);
    expect(calls.map((unit) => unit.kind)).toEqual(['lens', 'lens', 'lens', 'sweep']);
  });

  it.each(['throws', 'unparseable'])('keeps candidates when the sweep and judge %s', async (failure) => {
    const results = await review(context(), readSettings({}), async (unit) => {
      if (unit.kind === 'lens') return message([finding()]);
      if (failure === 'throws') throw new Error('Timed out.');
      return 'Invalid output';
    }, vi.fn());
    expect(results).toMatchObject([{ seenCount: 3, lenses: ['correctness', 'security', 'reliability'] }]);
  });
});

describe('settings and output validation', () => {
  it('uses the defaults and accepts optional settings', () => {
    expect(readSettings({})).toEqual({ preset: 'standard', model: 'gpt-6.1-terra', judgeModel: 'gpt-6.1-terra',
      effort: undefined, concurrency: 5, unitTimeoutSec: 900 });
    expect(readSettings({ RB_CONFIG_MODEL: 'custom', RB_CONFIG_EFFORT: 'high' })).toMatchObject({
      model: 'custom', judgeModel: 'custom', effort: 'high',
    });
  });
  it.each([
    { RB_CONFIG_PRESET: 'wrong' }, { RB_CONFIG_CONCURRENCY: '0' }, { RB_CONFIG_CONCURRENCY: '1.5' },
    { RB_CONFIG_UNIT_TIMEOUT_SEC: '-1' }, { RB_CONFIG_UNIT_TIMEOUT_SEC: 'NaN' },
  ])('rejects invalid settings: %s', (env) => { expect(() => readSettings(env)).toThrow(); });

  const identity = { repo: 'https://github.com/owner/repo', pr_number: 42, base: 'a'.repeat(40), head: 'b'.repeat(40) };
  const output = (): ContractOutput => ({ pr: { ...identity }, agent: 'agent', findings: [mapFinding(finding(), 'agent')!] });
  it('accepts valid findings and empty reviews', () => {
    expect(() => validateOutput(output(), identity, 'agent')).not.toThrow();
    expect(() => validateOutput({ ...output(), findings: [] }, identity, 'agent')).not.toThrow();
  });
  it.each(['head', 'number', 'agent', 'line', 'path', 'cap'])('rejects an invalid %s', (field) => {
    const invalid = output();
    if (field === 'head') invalid.pr.head = 'c'.repeat(40);
    if (field === 'number') invalid.pr.pr_number++;
    if (field === 'agent') invalid.agent = 'wrong';
    if (field === 'line') invalid.findings[0]!.start_line = 0;
    if (field === 'path') invalid.findings[0]!.file = '../secret';
    if (field === 'cap') invalid.findings = Array.from({ length: 51 }, () => mapFinding(finding(), 'agent')!);
    expect(() => validateOutput(invalid, identity, 'agent')).toThrow();
  });
});
