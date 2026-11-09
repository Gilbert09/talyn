import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import type { MergeQueuePublic, PRRow } from '@talyn/client/native';

import { PullRequestDetailScreen } from '../features/prs/PullRequestDetailScreen';
import { PullRequestsScreen } from '../features/prs/PullRequestsScreen';
import { finding, fixture, pr, review } from './workflowFixtures';

jest.setTimeout(15000);

let mockActive = fixture();
let mockParams: Record<string, string> = { id: 'pr-one' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/pulls',
  Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  Stack: { Screen: () => null },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store }), useNetwork: () => 'online',
  useWorkspace: () => ({ status: 'ready', selected: 'one', choices: [{ id: 'one', name: 'Test workspace' }] }),
}));
beforeEach(() => { mockActive.store.dispose(); mockActive = fixture(); mockParams = { id: 'pr-one' }; });
afterEach(() => { mockActive.store.dispose(); jest.restoreAllMocks(); });

const summary = (patch: Partial<PRRow['summary']> = {}) => ({ ...pr().summary, ...patch });
const confirmLast = async (alert: jest.SpyInstance, label: string) => {
  const buttons = alert.mock.calls[alert.mock.calls.length - 1][2] as Array<{ text: string; onPress?(): void }>;
  await act(async () => buttons.find((button) => button.text === label)?.onPress?.());
};

