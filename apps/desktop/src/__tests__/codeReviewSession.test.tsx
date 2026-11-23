import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { CodeReviewCounts } from '@talyn/shared';
import { api, type CodeReviewListItem, type PRRow } from '../renderer/lib/api';
import { PRDetailSheet } from '../renderer/components/widgets/PRDetailSheet';
import { PrSessionChip } from '../renderer/components/workbench/PrSessionChip';
import { severitiesShown } from '../renderer/components/widgets/codeReview/CodeReviewSeverityCounts';
import { CodeReviewsPanel } from '../renderer/components/panels/codeReview/CodeReviewsPanel';

/**
 * A code review belongs to the session that owns its pull request. The PR
 * sheet and the Code review list link back to that session, also when it is
 * archived.
 */

const navigate = jest.fn();
jest.mock('../renderer/stores/navigation', () => {
  const getState = () => ({ navigate: (...a: unknown[]) => navigate(...a) });
  const hook = (sel: (s: unknown) => unknown) => sel(getState());
  hook.getState = getState;
  return { useNavigationStore: hook };
});
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn(), captureAnalyticsException: jest.fn() }));
jest.mock('../renderer/lib/prSummaryCache', () => ({ prime: jest.fn() }));
jest.mock('../renderer/hooks/useOnReconnect', () => ({ useOnReconnect: jest.fn() }));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock('../renderer/components/panels/github/useGitHubActions', () => ({
  useGitHubActions: () => ({ createPostHogTask: jest.fn(async () => true), providerReady: true }),
}));
jest.mock('../renderer/stores/pullRequests', () => {
  const patchRow = jest.fn();
  const hook = (sel: (s: unknown) => unknown) => sel({ rows: [] });
  hook.getState = () => ({ patchRow });
  return { usePullRequestStore: hook };
});
jest.mock('../renderer/stores/workspace', () => {
  const getState = () => ({
    tasks: [],
    openConnectAgent: jest.fn(),
    currentWorkspaceId: 'ws1',
    workspaces: [],
    setActivePanel: jest.fn(),
    selectTask: jest.fn(),
    features: {},
  });
  const hook = (sel: (s: unknown) => unknown) => sel(getState());
  hook.getState = getState;
  return { useWorkspaceStore: hook };
});
jest.mock('../renderer/lib/api', () => ({
  api: {
    pullRequests: {
      description: jest.fn(() => new Promise(() => {})),
      get: jest.fn(() => new Promise(() => {})),
      files: jest.fn(() => new Promise(() => {})),
      focus: jest.fn(async () => {}),
    },
    codeReviews: { list: jest.fn() },
    posthog: { getStatus: jest.fn(async () => ({ connected: false })) },
    ws: { on: jest.fn(() => () => {}) },
  },
}));

const listReviews = api.codeReviews.list as unknown as jest.Mock;

const LIVE = { id: 'wb-live', name: 'lisbon', status: 'ready' };
const ARCHIVED = { id: 'wb-old', name: 'porto', status: 'ready', archived: true };
const REVIEW_LIVE = { ...LIVE, archived: false };

const COUNTS: CodeReviewCounts = { blocker: 0, major: 0, minor: 0, nit: 0 };

function review(session: unknown) {
  return {
    id: 'rev1',
    preset: 'standard',
    phase: 'ready',
    phasePlan: [],
    runsDone: 0,
    runsTotal: 0,
    lensesRun: [],
    chunkTotal: 1,
    headSha: 'abc',
    headShaShort: 'abc',
    reviewedHeadSha: 'abc',
    staleForHead: false,
    counts: COUNTS,
    openCount: 0,
    dismissedCount: 0,
    funnel: { raised: 0, kept: 0, rejected: 0 },
    failureReason: null,
    deferredSince: null,
    fixTaskId: null,
    lastFix: null,
    startedAt: null,
    finishedAt: null,
    session,
  } as unknown as NonNullable<PRRow['codeReview']>;
}

function row(over: Partial<PRRow> = {}): PRRow {
  return {
    id: 'pr1',
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    taskId: null,
    owner: 'acme',
    repo: 'app',
    number: 7,
    state: 'open',
    reviewRequested: false,
    authored: true,
    watching: false,
    mergedAt: null,
    lastPolledAt: '',
    autoKeepMergeable: false,
    mergeQueued: false,
    mergeMethod: 'squash',
    createdAt: '',
    updatedAt: '',
    summary: {
      title: 'a PR',
      author: 'someone',
      draft: false,
      headBranch: 'h',
      baseBranch: 'main',
      headSha: 'abc',
      updatedAt: '',
      url: 'https://github.com/acme/app/pull/7',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: null,
      blockingReason: 'mergeable',
      checks: { total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 },
    } as PRRow['summary'],
    ...over,
  };
}

