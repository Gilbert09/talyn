import { describe, expect, it } from 'vitest';
import {
  GitProgressTracker,
  isGitProgressLine,
  meaningfulStderrTail,
  parseGitProgressLine,
} from '../services/workbenches/gitProgress.js';

describe('parseGitProgressLine', () => {
  it.each([
    ['remote: Enumerating objects: 12% (1/8)', { phase: 'remote', label: 'Preparing objects', percent: 12 }],
    ['remote: Counting objects:  42% (420/1000)', { phase: 'remote', label: 'Preparing objects', percent: 42 }],
    ['remote: Compressing objects: 100% (5/5), done.', { phase: 'remote', label: 'Preparing objects', percent: 100 }],
    ['Receiving objects:   7% (70/1000), 1.20 MiB | 2.40 MiB/s', { phase: 'receiving', label: 'Receiving objects', percent: 7 }],
    ['Receiving objects: 100% (1000/1000), 12.00 MiB | 9.00 MiB/s, done.', { phase: 'receiving', label: 'Receiving objects', percent: 100 }],
    ['Resolving deltas:  55% (11/20)', { phase: 'resolving', label: 'Resolving deltas', percent: 55 }],
    ['Updating files:  99% (990/1000)', { phase: 'updating', label: 'Updating files', percent: 99 }],
    ['Receiving objects:   1% (1/100)\rReceiving objects:   2% (2/100)\r', { phase: 'receiving', label: 'Receiving objects', percent: 2 }],
    ['Resolving deltas:  30% (3/10)\r', { phase: 'resolving', label: 'Resolving deltas', percent: 30 }],
    ['remote: Counting objects:  50% (1/2)\x1b[K', { phase: 'remote', label: 'Preparing objects', percent: 50 }],
    ['  Receiving objects:  9% (9/100)  ', { phase: 'receiving', label: 'Receiving objects', percent: 9 }],
  ])('reads %j', (line, expected) => {
    expect(parseGitProgressLine(line)).toEqual(expected);
  });

  it.each([
    '',
    'Cloning into \'/work/App\'...',
    'fatal: repository \'https://github.com/a/b.git/\' not found',
    'remote: Total 1000 (delta 20), reused 0 (delta 0), pack-reused 0',
    'Receiving objects: 120% (1/1)',
    'Receiving objects: abc%',
    'Receiving objects',
    'remote: Enumerating objects: 1234, done.',
    'Some Receiving objects: 40% (4/10)',
  ])('ignores %j', (line) => {
    expect(parseGitProgressLine(line)).toBeNull();
  });
});

describe('isGitProgressLine', () => {
  it.each([
    ['Receiving objects:  40% (4/10)', true],
    ['remote: Enumerating objects: 1234, done.', true],
    ['remote: Total 1000 (delta 20), reused 0 (delta 0), pack-reused 0', true],
    ['Checking connectivity: 100% (10/10), done.', true],
    ['Unpacking objects: 100% (3/3), done.', true],
    ['Updating files: 100% (1000/1000), done.', true],
    ['Cloning into \'/work/App\'...', false],
    ['fatal: could not read Username', false],
    ['error: RPC failed; curl 92 HTTP/2 stream 0 was not closed cleanly', false],
    ['', false],
  ])('%j → %s', (line, expected) => {
    expect(isGitProgressLine(line)).toBe(expected);
  });
});

