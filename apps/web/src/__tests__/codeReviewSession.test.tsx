import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { CodeReviewCounts } from '@talyn/shared';
import { api, type CodeReviewListItem, type PRRow } from '../lib/api';
import { navigateToWorkbench } from '../lib/workbenchNavigation';
import { PRDetailSheet } from '../components/widgets/PRDetailSheet';
import { PrSessionChip } from '../components/widgets/session/PrSessionChip';
import { severitiesShown } from '../components/widgets/codeReview/CodeReviewSeverityCounts';
import { CodeReviewsPanel } from '../components/panels/codeReview/CodeReviewsPanel';

/**
 * A code review belongs to the session that owns its pull request. The PR
 * sheet and the Code review list link back to that session, also when it is
 * archived.
 */

vi.mock('../lib/workbenchNavigation', () => ({ navigateToWorkbench: vi.fn() }));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));
vi.mock('../lib/prSummaryCache', () => ({ prime: vi.fn() }));
vi.mock('../hooks/useOnReconnect', () => ({ useOnReconnect: vi.fn() }));
vi.mock('../stores/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../components/panels/github/useGitHubActions', () => ({
  useGitHubActions: () => ({ createPostHogTask: vi.fn(async () => true), providerReady: true }),
}));
vi.mock('../stores/pullRequests', () => {
  const patchRow = vi.fn();
  const hook = (sel: (s: unknown) => unknown) => sel({ rows: [] });
  hook.getState = () => ({ patchRow });
  return { usePullRequestStore: hook };
});
vi.mock('../stores/workspace', () => {
  const getState = () => ({
    tasks: [],
    openConnectAgent: vi.fn(),
    currentWorkspaceId: 'ws1',
    workspaces: [],
    setActivePanel: vi.fn(),
    selectTask: vi.fn(),
    features: {},
  });
  const hook = (sel: (s: unknown) => unknown) => sel(getState());
  hook.getState = getState;
  return { useWorkspaceStore: hook };
});
vi.mock('../lib/api', () => ({
  api: {
    pullRequests: {
      description: vi.fn(() => new Promise(() => {})),
      get: vi.fn(() => new Promise(() => {})),
      files: vi.fn(() => new Promise(() => {})),
      focus: vi.fn(async () => {}),
    },
    codeReviews: { list: vi.fn() },
    posthog: { getStatus: vi.fn(async () => ({ connected: false })) },
    ws: { on: vi.fn(() => () => {}) },
  },
}));

const navigate = navigateToWorkbench as unknown as ReturnType<typeof vi.fn>;
const listReviews = api.codeReviews.list as unknown as ReturnType<typeof vi.fn>;

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
  vi.clearAllMocks();
});

describe('PrSessionChip', () => {
  it.each([
    { name: 'a live session', session: LIVE, label: 'Open session lisbon', archived: null },
    { name: 'an archived session', session: ARCHIVED, label: 'Open archived session porto', archived: 'true' },
  ])('labels $name and opens it without a click on the row', ({ session, label, archived }) => {
    const onRow = vi.fn();
    const onOpened = vi.fn();
    render(
      <div onClick={onRow}>
        <PrSessionChip session={session} onOpened={onOpened} />
      </div>
    );
    const chip = screen.getByRole('button', { name: label });
    expect(chip.getAttribute('data-archived')).toBe(archived);
    fireEvent.click(chip);
    expect(navigate).toHaveBeenCalledWith(session.id);
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
    render(<PRDetailSheet pullRequestId="pr1" onClose={vi.fn()} seedRow={row(over as Partial<PRRow>)} />);
    expect(sessionChip()?.getAttribute('aria-label')).toBe(label);
  });

  it.each([
    { name: 'no session and no review', over: { session: null, codeReview: null } },
    { name: 'a review with no session', over: { session: null, codeReview: review(null) } },
    { name: 'a review from an older backend', over: { codeReview: review(undefined) } },
  ])('shows no session link for $name', ({ over }) => {
    render(<PRDetailSheet pullRequestId="pr1" onClose={vi.fn()} seedRow={row(over as Partial<PRRow>)} />);
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
    expect(navigate).toHaveBeenCalledWith(session.id);
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
