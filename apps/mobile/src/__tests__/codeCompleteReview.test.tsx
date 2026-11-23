import type { Workbench, WorkbenchBackground } from '@talyn/shared';
import type { CodeReviewPublic } from '@talyn/client/native';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { WorkbenchDetailScreen } from '../features/sessions/WorkbenchDetailScreen';
import { chat, fixture, pr, review, session } from './workflowFixtures';

jest.setTimeout(15000);

let mockActive = fixture();
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'session-one' }),
  usePathname: () => '/sessions/session-one',
  Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => mockRouter,
  Stack: { Screen: ({ options }: { options?: { headerTitle?: () => React.ReactNode; headerRight?: () => React.ReactNode } }) => {
    const React_ = jest.requireActual('react'); const { View } = jest.requireActual('react-native');
    return React_.createElement(View, null, options?.headerTitle?.(), options?.headerRight?.());
  } },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store, lifecycle: mockActive.lifecycle }), useNetwork: () => 'online',
  useWorkspace: () => ({ status: 'ready', selected: 'one', choices: [{ id: 'one', name: 'Test workspace' }] }),
  useAuth: () => ({ user: { id: 'user-one' } }),
}));
jest.mock('../lib/analytics', () => ({ trackEvent: jest.fn(), trackScreen: jest.fn() }));

const job = (status: string) => ({ id: 'job-one', workbenchId: 'session-one', chatId: 'chat-one', name: 'dev server', command: 'npm run dev', cwd: '/work',
  status, exitCode: null, detail: null, startedAt: '2026-11-09T10:00:00Z', endedAt: null, keepAwakeUntil: null, notifyOnExit: false, lastCheckedAt: null });
const background = (jobs: unknown[] = []): WorkbenchBackground => ({ workbenchId: 'session-one', jobs: jobs as never, wakeups: [] });
const api = () => mockActive.api.workbenches as unknown as Record<string, jest.Mock>;

beforeEach(() => {
  mockActive.store.dispose(); mockActive = fixture();
  Object.assign(mockActive.api.workbenches, { background: jest.fn(async () => background()) });
  Object.values(mockRouter).forEach((value) => { if (jest.isMockFunction(value)) value.mockClear(); });
});
afterEach(() => { mockActive.store.dispose(); jest.restoreAllMocks(); });

const show = async ({ item = {}, codeReview = null, state = 'open' }: { item?: Partial<Workbench>; codeReview?: CodeReviewPublic | null; state?: 'open' | 'closed' | 'merged' } = {}) => {
  mockActive.api.workbenches.get.mockResolvedValue(session(item));
  mockActive.api.pullRequests.get.mockResolvedValue({ row: pr({ codeReview, state }), fresh: null });
  await render(<WorkbenchDetailScreen kind="session" />);
  await screen.findByText('Agent response 1');
};
const card = () => screen.getByTestId('code-complete-review-card');