describe('meaningfulStderrTail', () => {
  it.each([
    [
      'leaves progress lines out of a failure',
      [
        'Cloning into \'/work/App\'...',
        'remote: Enumerating objects: 10, done.',
        'Receiving objects:  40% (4/10)',
        'error: RPC failed; curl 92',
        'fatal: early EOF',
        'Receiving objects:  41% (4/10)',
        'fatal: fetch-pack: invalid index-pack output',
      ].join('\n'),
      'error: RPC failed; curl 92 fatal: early EOF fatal: fetch-pack: invalid index-pack output',
    ],
    ['is empty for progress only', 'Receiving objects: 100% (1/1), done.\nResolving deltas: 100% (1/1), done.', ''],
    ['is empty for nothing', '', ''],
    ['keeps the last three', 'a\nb\nc\nd', 'b c d'],
    ['reads the last update of a line with \\r', 'Receiving objects: 1%\rfatal: boom', 'fatal: boom'],
  ])('%s', (_name, stderr, expected) => {
    expect(meaningfulStderrTail(stderr)).toBe(expected);
  });

  it('takes a count', () => {
    expect(meaningfulStderrTail('a\nb\nc', 1)).toBe('c');
  });
});

describe('GitProgressTracker', () => {
  const run = (lines: string[]) => {
    const tracker = new GitProgressTracker();
    return lines.map((line) => tracker.push(line));
  };

  it.each([
    ['the start of the remote phase', 'remote: Counting objects:   0% (0/10)', 0],
    ['the end of the remote phase', 'remote: Compressing objects: 100% (10/10)', 10],
    ['half of receiving', 'Receiving objects:  50% (5/10)', 45],
    ['all of receiving', 'Receiving objects: 100% (10/10)', 80],
    ['half of resolving', 'Resolving deltas:  50% (5/10)', 87],
    ['all of resolving', 'Resolving deltas: 100% (10/10)', 95],
    ['half of updating files', 'Updating files:  50% (5/10)', 97],
    ['all of updating files', 'Updating files: 100% (10/10)', 100],
  ])('maps %s', (_name, line, expected) => {
    expect(run([line])[0]).toMatchObject({ percent: expected });
  });

  it('never goes backwards across phases', () => {
    const tracker = new GitProgressTracker();
    const seen: number[] = [];
    for (const line of [
      'remote: Enumerating objects: 100% (10/10)',
      'remote: Counting objects:  20% (2/10)',
      'Receiving objects:  30% (3/10)',
      'Receiving objects:  10% (1/10)',
      'Resolving deltas:  10% (1/10)',
      'Receiving objects:  90% (9/10)',
      'Updating files:  10% (1/10)',
      'Resolving deltas: 100% (10/10)',
    ]) {
      tracker.push(line);
      if (tracker.percent !== null) seen.push(tracker.percent);
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(tracker.percent).toBe(95);
  });

  it('maps a second fetch into what is left below the checkout', () => {
    const tracker = new GitProgressTracker();
    tracker.push('Receiving objects: 100% (10/10)');
    expect(tracker.percent).toBe(80);
    tracker.push('remote: Counting objects:   0% (0/10)');
    expect(tracker.percent).toBe(80);
    tracker.push('Receiving objects:  50% (5/10)');
    expect(tracker.percent).toBe(87);
    tracker.push('Resolving deltas: 100% (5/5)');
    expect(tracker.percent).toBe(95);
    tracker.push('Updating files: 100% (5/5)');
    expect(tracker.percent).toBe(100);
  });

  it('answers only when the percentage or the phase changed', () => {
    expect(run([
      'Receiving objects:  50% (5/10)',
      'Receiving objects:  50% (5/10)',
      'Receiving objects: 100% (10/10)',
      'Receiving objects: 100% (10/10), done.',
      'Resolving deltas:   0% (0/10)',
      'Cloning into \'x\'...',
    ])).toEqual([
      { percent: 45, detail: 'Receiving objects' },
      null,
      { percent: 80, detail: 'Receiving objects' },
      null,
      { percent: 80, detail: 'Resolving deltas' },
      null,
    ]);
  });

  it('has no percentage before git says one', () => {
    const tracker = new GitProgressTracker();
    expect(tracker.percent).toBeNull();
    expect(tracker.push('Cloning into \'x\'...')).toBeNull();
    expect(tracker.percent).toBeNull();
  });
});
