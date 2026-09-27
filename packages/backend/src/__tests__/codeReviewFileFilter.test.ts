import { describe, it, expect } from 'vitest';
import { filesWorthReviewing, isGeneratedPath } from '@talyn/shared';

/**
 * What a review refuses to spend an agent on.
 *
 * Lock files, vendored trees, snapshots and generated output. The reason that
 * matters is not size: it is that they are NOISE-DENSE. A reviewer told to look
 * hard at a thousand near-identical generated lines will find something to say,
 * and then a judging pass costs money to throw it away again.
 */
describe('isGeneratedPath', () => {
  it.each([
    'package-lock.json',
    'apps/web/pnpm-lock.yaml',
    'Cargo.lock',
    'go.sum',
    'uv.lock',
    'node_modules/left-pad/index.js',
    'vendor/github.com/pkg/errors/errors.go',
    'src/__snapshots__/App.test.tsx.snap',
    'dist/bundle.js',
    'public/app.min.js',
    'api/service.pb.go',
    'src/__generated__/schema.ts',
  ])('skips %s', (path) => {
    expect(isGeneratedPath(path)).toBe(true);
  });

  it.each([
    'src/index.ts',
    'packages/backend/src/services/codeReview/executor.ts',
    // Near-misses that must NOT be skipped: the point is a path filter people
    // can predict, so anything that merely CONTAINS a keyword has to survive.
    'src/lockfile.ts',
    'src/distance.ts',
    'src/components/BuildBanner.tsx',
    'docs/vendoring.md',
    'src/generateReport.ts',
  ])('keeps %s', (path) => {
    expect(isGeneratedPath(path)).toBe(false);
  });
});

describe('filesWorthReviewing', () => {
  it('drops the generated ones', () => {
    const out = filesWorthReviewing([
      { filename: 'src/a.ts' },
      { filename: 'package-lock.json' },
      { filename: 'src/b.ts' },
    ]);
    expect(out.map((f) => f.filename)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('keeps everything when the filter would leave nothing', () => {
    // A lock-file-only pull request is still one somebody asked to review, and
    // answering "no files" would settle the cycle as a failure rather than as a
    // review of what is actually there.
    const only = [{ filename: 'package-lock.json' }, { filename: 'yarn.lock' }];
    expect(filesWorthReviewing(only).map((f) => f.filename)).toEqual([
      'package-lock.json',
      'yarn.lock',
    ]);
  });

  it('returns a copy, never the caller’s array', () => {
    const input = [{ filename: 'package-lock.json' }];
    expect(filesWorthReviewing(input)).not.toBe(input);
  });
});
