import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import type { MergeQueuePublic, PRCheckContext, PRRow } from '@talyn/client/native';

import { PullRequestDetailScreen } from '../features/prs/PullRequestDetailScreen';
import { fixture, pr } from './workflowFixtures';

jest.setTimeout(15000);

let mockActive = fixture();
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => {
  const { View } = jest.requireActual('react-native');
  const React_ = jest.requireActual('react');
  return {
    useLocalSearchParams: () => ({ id: 'pr-one' }),
    usePathname: () => '/pulls',
    Link: ({ children }: { children: React.ReactNode }) => children,
    useRouter: () => mockRouter,
    Stack: { Screen: ({ options }: { options?: { headerRight?: () => React.ReactNode } }) => React_.createElement(View, null, options?.headerRight?.()) },
  };
});
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store }), useNetwork: () => 'online',
  useWorkspace: () => ({ status: 'ready', selected: 'one', choices: [{ id: 'one', name: 'Test workspace' }] }),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
beforeEach(() => { mockActive.store.dispose(); mockActive = fixture(); mockRouter.push.mockClear(); });
afterEach(() => { mockActive.store.dispose(); jest.restoreAllMocks(); });

type Summary = PRRow['summary'];
const CLEAN: Partial<Summary> = { blockingReason: 'mergeable', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', ciStatus: 'passing',
  checks: { total: 3, passed: 3, failed: 0, inProgress: 0, skipped: 0 } };
const mine = (patch: Partial<PRRow> = {}, s: Partial<Summary> = {}) =>
  pr({ authored: true, reviewRequested: false, ...patch, summary: { ...pr().summary, ...CLEAN, ...s } });
const check = (name: string, state: PRCheckContext['state'], required = true): PRCheckContext => ({ name, state, url: null, required });
const fresh = (row: PRRow, extra: { checkContexts?: PRCheckContext[]; body?: string } = {}) => ({ ...row.summary,
  recentReviews: [], recentReviewComments: [], recentComments: [], body: extra.body ?? '', checkContexts: extra.checkContexts ?? [] });
const serve = (row: PRRow, extra?: Parameters<typeof fresh>[1] | null) =>
  // The fixture types `fresh` as null, so the live detail goes in untyped.
  mockActive.api.pullRequests.get.mockResolvedValue({ row, fresh: (extra === null ? null : fresh(row, extra)) as never });
const openMenu = async () => fireEvent.press(await screen.findByRole('button', { name: 'Pull request actions' }));
const MENU = ['Copy link', 'Copy as Markdown link', 'Share', 'Open on GitHub', 'Fix with agent', 'Merge', 'Review with Talyn',
  'Add to merge queue', 'Leave merge queue', 'Requeue', 'Re-submit to Trunk', 'Turn on Keep mergeable', 'Turn off Keep mergeable',
  'Hide review request', 'Show in review requests', 'Refresh'];
// The action sheet renders last, and it starts with Copy link.
const menuItems = () => {
  const labels = screen.getAllByRole('button').map((item) => String(item.props.accessibilityLabel));
  return labels.slice(labels.indexOf('Copy link')).filter((label) => MENU.includes(label));
};