describe('pull request pages', () => {
  it('leads My PRs with what needs you', async () => {
    mockActive.api.pullRequests.list.mockResolvedValueOnce([
      pr({ id: 'a', number: 1, authored: true, reviewRequested: false, summary: summary({ title: 'Conflicted', blockingReason: 'merge_conflicts' }) }),
      pr({ id: 'b', number: 2, authored: true, reviewRequested: false, summary: summary({ title: 'Plain', reviewDecision: undefined }) }),
      pr({ id: 'c', number: 3, reviewRequested: true, summary: summary({ title: 'Not mine' }) }),
    ]);
    await render(<PullRequestsScreen tab="mine" />);
    expect(await screen.findByRole('link', { name: /^Conflicted\./ })).toBeVisible();
    expect(screen.getByText('Needs attention')).toBeVisible();
    expect(screen.getByText('Open')).toBeVisible();
    expect(screen.queryByRole('link', { name: /^Not mine\./ })).toBeNull();
  });

  it.each([
    ['mine', 'No open pull requests'],
    ['reviews', 'Nothing to review'],
    ['queue', 'The merge queue is empty.'],
  ] as const)('shows the %s empty state', async (tab, title) => {
    mockActive.api.pullRequests.list.mockResolvedValueOnce([]);
    await render(<PullRequestsScreen tab={tab} />);
    expect(await screen.findByText(title)).toBeVisible();
  });

  it('names who was asked to review and keeps hidden requests behind a toggle', async () => {
    mockActive.api.pullRequests.list.mockResolvedValueOnce([
      pr({ summary: summary({ reviewRequestVia: { direct: false, teams: ['org/core', 'org/web'] } }) }),
      pr({ id: 'hidden', number: 9, reviewHiddenAt: '2026-11-08T10:00:00Z', summary: summary({ title: 'Skipped one' }) }),
    ]);
    await render(<PullRequestsScreen tab="reviews" />);
    expect(await screen.findByRole('link', { name: /Requested: @org\/core \+1\./ })).toBeVisible();
    expect(screen.queryByRole('link', { name: /^Skipped one\./ })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Show 1 hidden pull request' }));
    expect(await screen.findByRole('link', { name: /^Skipped one\./ })).toBeVisible();
  });

  it('shows queue position, status and why it is blocked', async () => {
    const queued = (patch: Partial<MergeQueuePublic>) => ({ mergeQueued: true, mergeQueue: { status: 'queued', position: 1, ...patch } as MergeQueuePublic });
    mockActive.api.pullRequests.list.mockResolvedValueOnce([
      pr({ id: 'a', number: 1, ...queued({ status: 'awaiting_ci', position: 2 }), summary: summary({ title: 'Waiting', headBranch: 'a' }) }),
      pr({ id: 'b', number: 2, ...queued({ status: 'blocked', position: 1, reason: 'Checks fail.' }), summary: summary({ title: 'Stuck', headBranch: 'b' }) }),
    ]);
    await render(<PullRequestsScreen tab="queue" />);
    expect(await screen.findByRole('link', { name: /^Waiting\..*Queue: position 2, Waiting for CI\./ })).toBeVisible();
    expect(screen.getByText('Checks fail. It clears on a new push. Requeue to retry now.')).toBeVisible();
    expect(screen.getByText('example/project → main')).toBeVisible();
  });
});

describe('code review on PR detail', () => {
  const withFindings = () => mockActive.api.pullRequests.codeReview.mockResolvedValue({
    review: review(), findings: [finding(), finding({ id: 'finding-two', severity: 'major', title: 'Retry loop', lenses: ['reliability'] })],
    defaultPreset: 'standard', pullRequest: { owner: 'example', repo: 'project', number: 42 },
  });

  it('starts a review with the chosen depth', async () => {
    await render(<PullRequestDetailScreen />);
    await fireEvent.press(await screen.findByRole('tab', { name: 'Deep' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Review this pull request' }));
    await waitFor(() => expect(mockActive.api.pullRequests.startCodeReview).toHaveBeenCalledWith('pr-one', { preset: 'deep' }));
  });

  it('shows findings by severity with the reviewers that agree, and posts after a confirmation', async () => {
    withFindings();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await render(<PullRequestDetailScreen />);
    expect(await screen.findByText('Must fix 1')).toBeVisible();
    expect(screen.getByText('Should fix 1')).toBeVisible();
    expect(screen.getByRole('button', { name: /Null `user` is read\. src\/app\.ts:12, Logic and Security agree/ })).toBeVisible();
    // A blocker opens on its own and loads its detail.
    expect(await screen.findByText('const user = load();')).toBeVisible();
    expect(screen.getByText("Checker's note: Reproduced on the branch.")).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Post to PR' }));
    expect(alert.mock.calls[0].slice(0, 2)).toEqual(['Post findings to the pull request?',
      'This writes 2 findings on example/project#42 as a review comment from your GitHub account. You cannot undo it from Talyn.']);
    expect(mockActive.api.pullRequests.postCodeReviewFindings).not.toHaveBeenCalled();
    await confirmLast(alert, 'Post to PR');
    expect(mockActive.api.pullRequests.postCodeReviewFindings).toHaveBeenCalledWith('pr-one', ['finding-one', 'finding-two']);
    expect(await screen.findByText('Posted 2 findings to the pull request.')).toBeVisible();
  });

  it('fixes the ticked findings from the bottom bar', async () => {
    withFindings();
    await render(<PullRequestDetailScreen />);
    await fireEvent.press(await screen.findByRole('checkbox', { name: 'Select "Retry loop" to fix' }));
    expect(screen.getByText('1 selected')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Post 1 to PR' })).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Fix selected' }));
    await waitFor(() => expect(mockActive.api.pullRequests.fixCodeReviewFindings).toHaveBeenCalledWith('pr-one', ['finding-two']));
  });

  it('dismisses with a reason', async () => {
    withFindings();
    await render(<PullRequestDetailScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Dismiss' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Not a problem' }));
    await waitFor(() => expect(mockActive.api.pullRequests.dismissCodeReviewFinding).toHaveBeenCalledWith('pr-one', 'finding-one', 'not_a_problem'));
  });

  it('refuses a post while the review runs and offers a stop', async () => {
    mockActive.api.pullRequests.codeReview.mockResolvedValue({ review: review({ phase: 'reviewing', runsDone: 1 }), findings: [finding()],
      defaultPreset: 'standard', pullRequest: { owner: 'example', repo: 'project', number: 42 } });
    await render(<PullRequestDetailScreen />);
    expect(await screen.findByRole('button', { name: 'Post to PR. Wait for the review to finish before you post.' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(mockActive.api.pullRequests.cancelCodeReview).toHaveBeenCalledWith('pr-one'));
  });

  it('states the merge queue status and why it is blocked', async () => {
    mockActive.api.pullRequests.get.mockResolvedValue({ row: pr({ authored: true, mergeQueued: true,
      mergeQueue: { status: 'blocked', position: 3, blockedCode: 'agent_needs_human', reason: 'A person must approve.' } }), fresh: null });
    await render(<PullRequestDetailScreen />);
    expect(await screen.findByText('#3 · Waiting on you. The queue carries on by itself once this clears.')).toBeVisible();
    expect(screen.getByText('A person must approve.')).toBeVisible();
  });
});
