import type { CodeReviewFinding } from '@talyn/client/native';

import { agreementLabel, bucketFindings, droppedFindings, findingLocation, findingMeta, fixableIds, fixedFindings, groupFindings,
  notNeededCount, openFindingCounts, plainCopy, postConfirmation, postToPrState, reviewHeadline, reviewRunning, reviewSummary,
  sessionReportLine } from '../features/prs/codeReview';
import { finding, review } from './workflowFixtures';

const list: CodeReviewFinding[] = [
  finding({ id: 'b1', severity: 'blocker' }),
  finding({ id: 'b2', severity: 'blocker', disposition: 'selected' }),
  finding({ id: 'm1', severity: 'major' }),
  finding({ id: 'n1', severity: 'nit' }),
  finding({ id: 'd1', severity: 'major', disposition: 'dismissed' }),
  finding({ id: 'f1', severity: 'minor', disposition: 'fixed' }),
  finding({ id: 'r1', severity: 'minor', disposition: 'discarded', verdict: 'rejected' }),
];

describe('code review findings', () => {
  it.each([
    ['blocker', [['blocker', ['b1', 'b2']]]],
    ['major', [['blocker', ['b1', 'b2']], ['major', ['m1']]]],
    ['nit', [['blocker', ['b1', 'b2']], ['major', ['m1']], ['nit', ['n1']]]],
  ] as const)('groups open findings at or above the %s bar', (bar, expected) =>
    expect(groupFindings(list, bar).map((group) => [group.severity, group.items.map((item) => item.id)])).toEqual(expected));

  it('fixes only what is shown and not already being fixed', () => expect(fixableIds(groupFindings(list, 'major'))).toEqual(['b1', 'm1']));

  it.each([
    ['major', ['n1', 'd1']],
    ['nit', ['d1']],
  ] as const)('puts nitpicks under the %s bar and dismissals in one bucket', (bar, expected) =>
    expect(bucketFindings(list, bar).map((item) => item.id)).toEqual(expected));

  it('keeps fixed and dropped findings apart', () => {
    expect(fixedFindings(list).map((item) => item.id)).toEqual(['f1']);
    expect(droppedFindings(list).map((item) => item.id)).toEqual(['r1']);
  });

  const shown = [{ id: 'a', postedAt: null }, { id: 'b', postedAt: '2026-11-08T10:00:00Z' }, { id: 'c', postedAt: null }];
  it.each([
    ['nothing ticked posts every unposted one', false, [], { label: 'Post to PR', ids: ['a', 'c'], disabledReason: null }],
    ['ticked ones only', false, ['c'], { label: 'Post 1 to PR', ids: ['c'], disabledReason: null }],
    ['ticked ones already posted', false, ['b'], { label: 'Post to PR', ids: [], disabledReason: 'The findings you ticked are already on the pull request.' }],
    ['a running review', true, [], { label: 'Post to PR', ids: ['a', 'c'], disabledReason: 'Wait for the review to finish before you post.' }],
    ['a ticked id not shown', false, ['z'], { label: 'Post to PR', ids: ['a', 'c'], disabledReason: null }],
  ] as const)('post state: %s', (_name, running, ticked, expected) =>
    expect(postToPrState({ running, shown, ticked: new Set(ticked) })).toEqual(expected));

  it('refuses to post when everything shown is already on the PR', () =>
    expect(postToPrState({ running: false, shown: [shown[1]], ticked: new Set() }).disabledReason).toBe('Every finding shown is already on the pull request.'));

  it.each([
    [1, 'example/project#42', 'This writes 1 finding on example/project#42 as a review comment from your GitHub account. You cannot undo it from Talyn.'],
    [3, null, 'This writes 3 findings on this pull request as a review comment from your GitHub account. You cannot undo it from Talyn.'],
  ] as const)('confirms a post of %s', (count, label, message) =>
    expect(postConfirmation(count, label)).toEqual({ title: 'Post findings to the pull request?', message }));

  it.each([
    [{ phase: 'failed', openCount: 2 }, 'The review did not finish'],
    [{ phase: 'cancelled', openCount: 0 }, 'Review stopped'],
    [{ phase: 'fixed', openCount: 0 }, 'Fix pushed. Review again to confirm it held'],
    [{ phase: 'ready', openCount: 0 }, 'Nothing to flag'],
    [{ phase: 'ready', openCount: 1 }, '1 finding'],
    [{ phase: 'ready', openCount: 4 }, '4 findings'],
  ] as const)('heads a review %j', (patch, expected) => expect(reviewHeadline(review(patch))).toBe(expected));

  it.each([
    ['ready', false], ['failed', false], ['reviewing', true], ['fixing', true], ['queued', true],
  ] as const)('phase %s is running: %s', (phase, expected) => expect(reviewRunning(review({ phase }))).toBe(expected));

  it.each([
    [0, 0],
    [2, 2],
    [undefined, 0],
    [-1, 0],
  ] as const)('counts %s reviewers that sat out as %s', (lensesNotNeeded, expected) =>
    expect(notNeededCount({ lensesNotNeeded })).toBe(expected));

  it.each([
    [['correctness'], null],
    [['correctness', 'security'], 'Logic and Security agree'],
    [['sweep', 'custom-lens'], 'Second pass and custom-lens agree'],
  ] as const)('names agreement for %j', (lenses, expected) => expect(agreementLabel(lenses)).toBe(expected));

  it('names the custom reviewer from the review', () => expect(agreementLabel(['correctness', 'skill:x'], { 'skill:x': 'House rules' })).toBe('Logic and House rules agree'));

  it.each([
    [{}, false, ['src/app.ts:12', 'Logic and Security agree']],
    [{ carriedOver: true, anchorVerified: false, postedAt: '2026-11-08T10:00:00Z', lenses: ['tests'] }, false,
      ['src/app.ts:12', 'still here', 'location approximate', 'Posted to PR']],
    [{ verdict: 'unvalidated', filePath: '', lineStart: null, lenses: ['tests'] }, true, ['Whole pull request', 'not checked yet']],
    [{ verdict: 'unvalidated', lenses: ['tests'] }, false, ['src/app.ts:12']],
  ] as const)('describes a finding %j', (patch, stillChecking, expected) =>
    expect(findingMeta(finding(patch as Partial<CodeReviewFinding>), { stillChecking })).toEqual(expected));

  it.each([
    [{ filePath: 'a.ts', lineStart: null }, 'a.ts'],
    [{ filePath: 'a.ts', lineStart: 4 }, 'a.ts:4'],
    [{ filePath: '', lineStart: 4 }, 'Whole pull request'],
  ] as const)('locates %j', (patch, expected) => expect(findingLocation(patch)).toBe(expected));

  it.each([
    ['No second pass — what the reviewer finds is what you get', 'No second pass: what the reviewer finds is what you get'],
    ['Plain words.', 'Plain words.'],
  ])('removes dashes from %s', (input, expected) => expect(plainCopy(input)).toBe(expected));
});

