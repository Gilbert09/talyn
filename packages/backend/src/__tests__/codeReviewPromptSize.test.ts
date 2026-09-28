import { describe, it, expect } from 'vitest';
import { buildLensPrompt, REVIEW_LENSES } from '../services/codeReview/lenses.js';

/**
 * A prompt has to be small enough to SPAWN.
 *
 * Linux caps a single argv entry at MAX_ARG_STRLEN — 32 pages, 131072 bytes —
 * and the prompt is one argument. Exceed it and the sandbox cannot start the
 * agent at all: the spawn fails with E2BIG, every unit settles in eight seconds
 * having produced nothing and costing nothing, and the review reports "no
 * reviewer finished" with advice to try again that fails identically every
 * time. A 30-file pull request did exactly that.
 *
 * This is the test that would have caught it, and the reason it is worth having
 * is that nothing else can: it is not a type error, not a lint, and not
 * reproducible without a large pull request.
 */

const MAX_ARG_BYTES = 131072;

const ctx = (files: { filename: string; patch?: string }[]) => ({
  ref: 'a/b#1',
  title: 'a change',
  body: 'why',
  headBranch: 'feature',
  baseBranch: 'main',
  files: files.map((f) => ({
    filename: f.filename,
    status: 'modified',
    additions: 10,
    deletions: 2,
    patch: f.patch,
  })),
  chunkIndex: 1,
  chunkTotal: 1,
});

const bigPatch = (kb: number) => '+'.repeat(kb * 1024);

describe('buildLensPrompt size', () => {
  it('stays spawnable for a pull request far larger than the argv limit', () => {
    // 40 files of 20 KB each is 800 KB of diff — six times the limit.
    const files = Array.from({ length: 40 }, (_, i) => ({
      filename: `src/file-${i}.ts`,
      patch: bigPatch(20),
    }));
    const prompt = buildLensPrompt(REVIEW_LENSES[0]!, ctx(files));
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(MAX_ARG_BYTES);
  });

  it('NAMES the files it could not inline, so they are still reviewed', () => {
    // The repository is checked out at the pull request, so a file the agent is
    // told about is a file it can open. Dropping them silently would quietly
    // shrink the review rather than the prompt.
    const files = Array.from({ length: 30 }, (_, i) => ({
      filename: `src/file-${i}.ts`,
      patch: bigPatch(20),
    }));
    const prompt = buildLensPrompt(REVIEW_LENSES[0]!, ctx(files));
    expect(prompt).toContain('not inlined here');
    // The instruction wraps across lines in the source; assert the part that
    // carries the meaning rather than a phrase that happens to span a newline.
    expect(prompt).toContain('not excluded from the review');
    expect(prompt).toContain('src/file-29.ts');
  });

  it('inlines everything when the change is ordinary', () => {
    const files = [
      { filename: 'src/a.ts', patch: '+const a = 1;' },
      { filename: 'src/b.ts', patch: '+const b = 2;' },
    ];
    const prompt = buildLensPrompt(REVIEW_LENSES[0]!, ctx(files));
    expect(prompt).toContain('+const a = 1;');
    expect(prompt).toContain('+const b = 2;');
    expect(prompt).not.toContain('not inlined here');
  });

  it('never cuts a patch in half', () => {
    // A truncated hunk is worse than an absent one: a reviewer cannot tell that
    // it stops early, and will reason about code that is not there.
    const files = [
      { filename: 'src/small.ts', patch: '+const small = 1;' },
      { filename: 'src/huge.ts', patch: bigPatch(200) },
    ];
    const prompt = buildLensPrompt(REVIEW_LENSES[0]!, ctx(files));
    expect(prompt).toContain('+const small = 1;');
    // The huge one is named, not partially included.
    expect(prompt).toContain('src/huge.ts');
    expect(prompt).not.toContain(bigPatch(200).slice(0, 4096));
  });

  it('still describes a file that has no patch at all', () => {
    const prompt = buildLensPrompt(REVIEW_LENSES[0]!, ctx([{ filename: 'bin/blob' }]));
    expect(prompt).toContain('no patch available');
  });
});