const sessionChip = () => document.querySelector('[data-attr="pr-session-chip"]');

beforeEach(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('PrSessionChip', () => {
  it.each([
    { name: 'a live session', session: LIVE, label: 'Open session lisbon', archived: null },
    { name: 'an archived session', session: ARCHIVED, label: 'Open archived session porto', archived: 'true' },
  ])('labels $name and opens it without a click on the row', ({ session, label, archived }) => {
    const onRow = jest.fn();
    const onOpened = jest.fn();
    render(
      <div onClick={onRow}>
        <PrSessionChip session={session} onOpened={onOpened} />
      </div>
    );
    const chip = screen.getByRole('button', { name: label });
    expect(chip.getAttribute('data-archived')).toBe(archived);
    fireEvent.click(chip);
    expect(navigate).toHaveBeenCalledWith({ view: 'workbench', id: session.id });
    expect(onOpened).toHaveBeenCalled();
    expect(onRow).not.toHaveBeenCalled();
  });

  it.each([
    { session: LIVE, text: 'lisbon' },
    { session: ARCHIVED, text: 'porto (archived)' },
  ])('shows the name $text with withName', ({ session, text }) => {
    render(<PrSessionChip session={session} withName />);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it.each([null, undefined])('draws nothing for %s', (session) => {
    const { container } = render(<PrSessionChip session={session} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('the PR sheet links to the session', () => {
  it.each([
    {
      name: 'the live session wins over the review session',
      over: { session: LIVE, codeReview: review(ARCHIVED) },
      label: 'Open session lisbon',
    },
    {
      name: 'the review session when there is no live session',
      over: { session: null, codeReview: review(REVIEW_LIVE) },
      label: 'Open session lisbon',
    },
    {
      name: 'an archived review session says so',
      over: { session: null, codeReview: review(ARCHIVED) },
      label: 'Open archived session porto',
    },
  ])('$name', ({ over, label }) => {
    render(<PRDetailSheet pullRequestId="pr1" onClose={jest.fn()} seedRow={row(over as Partial<PRRow>)} />);
    expect(sessionChip()?.getAttribute('aria-label')).toBe(label);
  });

  it.each([
    { name: 'no session and no review', over: { session: null, codeReview: null } },
    { name: 'a review with no session', over: { session: null, codeReview: review(null) } },
    { name: 'a review from an older backend', over: { codeReview: review(undefined) } },
  ])('shows no session link for $name', ({ over }) => {
    render(<PRDetailSheet pullRequestId="pr1" onClose={jest.fn()} seedRow={row(over as Partial<PRRow>)} />);
    expect(sessionChip()).toBeNull();
  });
});

describe('the Code review list links to the session', () => {
  const item = (session: unknown): CodeReviewListItem => ({
    review: review(session),
    pullRequest: row({ session: null }),
  });

  it.each([
    { name: 'a live session', session: REVIEW_LIVE, text: 'lisbon' },
    { name: 'an archived session', session: ARCHIVED, text: 'porto (archived)' },
  ])('shows $name and opens it, not the row', async ({ session, text }) => {
    listReviews.mockResolvedValue({ reviews: [item(session)] });
    render(<CodeReviewsPanel />);
    const link = await screen.findByText(text);
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith({ view: 'workbench', id: session.id });
    // The row's own click opens the sheet, which reads the pull request. The session link must not.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.pullRequests.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('a PR'));
    await waitFor(() => expect(api.pullRequests.get).toHaveBeenCalledWith('pr1'));
  });

  it('shows no session link when the review has none', async () => {
    listReviews.mockResolvedValue({ reviews: [item(null)] });
    render(<CodeReviewsPanel />);
    await waitFor(() => expect(screen.getByText('a PR')).toBeTruthy());
    expect(sessionChip()).toBeNull();
  });
});

describe('severitiesShown', () => {
  it.each([
    { name: 'no findings', counts: COUNTS, openCount: 0, shown: [] },
    { name: 'all at or above the bar', counts: { blocker: 1, major: 2, minor: 0, nit: 0 }, openCount: 3, shown: ['blocker', 'major'] },
    { name: 'nitpicks below the bar', counts: { blocker: 0, major: 1, minor: 2, nit: 3 }, openCount: 3, shown: ['major', 'minor'] },
    { name: 'a bar at must fix', counts: { blocker: 2, major: 1, minor: 0, nit: 0 }, openCount: 2, shown: ['blocker'] },
    { name: 'no open count shows every severity', counts: { blocker: 0, major: 1, minor: 0, nit: 4 }, openCount: undefined, shown: ['major', 'nit'] },
  ])('$name', ({ counts, openCount, shown }) => {
    expect(severitiesShown(counts as CodeReviewCounts, openCount)).toEqual(shown);
  });
});
