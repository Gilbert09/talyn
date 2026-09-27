import { describe, it, expect } from 'vitest';
import {
  classifyReviewFile,
  codeReviewUnitCount,
  selectLensesForFiles,
} from '@talyn/shared';

/**
 * Which reviewers a change actually needs.
 *
 * The rule is asymmetric on purpose and that asymmetry is the whole safety
 * argument: a lens is skipped only on POSITIVE EVIDENCE that it has nothing to
 * look at, never because the classifier is unsure. Running a reviewer that
 * finds nothing costs money — the status quo. Skipping one that would have
 * found something costs a bug, and looks exactly like a clean review. Those are
 * not comparable mistakes, so every uncertain case takes the expensive branch.
 *
 * These tests are mostly about what must NOT be skipped.
 */

const ALL = ['correctness', 'security', 'reliability', 'tests', 'operability'];

describe('classifyReviewFile', () => {
  it.each([
    ['packages/backend/src/db/migrations/0068_code_review.sql', 'migration'],
    ['db/migrations/0001_init.ts', 'migration'],
    ['src/__tests__/foo.test.ts', 'test'],
    ['src/foo.spec.tsx', 'test'],
    ['internal/server_test.go', 'test'],
    ['tests/conftest.py', 'test'],
    ['README.md', 'docs'],
    ['docs/ARCHITECTURE.md', 'docs'],
    ['package.json', 'config'],
    ['railway.toml', 'config'],
    ['Dockerfile', 'config'],
    ['.eslintrc', 'config'],
    ['src/App.css', 'asset'],
    ['public/logo.svg', 'asset'],
    ['src/services/github.ts', 'code'],
  ])('classifies %s as %s', (path, expected) => {
    expect(classifyReviewFile(path)).toBe(expected);
  });

  it('prefers migration over config for a SQL file in a config-ish tree', () => {
    // Order matters: these overlap, and the first match wins. A migration read
    // as config would lose the reliability lens, which is the one that cares
    // most about what a migration does under load.
    expect(classifyReviewFile('supabase/migrations/0001.sql')).toBe('migration');
  });

  it('prefers test over code for a test file under src', () => {
    expect(classifyReviewFile('src/components/Button.test.tsx')).toBe('test');
  });
});

describe('selectLensesForFiles', () => {
  it('runs everything for an ordinary code change', () => {
    const out = selectLensesForFiles(ALL, [{ filename: 'src/services/github.ts' }]);
    expect(out.selected).toEqual(ALL);
    expect(out.skipped).toEqual([]);
  });

  it('NEVER skips correctness', () => {
    // Any change to anything can be wrong. This is the one reviewer whose
    // absence is a hole rather than a saving.
    for (const files of [
      [{ filename: 'README.md' }],
      [{ filename: 'src/App.css' }],
      [{ filename: 'docs/guide.md' }, { filename: 'public/logo.svg' }],
    ]) {
      expect(selectLensesForFiles(ALL, files).selected).toContain('correctness');
    }
  });

  it('always runs at least one reviewer, even for documentation alone', () => {
    // "We reviewed nothing" is not an outcome this product should be able to
    // produce quietly.
    const out = selectLensesForFiles(ALL, [{ filename: 'README.md' }]);
    expect(out.selected.length).toBeGreaterThanOrEqual(1);
  });

  it('drops the runtime reviewers for a documentation-only change', () => {
    const out = selectLensesForFiles(ALL, [{ filename: 'docs/a.md' }, { filename: 'b.md' }]);
    expect(out.selected).toEqual(['correctness']);
    expect(out.skipped.map((s) => s.lens).sort()).toEqual([
      'operability',
      'reliability',
      'security',
      'tests',
    ]);
  });

  it('keeps security for a configuration change, which is where secrets live', () => {
    const out = selectLensesForFiles(ALL, [{ filename: '.env.example' }]);
    expect(out.selected).toContain('security');
    expect(out.selected).toContain('operability');
    // No code and no migration, so load behaviour has nothing to read.
    expect(out.skipped.map((s) => s.lens)).toContain('reliability');
  });

  it('keeps every runtime reviewer for a migration', () => {
    const out = selectLensesForFiles(ALL, [{ filename: 'db/migrations/0002.sql' }]);
    expect(out.selected).toEqual(ALL);
  });

  it('keeps the tests reviewer when only tests changed', () => {
    // A test-only diff is exactly when "would this catch it breaking" matters.
    const out = selectLensesForFiles(ALL, [{ filename: 'src/a.test.ts' }]);
    expect(out.selected).toContain('tests');
  });

  it('runs a lens nobody has classified rather than guessing', () => {
    const out = selectLensesForFiles(['correctness', 'brand_new_lens'], [
      { filename: 'README.md' },
    ]);
    expect(out.selected).toContain('brand_new_lens');
  });

  it('gives every skip a reason a person can check', () => {
    const out = selectLensesForFiles(ALL, [{ filename: 'README.md' }]);
    for (const skip of out.skipped) {
      expect(skip.reason).toMatch(/nothing in this change is /);
      expect(skip.reason.length).toBeGreaterThan(20);
    }
  });

  it('one file of the right kind is enough to keep a reviewer', () => {
    // ANY, not ALL: a pull request that is mostly documentation but touches one
    // source file still gets read properly.
    const out = selectLensesForFiles(ALL, [
      { filename: 'README.md' },
      { filename: 'docs/b.md' },
      { filename: 'src/auth.ts' },
    ]);
    expect(out.selected).toEqual(ALL);
  });
});

describe('codeReviewUnitCount with a known lens count', () => {
  it('counts the lenses that will ACTUALLY run', () => {
    // The progress denominator. A bar that promises five steps and delivers
    // four is worse than one that never promised.
    expect(codeReviewUnitCount('standard', 1, 1)).toBe(
      codeReviewUnitCount('standard', 1, 3) - 2
    );
  });

  it('falls back to the preset when the caller does not know yet', () => {
    expect(codeReviewUnitCount('standard', 1)).toBe(codeReviewUnitCount('standard', 1, 3));
  });
});