describe('PR detail next step', () => {
  it('draws the list copy at once and holds Merge until the current copy loads', async () => {
    const row = mine();
    mockActive.api.pullRequests.list.mockResolvedValue([row]);
    await act(async () => { await mockActive.store.load('attention'); });
    let answer: (value: unknown) => void = () => {};
    mockActive.api.pullRequests.get.mockReturnValue(new Promise((resolve) => { answer = resolve; }) as never);
    await render(<PullRequestDetailScreen />);
    expect(await screen.findByText('Ready to merge')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();
    await act(async () => { answer({ row, fresh: fresh(row) }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Merge' })).toBeEnabled());
  });

  it('does not draw the list copy for a pull request that is gone', async () => {
    mockActive.api.pullRequests.list.mockResolvedValue([mine()]);
    await act(async () => { await mockActive.store.load('attention'); });
    mockActive.api.pullRequests.get.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }));
    await render(<PullRequestDetailScreen />);
    expect(await screen.findByText('This item was deleted or is no longer available.')).toBeVisible();
    expect(screen.queryByText('Ready to merge')).toBeNull();
  });

  it('a ready PR of mine shows one verdict and Merge, and merges after a confirmation', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    serve(mine());
    await render(<PullRequestDetailScreen />);
    expect(await screen.findByText('Ready to merge')).toBeVisible();
    expect(screen.getByText('Merges into main.')).toBeVisible();
    expect(screen.getByText('tom/example → main')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open pull request website' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Fix with agent' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Merge' }));
    expect(alert.mock.calls[0][0]).toBe('Merge #42?');
  });

  it('failing checks offer Fix, name the checks, and a name opens the Checks tab', async () => {
    const row = mine({}, { blockingReason: 'checks_failed', ciStatus: 'failing_required', checks: { total: 4, passed: 1, failed: 2, inProgress: 0, skipped: 1 } });
    serve(row, { checkContexts: [check('lint', 'failure'), check('e2e', 'failure'), check('docs', 'success'), check('skip', 'skipped')] });
    await render(<PullRequestDetailScreen />);
    expect(await screen.findByText('2 checks are failing')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Fix with agent' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Checks, 2' })).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'lint. Show checks' }));
    expect(screen.getByRole('tab', { name: 'Checks, 2' }).props.accessibilityState.selected).toBe(true);
    expect(screen.getByText('Failing 2')).toBeVisible();
    // Passed and skipped stay folded.
    const folded = screen.getByRole('button', { name: '1 passed, 1 skipped' });
    expect(screen.queryByLabelText('docs. success')).toBeNull();
    await fireEvent.press(folded);
    expect(screen.getByLabelText('docs. success')).toBeVisible();
  });

  it('a PR in the merge queue needs nothing, so the bar holds only Open on GitHub', async () => {
    serve(mine({ mergeQueued: true, mergeQueue: { status: 'awaiting_ci', position: 2 } as MergeQueuePublic }));
    await render(<PullRequestDetailScreen />);
    expect(await screen.findByText('In the merge queue, #2')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open pull request website' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fix with agent' })).toBeNull();
  });

  it('a queue fix in a session suppresses Fix and links the session', async () => {
    serve(mine({ mergeQueued: true, mergeQueue: { status: 'fixing', fixKind: 'session', position: 1 } as MergeQueuePublic,
      session: { id: 'session-one', name: 'chore-data', status: 'ready' } }, { blockingReason: 'checks_failed' }));
    await render(<PullRequestDetailScreen />);
    expect(await screen.findByText('An agent is fixing this')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Fix with agent' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'View session' }));
    expect(mockRouter.push).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ id: 'session-one' }) }));
  });

  it('a requested review offers Review with Talyn, which opens the review sheet', async () => {
    serve(pr(), null);
    await render(<PullRequestDetailScreen />);
    expect(await screen.findByText('Your review is requested')).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Review with Talyn' }));
    expect(await screen.findByRole('tab', { name: 'Quick' })).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Start review' }));
    await waitFor(() => expect(mockActive.api.pullRequests.startCodeReview).toHaveBeenCalledWith('pr-one', { preset: 'standard' }));
  });
});

