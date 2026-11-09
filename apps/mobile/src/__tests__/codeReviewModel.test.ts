import type { CodeReviewFinding } from '@talyn/client/native';

import { agreementLabel, bucketFindings, droppedFindings, findingLocation, findingMeta, fixableIds, fixedFindings, groupFindings,
  notNeededCount, plainCopy, postConfirmation, postToPrState, reviewHeadline, reviewRunning } from '../features/prs/codeReview';
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
    [['correctness', 'security'], 'standard', 1],
    [['correctness', 'security', 'reliability'], 'standard', 0],
    [['correctness', 'skill:repo:team/review'], 'deep', 4],
    [['skill:repo:team/review'], 'standard', 0],
    [[], 'deep', 0],
  ] as const)('counts reviewers that sat out for %j on %s', (lensesRun, preset, expected) =>
    expect(notNeededCount({ lensesRun: [...lensesRun], preset })).toBe(expected));

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
