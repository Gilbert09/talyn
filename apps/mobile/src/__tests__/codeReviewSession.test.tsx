import { act, render, screen, waitFor, within } from '@testing-library/react-native';

import type { CodeReviewPublic } from '@talyn/client/native';

import { prDetailTab } from '../features/prs/detailModel';
import { PullRequestDetailScreen } from '../features/prs/PullRequestDetailScreen';
import { PullRequestTab } from '../features/sessions/PullRequestTab';
import { pullRequestRoute } from '../navigation/routes';
import { finding, fixture, pr, review, session } from './workflowFixtures';

jest.setTimeout(15000);

let mockActive = fixture();
let mockParams: Record<string, string> = { id: 'pr-one' };
jest.mock('expo-router', () => {
  const React_ = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    useLocalSearchParams: () => mockParams,
    usePathname: () => '/attention/pr-one',
    // Keeps the link target readable: the wrapper's test id is the href.
    Link: ({ href, children }: { href: unknown; children: React.ReactNode }) => React_.createElement(View, { testID: `href ${JSON.stringify(href)}` }, children),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
    Stack: { Screen: () => null },
  };
});
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store }), useNetwork: () => 'online',
  useWorkspace: () => ({ status: 'ready', selected: 'one', choices: [{ id: 'one', name: 'Test workspace' }] }),
}));
jest.mock('../lib/analytics', () => ({ trackEvent: jest.fn() }));
beforeEach(() => { mockActive.store.dispose(); mockActive = fixture(); mockParams = { id: 'pr-one' }; });
afterEach(() => { mockActive.store.dispose(); jest.restoreAllMocks(); });

const withReview = (value: CodeReviewPublic | null) => {
  mockActive.api.pullRequests.get.mockResolvedValue({ row: pr({ codeReview: value }), fresh: null });
  mockActive.api.pullRequests.codeReview.mockResolvedValue({ review: value, findings: value ? [finding()] : [], defaultPreset: 'standard',
    pullRequest: { owner: 'example', repo: 'project', number: 42 } });
};
/** The link that holds `name`, and the href it opens. */
const linkTarget = (name: string | RegExp) => {
  const link = screen.getByRole('link', { name });
  const wrapper = screen.getAllByTestId(/^href /).find((node) => within(node).queryByRole('link', { name }) === link);
  return wrapper ? JSON.parse(String(wrapper.props.testID).slice('href '.length)) : null;
};
const selectedTab = () => screen.getAllByRole('tab').find((tab) => tab.props.accessibilityState?.selected)?.props.accessibilityLabel;

describe('PR route tab', () => {
  it.each([
    [undefined, { pathname: '/attention/[id]', params: { id: 'pr-one' } }],
    ['findings', { pathname: '/attention/[id]', params: { id: 'pr-one', tab: 'findings' } }],
    ['checks', { pathname: '/attention/[id]', params: { id: 'pr-one', tab: 'checks' } }],
  ] as const)('builds the route for tab %s', (tab, expected) => expect(pullRequestRoute('pr-one', { tab })).toEqual(expected));

  it.each([
    ['findings', 'findings'], ['overview', 'overview'], ['reviews', 'reviews'], ['Findings', null], ['bogus', null], [undefined, null],
    [['findings'], null], [3, null],
  ] as const)('reads the tab parameter %j as %s', (value, expected) => expect(prDetailTab(value)).toBe(expected));
});