describe('PR detail menu', () => {
  it('starts with the link actions and holds every rare action for my PR', async () => {
    serve(mine({ mergeQueued: true, mergeQueue: { status: 'blocked', position: 1, reason: 'Base moved.' } as MergeQueuePublic }));
    await render(<PullRequestDetailScreen />);
    await screen.findByText('Merge queue stopped');
    await openMenu();
    expect(menuItems()).toEqual(['Copy link', 'Copy as Markdown link', 'Share', 'Open on GitHub', 'Fix with agent', 'Merge', 'Review with Talyn',
      'Leave merge queue', 'Turn on Keep mergeable', 'Refresh']);
    await fireEvent.press(screen.getByRole('button', { name: 'Leave merge queue' }));
    expect(mockActive.api.pullRequests.setMergeQueue).toHaveBeenCalledWith('pr-one', false);
  });

  it('gives a reviewer the link actions and hide, and nothing that writes', async () => {
    serve(pr());
    await render(<PullRequestDetailScreen />);
    await openMenu();
    // Review with Talyn is the primary button, so the menu does not repeat it.
    expect(menuItems()).toEqual(['Copy link', 'Copy as Markdown link', 'Share', 'Open on GitHub', 'Hide review request', 'Refresh']);
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Hide review request' })); });
    expect(mockActive.api.pullRequests.setReviewHidden).toHaveBeenCalledWith('pr-one', true);
    expect(await screen.findByText('Hidden from your review requests.')).toBeVisible();
  });

  it('opens the review sheet from the menu', async () => {
    serve(mine());
    await render(<PullRequestDetailScreen />);
    await openMenu();
    await fireEvent.press(screen.getByRole('button', { name: 'Review with Talyn' }));
    await fireEvent.press(await screen.findByRole('tab', { name: 'Deep' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Start review' }));
    await waitFor(() => expect(mockActive.api.pullRequests.startCodeReview).toHaveBeenCalledWith('pr-one', { preset: 'deep' }));
  });
});

describe('PR detail tabs', () => {
  it('shows the description on Overview, folded when long', async () => {
    serve(mine(), { body: Array.from({ length: 20 }, (_, index) => `Line ${index}`).join('\n') });
    await render(<PullRequestDetailScreen />);
    expect(await screen.findByText(/Line 0/)).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByRole('button', { name: 'Show less' })).toBeVisible();
    // The live body came with the detail, so the cached copy is not fetched.
    expect(mockActive.api.pullRequests.description).not.toHaveBeenCalled();
  });

  it('falls back to the cached description without live detail', async () => {
    mockActive.api.pullRequests.description.mockResolvedValue({ body: 'Cached words' });
    serve(mine(), null);
    await render(<PullRequestDetailScreen />);
    expect(await screen.findByText('Cached words')).toBeVisible();
  });

  it('loads files only when the Files tab opens, and a file opens its patch', async () => {
    mockActive.api.pullRequests.files.mockResolvedValue([{ sha: 's', filename: 'src/app.ts', status: 'modified', additions: 2, deletions: 1, changes: 3,
      patch: '@@ -1,2 +1,3 @@\n context\n-old\n+new\n+more' }]);
    serve(mine());
    await render(<PullRequestDetailScreen />);
    await screen.findByText('Ready to merge');
    expect(mockActive.api.pullRequests.files).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('tab', { name: /^Files/ }));
    await waitFor(() => expect(mockActive.api.pullRequests.files).toHaveBeenCalledWith('pr-one'));
    expect(await screen.findByText('1 file changed')).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Files, 1' })).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'src/app.ts. Modified. 2 added, 1 removed' }));
    expect(await screen.findByLabelText('Added line 2: new')).toBeVisible();
    expect(mockActive.api.pullRequests.reviews).not.toHaveBeenCalled();
  });

  it('loads reviews when the Reviews tab opens', async () => {
    mockActive.api.pullRequests.reviews.mockResolvedValue({
      reviews: [{ id: 'r', author: 'ada', avatarUrl: null, state: 'CHANGES_REQUESTED', body: 'Please split this.', submittedAt: '2026-11-08T10:00:00Z', url: '' }],
      threads: [{ id: 't', isResolved: false, isOutdated: false, path: 'src/app.ts', line: 4, diffHunk: '@@ x\n+y',
        comments: [{ id: 'c', author: 'bob', avatarUrl: null, body: 'Why this?', createdAt: '2026-11-08T11:00:00Z', url: '' }] }],
      comments: [],
    });
    serve(mine());
    await render(<PullRequestDetailScreen />);
    await fireEvent.press(await screen.findByRole('tab', { name: /^Reviews/ }));
    expect(await screen.findByText('Please split this.')).toBeVisible();
    expect(screen.getByText('Requested changes')).toBeVisible();
    expect(screen.getByText('Why this?')).toBeVisible();
    expect(screen.getByText('1 inline comment is not resolved.')).toBeVisible();
  });

  it('keeps the queue history and its budgets in a sheet', async () => {
    mockActive.api.pullRequests.mergeQueueTimeline.mockResolvedValue({ events: [{ at: '2026-11-08T11:00:00Z', trigger: 'enqueue',
      toStatus: 'queued', message: 'Added by you.' }] } as never);
    serve(mine({ mergeQueued: true, mergeQueue: { status: 'awaiting_ci', position: 2,
      budgets: { fixRuns: [1, 3], checkReruns: [0, 2], resigns: [0, 3] } } as MergeQueuePublic }));
    await render(<PullRequestDetailScreen />);
    expect(await screen.findByText(/^#2 · /)).toBeVisible();
    expect(screen.queryByText(/Fix runs 1\/3/)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Merge queue history' }));
    expect(await screen.findByText(/Fix runs 1\/3/)).toBeVisible();
    expect(await screen.findByText('Added by you.')).toBeVisible();
  });

  it('shows Findings only once a review exists', async () => {
    serve(mine());
    await render(<PullRequestDetailScreen />);
    await screen.findByText('Ready to merge');
    expect(screen.queryByRole('tab', { name: /^Findings/ })).toBeNull();
  });
});
