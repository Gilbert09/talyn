import type { PRRow } from '@talyn/client/native';

import type { CodeReviewData } from '../workflow/store';
import { finding, fixture, pr, review } from './workflowFixtures';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('code review in the store', () => {
  let active: ReturnType<typeof fixture>;
  beforeEach(() => {
    active = fixture();
    active.api.pullRequests.codeReview.mockResolvedValue({ review: review(), findings: [finding(), finding({ id: 'finding-two', severity: 'major' })],
      defaultPreset: 'standard', pullRequest: { owner: 'example', repo: 'project', number: 42 } });
  });
  afterEach(() => active.store.dispose());
  const data = () => active.store.read<CodeReviewData>('codeReview', 'pr-one').data;

  it('checks scope from a held row without a second PR read', async () => {
    await active.store.load('attention');
    await active.store.load('codeReview', 'pr-one');
    expect(active.api.pullRequests.get).not.toHaveBeenCalled();
    expect(data()?.findings).toHaveLength(2);
  });
  it('reads the PR first when it holds no row, and refuses one from another workspace', async () => {
    active.api.pullRequests.get.mockResolvedValueOnce({ row: pr({ workspaceId: 'two' }), fresh: null });
    await active.store.load('codeReview', 'pr-one');
    expect(active.store.read('codeReview', 'pr-one').status).toBe('unauthorized');
    expect(active.api.pullRequests.codeReview).not.toHaveBeenCalled();
  });
  it.each([
    ['a changed review', { id: 'pr-one', state: 'open', codeReview: review({ phase: 'reviewing' }) }, 'reviewing', true],
    ['a cleared review', { id: 'pr-one', state: 'open', codeReview: null }, undefined, true],
    ['no review field', { id: 'pr-one', state: 'open' }, 'ready', false],
  ] as const)('patches %s from the socket and owes the findings a refetch', async (_name, update, phase, owed) => {
    const stop = active.store.watch('codeReview', 'pr-one'); await settle(); await settle();
    active.emit('pull_request:updated', update);
    expect(data()?.review?.phase).toBe(phase);
    expect(active.store.read('codeReview', 'pr-one')).toMatchObject({ status: 'ready', stale: owed }); stop();
  });
  it('starts a review with the preset and puts it on the row', async () => {
    await active.store.load('attention'); await active.store.load('codeReview', 'pr-one');
    await active.store.startCodeReview('pr-one', 'deep');
    expect(active.api.pullRequests.startCodeReview).toHaveBeenCalledWith('pr-one', { preset: 'deep' });
    expect(active.store.read<PRRow[]>('attention').data?.[0].codeReview?.phase).toBe('queued');
    expect(data()?.review?.phase).toBe('queued');
    await active.store.startCodeReview('pr-one', 'quick', true);
    expect(active.api.pullRequests.startCodeReview).toHaveBeenLastCalledWith('pr-one', { preset: 'quick', reset: true });
  });
  it.each([
    ['a review', null, 'cancelCodeReview'],
    ['a fix', 'task-fix', 'stop'],
  ] as const)('stops %s the way web does', async (_name, taskId, method) => {
    await active.store.stopCodeReview('pr-one', taskId);
    if (method === 'stop') { expect(active.api.tasks.stop).toHaveBeenCalledWith('task-fix'); expect(active.api.pullRequests.cancelCodeReview).not.toHaveBeenCalled(); }
    else expect(active.api.pullRequests.cancelCodeReview).toHaveBeenCalledWith('pr-one');
  });
  it('dismisses at once and puts the finding back when the server refuses', async () => {
    await active.store.load('codeReview', 'pr-one');
    active.api.pullRequests.dismissCodeReviewFinding.mockRejectedValueOnce({ status: 500 });
    const pending = active.store.dismissCodeReviewFinding('pr-one', 'finding-one', 'not_a_problem');
    expect(data()?.findings[0]).toMatchObject({ disposition: 'dismissed', dismissedReason: 'not_a_problem' });
    await expect(pending).rejects.toMatchObject({ status: 500 });
    expect(data()?.findings[0]).toMatchObject({ disposition: 'open', dismissedReason: null });
  });
  it('fixes, posts and restores through the server', async () => {
    await active.store.load('attention'); await active.store.load('codeReview', 'pr-one');
    await active.store.fixCodeReviewFindings('pr-one', ['finding-one']);
    expect(active.store.findPr('pr-one')).toMatchObject({ taskId: 'task-fix', codeReview: { phase: 'fixing' } });
    const posted = await active.store.postCodeReviewFindings('pr-one', ['finding-one', 'finding-two']);
    expect(posted.posted).toBe(2);
    await active.store.undismissCodeReviewFinding('pr-one', 'finding-one');
    expect(active.api.pullRequests.undismissCodeReviewFinding).toHaveBeenCalledWith('pr-one', 'finding-one');
    expect(await active.store.codeReviewFinding('pr-one', 'finding-one')).toMatchObject({ body: 'The body.' });
  });
});