describe('end-of-chat code review card', () => {
  it.each([
    ['no review', null, ['Ready for review', 'The work is pushed and the pull request is open.'], ['Run code review'], 'Ready for review'],
    ['a running review', review({ phase: 'reviewing', runsDone: 1, runsTotal: 4 }), ['Code review running', 'Looking for problems (2 of 4)'], [], 'Reviewing'],
    ['a review waiting for a runner', review({ phase: 'queued', runsDone: 0, deferredSince: '2026-11-08T10:00:00Z' }),
      ['Code review is waiting for a runner', 'The review starts when a runner is free.'], [], 'Waiting for a runner'],
    ['a failed review', review({ phase: 'failed', openCount: 0, failureReason: 'The runner stopped.' }),
      ['The code review did not finish.', 'The runner stopped.'], ['Run again', 'View findings'], 'Review failed'],
    ['a done review with findings', review(), ['Code review done', 'Must fix 1 · Should fix 1'], ['View findings'], '2 findings'],
    ['a clean review', review({ counts: { blocker: 0, major: 0, minor: 0, nit: 1 }, openCount: 0 }), ['Code review done', 'No open findings'],
      ['View findings'], 'No findings'],
    ['findings sent to this session', review({ sessionReport: { workbenchId: 'session-one', sentAt: '2026-11-23T10:00:00Z', findingCount: 2 } }),
      ['Code review done', 'Must fix 1 · Should fix 1', 'Talyn sent 2 findings to this session.'], ['View findings'], '2 findings'],
  ] as const)('shows %s', async (_name, codeReview, texts, buttons, badge) => {
    await show({ codeReview });
    const inCard = within(await screen.findByTestId('code-complete-review-card'));
    texts.forEach((text) => expect(inCard.getByText(text)).toBeVisible());
    buttons.forEach((name) => expect(inCard.getByRole('button', { name })).toBeVisible());
    expect(inCard.queryAllByRole('button')).toHaveLength(buttons.length);
    expect(within(screen.getByTestId('session-review-badge')).getByText(badge)).toBeVisible();
  });

  it('shows the progress bar while the review runs', async () => {
    await show({ codeReview: review({ phase: 'reviewing', runsDone: 1, runsTotal: 4 }) });
    expect(within(await screen.findByTestId('code-complete-review-card')).getByLabelText('Looking for problems (2 of 4)')).toBeVisible();
  });

  const queued = { id: 'q1', text: 'Next step', queuedAt: '2026-11-08T11:00:00Z' };
  it.each<[string, { item?: Partial<Workbench>; state?: 'closed' | 'merged'; jobs?: boolean }]>([
    ['a turn runs', { item: { chats: [chat({ status: 'running' })] } }],
    ['a message is queued', { item: { chats: [chat({ queuedMessages: [queued] as never })] } }],
    ['the PR is closed', { state: 'closed' }],
    ['the PR is merged', { state: 'merged' }],
    ['a background job runs', { jobs: true }],
    ['files are not committed', { item: { uncommittedStats: { added: 2, removed: 0, files: 1 } } }],
    ['commits are not pushed', { item: { unpushedCommits: 2 } }],
  ])('is hidden when %s', async (_name, { item, state, jobs }) => {
    if (jobs) api().background.mockResolvedValue(background([job('running')]));
    await show({ item, state, codeReview: null });
    // The PR button names the PR's status once its row has loaded.
    await screen.findByRole('button', { name: /^Pull request 42\. .+\. Open the pull request\.$/ });
    await waitFor(() => expect(screen.queryByTestId('code-complete-review-card')).toBeNull());
    expect(screen.queryByTestId('session-review-badge')).toBeNull();
  });

  it('starts a review with the workspace default and shows that it runs', async () => {
    await show();
    await fireEvent.press(within(await screen.findByTestId('code-complete-review-card')).getByRole('button', { name: 'Run code review' }));
    await waitFor(() => expect(mockActive.api.pullRequests.startCodeReview).toHaveBeenCalledWith('pr-one', {}));
    expect(await within(card()).findByText('Code review running')).toBeVisible();
  });

  it('runs a failed review again', async () => {
    await show({ codeReview: review({ phase: 'failed', openCount: 0, failureReason: 'The runner stopped.' }) });
    await fireEvent.press(within(await screen.findByTestId('code-complete-review-card')).getByRole('button', { name: 'Run again' }));
    await waitFor(() => expect(mockActive.api.pullRequests.startCodeReview).toHaveBeenCalledWith('pr-one', {}));
  });

  it('says when the review could not start', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockActive.api.pullRequests.startCodeReview.mockRejectedValueOnce(new Error('No runner.'));
    await show();
    await fireEvent.press(within(await screen.findByTestId('code-complete-review-card')).getByRole('button', { name: 'Run code review' }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Could not start the code review', 'No runner.'));
  });

  it('opens the findings from the card and from the header badge', async () => {
    await show({ codeReview: review() });
    await fireEvent.press(within(await screen.findByTestId('code-complete-review-card')).getByRole('button', { name: 'View findings' }));
    expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/attention/[id]', params: { id: 'pr-one', tab: 'findings' } });
    mockRouter.push.mockClear();
    await fireEvent.press(screen.getByRole('button', { name: 'Code review: 2 findings. Show the findings.' }));
    expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/attention/[id]', params: { id: 'pr-one', tab: 'findings' } });
  });

  it('keeps the review badge while a turn runs', async () => {
    await show({ item: { chats: [chat({ status: 'running' })] }, codeReview: review() });
    expect(await screen.findByRole('button', { name: 'Code review: 2 findings. Show the findings.' })).toBeVisible();
    expect(screen.queryByTestId('code-complete-review-card')).toBeNull();
  });
});