describe('code review summary', () => {
  it.each([
    ['nothing open', { blocker: 0, major: 0, minor: 0, nit: 2 }, 0, []],
    ['a blocker and a major', { blocker: 1, major: 2, minor: 0, nit: 3 }, 3, ['Must fix 1', 'Should fix 2']],
    ['the default bar, skipping nitpicks', { blocker: 0, major: 1, minor: 2, nit: 3 }, 3, ['Should fix 1', 'Worth considering 2']],
    ['a blocker-only bar', { blocker: 2, major: 1, minor: 1, nit: 0 }, 2, ['Must fix 2']],
    ['the nitpick bar', { blocker: 0, major: 0, minor: 1, nit: 2 }, 3, ['Worth considering 1', 'Nitpicks 2']],
  ] as const)('counts open findings by severity: %s', (_name, counts, openCount, expected) =>
    expect(openFindingCounts({ counts, openCount })).toEqual(expected));

  it.each([
    ['running', { phase: 'reviewing', runsDone: 1, runsTotal: 4 },
      { title: 'Looking for problems (2 of 4)', findings: null, failure: null, waiting: false, stale: false }],
    ['waiting for a runner', { phase: 'queued', runsDone: 0, deferredSince: '2026-11-08T10:00:00Z' },
      { title: 'Waiting to start', findings: null, failure: null, waiting: true, stale: false }],
    ['failed', { phase: 'failed', failureReason: 'The runner stopped.', openCount: 0 },
      { title: 'The review did not finish', findings: null, failure: 'The runner stopped.', waiting: false, stale: false }],
    ['open findings', {},
      { title: '2 findings', findings: 'Must fix 1 · Should fix 1', failure: null, waiting: false, stale: false }],
    ['clean', { counts: { blocker: 0, major: 0, minor: 0, nit: 1 }, openCount: 0 },
      { title: 'Nothing to flag', findings: null, failure: null, waiting: false, stale: false }],
    ['for an older commit', { staleForHead: true },
      { title: '2 findings', findings: 'Must fix 1 · Should fix 1', failure: null, waiting: false, stale: true }],
    ['running on a newer commit', { phase: 'reviewing', staleForHead: true, deferredSince: null },
      { title: 'Looking for problems (4 of 4)', findings: null, failure: null, waiting: false, stale: false }],
  ] as const)('sums up a review that is %s', (_name, patch, expected) =>
    expect(reviewSummary(review(patch as Parameters<typeof review>[0]))).toEqual(expected));

  it.each([
    ['no report', null, null],
    ['an older backend', undefined, null],
    ['a report to this session', { workbenchId: 's1', sentAt: '2026-11-23T10:00:00Z', findingCount: 2 }, 'Talyn sent 2 findings to this session.'],
    ['one finding', { workbenchId: 's1', sentAt: '2026-11-23T10:00:00Z', findingCount: 1 }, 'Talyn sent 1 finding to this session.'],
    ['a report to another session', { workbenchId: 's9', sentAt: '2026-11-23T10:00:00Z', findingCount: 3 }, 'Talyn sent 3 findings to another session.'],
  ] as const)('says where the findings went: %s', (_name, sessionReport, expected) =>
    expect(sessionReportLine({ sessionReport }, 's1')).toBe(expected));
});
