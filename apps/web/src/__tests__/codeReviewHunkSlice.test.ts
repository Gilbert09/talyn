import { describe, it, expect } from 'vitest';
import { sliceHunksAround } from '../components/widgets/codeReview/FindingsTab';

/**
 * Picking the hunk a finding sits in.
 *
 * A finding names a line in the NEW file, and `@@ -a,b +c,d @@` carries exactly
 * that range — so the hunk is found by arithmetic rather than by searching the
 * patch for the quoted code. Getting this wrong does not throw; it shows the
 * reader a different part of the file and lets them judge a finding against
 * code it is not about.
 */

const PATCH = [
  '@@ -1,3 +1,4 @@',
  ' context one',
  '+added at 2',
  ' context three',
  ' context four',
  '@@ -40,2 +41,3 @@',
  ' context at 41',
  '+added at 42',
  ' context at 43',
].join('\n');

describe('sliceHunksAround', () => {
  it('returns only the hunk containing the line', () => {
    const out = sliceHunksAround(PATCH, 42);
    expect(out).toContain('added at 42');
    expect(out).not.toContain('added at 2');
  });

  it('reads the NEW-side range, not the old one', () => {
    // The second hunk is -40 on the old side and +41 on the new. A reader that
    // took the old range would answer this with the wrong hunk, or with none.
    expect(sliceHunksAround(PATCH, 41)).toContain('context at 41');
    expect(sliceHunksAround(PATCH, 40)).not.toBe(
      sliceHunksAround(PATCH, 41)
    );
  });

  it.each([
    ['the first line of a hunk', 1],
    ['the last line of a hunk', 4],
  ])('includes %s', (_label, line) => {
    expect(sliceHunksAround(PATCH, line)).toContain('added at 2');
  });

  it('falls back to the whole patch for a line no hunk covers', () => {
    // A line outside every hunk means the finding is about context the pull
    // request did not change. That is real, and showing everything is better
    // than showing nothing.
    expect(sliceHunksAround(PATCH, 900)).toBe(PATCH);
  });

  it('falls back to the whole patch when the finding names no line', () => {
    expect(sliceHunksAround(PATCH, null)).toBe(PATCH);
  });

  it('handles a single-line hunk, where the count is omitted', () => {
    // `@@ -5 +5 @@` is valid and means one line; reading the absent count as 0
    // would make the range end before it starts and match nothing.
    const single = ['@@ -5 +5 @@', '+only line'].join('\n');
    expect(sliceHunksAround(single, 5)).toContain('only line');
  });

  it('returns the patch unchanged when it has no hunk headers at all', () => {
    expect(sliceHunksAround('not a patch', 3)).toBe('not a patch');
  });
});