describe('PR detail opened on a tab', () => {
  it.each([
    ['findings', 'Findings, 2'],
    ['checks', 'Checks'],
    ['bogus', 'Overview'],
    [undefined, 'Overview'],
  ] as const)('opens on tab %s', async (tab, expected) => {
    mockParams = tab ? { id: 'pr-one', tab } : { id: 'pr-one' };
    withReview(review());
    await render(<PullRequestDetailScreen />);
    await screen.findByRole('tab', { name: 'Findings, 2' });
    expect(selectedTab()).toBe(expected);
  });

  it('shows Overview until the review loads, then Findings', async () => {
    mockParams = { id: 'pr-one', tab: 'findings' };
    mockActive.api.pullRequests.get.mockResolvedValue({ row: pr(), fresh: null });
    let answer: (value: unknown) => void = () => {};
    mockActive.api.pullRequests.codeReview.mockReturnValue(new Promise((resolve) => { answer = resolve; }) as never);
    await render(<PullRequestDetailScreen />);
    await screen.findByRole('tab', { name: 'Overview' });
    expect(selectedTab()).toBe('Overview');
    await act(async () => { answer({ review: review(), findings: [finding()], defaultPreset: 'standard', pullRequest: { owner: 'example', repo: 'project', number: 42 } }); });
    await waitFor(() => expect(selectedTab()).toBe('Findings, 2'));
    expect(screen.getByText('Must fix 1')).toBeVisible();
  });
});

describe('review links back to its session', () => {
  it.each([
    ['a live session', { id: 'session-one', name: 'Fix login', status: 'ready', archived: false }, 'View session Fix login', 'Fix login'],
    ['an archived session', { id: 'session-two', name: 'Old work', status: 'ready', archived: true }, 'View session Old work. The session is archived',
      'Old work · Archived'],
  ] as const)('opens %s from the Findings tab', async (_name, owner, label, subtitle) => {
    mockParams = { id: 'pr-one', tab: 'findings' };
    withReview(review({ session: owner }));
    await render(<PullRequestDetailScreen />);
    expect(await screen.findByRole('link', { name: label })).toBeVisible();
    expect(screen.getByText(subtitle)).toBeVisible();
    expect(linkTarget(label)).toEqual({ pathname: '/sessions/[id]', params: { id: owner.id } });
  });

  it.each([['no session', null], ['an older backend', undefined]] as const)('shows no session link with %s', async (_name, owner) => {
    mockParams = { id: 'pr-one', tab: 'findings' };
    withReview(review({ session: owner }));
    await render(<PullRequestDetailScreen />);
    await screen.findByText('Must fix 1');
    expect(screen.queryByRole('link', { name: /^View session/ })).toBeNull();
  });
});

describe('session PR tab code review', () => {
  const show = async (value: CodeReviewPublic | null) => {
    withReview(value);
    await render(<PullRequestTab item={session()} openSheet={jest.fn()} onSent={jest.fn()} />);
    await screen.findByRole('link', { name: /^Pull request 42:/ });
  };

  it.each([
    ['running', { phase: 'reviewing', runsDone: 1, runsTotal: 4 }, 'Looking for problems (2 of 4)', []],
    ['waiting for a runner', { phase: 'queued', runsDone: 0, deferredSince: '2026-11-08T10:00:00Z' }, 'Waiting to start',
      ['Waiting for a runner to become free.']],
    ['failed', { phase: 'failed', openCount: 0, failureReason: 'The runner stopped.' }, 'The review did not finish', ['The runner stopped.']],
    ['open findings', {}, '2 findings', ['Must fix 1 · Should fix 1']],
    ['clean', { counts: { blocker: 0, major: 0, minor: 0, nit: 1 }, openCount: 0 }, 'Nothing to flag', []],
    ['for an older commit', { staleForHead: true }, '2 findings', ['Must fix 1 · Should fix 1', 'There are newer commits.']],
  ] as const)('sums up a review that is %s and opens the Findings tab', async (_name, patch, title, lines) => {
    await show(review(patch as Partial<CodeReviewPublic>));
    expect(screen.getByText('Code review')).toBeVisible();
    expect(screen.getByText(title)).toBeVisible();
    lines.forEach((line) => expect(screen.getByText(line)).toBeVisible());
    const label = `Code review: ${[title, ...lines].map((line) => line.replace(/\.$/, '')).join('. ')}. Show the findings.`;
    expect(screen.getByRole('link', { name: label })).toBeVisible();
    expect(linkTarget(label)).toEqual({ pathname: '/attention/[id]', params: { id: 'pr-one', tab: 'findings' } });
  });

  it('shows no code review when the pull request has none', async () => {
    await show(null);
    expect(screen.queryByText('Code review')).toBeNull();
    expect(screen.queryByRole('link', { name: /^Code review/ })).toBeNull();
  });
});
