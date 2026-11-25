/**
 * A merge GitHub refuses because the branch is behind its base gets a toast
 * with an "Update branch" button. Other refusals get the backend's text.
 */

const mockUpdateBranch = jest.fn<Promise<unknown>, [string]>();

jest.mock('../renderer/lib/api', () => {
  class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) {
      super(message);
    }
  }
  return { ApiError, api: { pullRequests: { updateBranch: (id: string) => mockUpdateBranch(id) } } };
});
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: () => {} }));

import { ApiError } from '../renderer/lib/api';
import { mergeErrorText, mergeRefusalCode, showMergeRefusal, updatePullRequestBranch } from '../renderer/lib/mergeRefusal';
import { useToastStore } from '../renderer/stores/toast';

const pr = { id: 'pr-1', number: 344 };
const toasts = () => useToastStore.getState().toasts;

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  mockUpdateBranch.mockReset();
});

describe('mergeErrorText', () => {
  it.each([
    [
      new Error('GitHub API error 409 Conflict: Head branch is out of date. (GitHub request-id: 8E14:BEB88)'),
      'Head branch is out of date.',
    ],
    [new Error('#344 is behind main.'), '#344 is behind main.'],
    ['not an error', 'Merge failed'],
  ])('cleans %s', (err, text) => {
    expect(mergeErrorText(err)).toBe(text);
  });
});

describe('mergeRefusalCode', () => {
  it.each([
    [new ApiError('x', 400, 'branch_behind'), 'branch_behind'],
    [new ApiError('x', 400), undefined],
    [new Error('x'), undefined],
  ])('reads %s', (err, code) => {
    expect(mergeRefusalCode(err)).toBe(code);
  });
});

describe('showMergeRefusal', () => {
  it('offers Update branch for a branch that is behind, and the button updates it', async () => {
    mockUpdateBranch.mockResolvedValue({ updated: true, message: 'Merged main into #344.' });
    showMergeRefusal('Could not merge #344', pr, new ApiError('#344 is behind main.', 400, 'branch_behind'));

    const [t] = toasts();
    expect(t).toMatchObject({ variant: 'error', title: 'Could not merge #344', description: '#344 is behind main.' });
    expect(t.action?.label).toBe('Update branch');

    t.action?.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toasts().some((x) => x.title === 'Updated #344')).toBe(true);
    expect(mockUpdateBranch).toHaveBeenCalledWith('pr-1');
  });

  it.each(['not_mergeable', 'head_changed', undefined])('has no button for code %s', (code) => {
    showMergeRefusal('Could not merge #344', pr, new ApiError('GitHub cannot merge #344 now.', 400, code));
    const [t] = toasts();
    expect(t.description).toBe('GitHub cannot merge #344 now.');
    expect(t.action).toBeUndefined();
  });
});

describe('updatePullRequestBranch', () => {
  it.each([
    [{ updated: true, message: 'm' }, 'Updated #344'],
    [{ updated: false, message: 'm' }, '#344 is up to date'],
  ])('says what happened for %o', async (res, title) => {
    mockUpdateBranch.mockResolvedValue(res);
    expect(await updatePullRequestBranch(pr)).toBe(true);
    expect(toasts()[0]).toMatchObject({ variant: 'success', title });
  });

  it('shows the error when GitHub refuses', async () => {
    mockUpdateBranch.mockRejectedValue(new ApiError('#344 has merge conflicts with main.', 409, 'update_branch_conflict'));
    expect(await updatePullRequestBranch(pr)).toBe(false);
    expect(toasts()[0]).toMatchObject({
      variant: 'error',
      title: 'Could not update #344',
      description: '#344 has merge conflicts with main.',
    });
  });
});
