import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PullRequestsView } from '../pages/PullRequestsView';
import { usePullRequestStore } from '../stores/pullRequests';
import { refreshPullRequests } from '../hooks/usePullRequestSync';
import type { PrTab } from '../stores/navigation';

/**
 * Refresh is in the page header of the three open-PR pages, not in the "⋯"
 * menu. People press it often. Duplicated in apps/desktop.
 */

vi.mock('../hooks/usePullRequestSync', () => ({ refreshPullRequests: vi.fn(() => Promise.resolve()) }));
vi.mock('../hooks/usePrBadgeCounts', () => ({
  usePrBadgeCounts: () => ({ my_prs: 0, reviews: 0, code_reviews: 0, merge_queue: 0, queue: 0 }),
}));
vi.mock('../components/panels/github/MyPRsPanel', () => ({ MyPRsPanel: () => null }));
vi.mock('../components/panels/github/ReviewsPanel', () => ({ ReviewsPanel: () => null }));
vi.mock('../components/panels/github/MergeQueuePanel', () => ({ MergeQueuePanel: () => null }));
vi.mock('../components/panels/QueuePanel', () => ({ QueuePanel: () => null }));
vi.mock('../components/panels/codeReview/CodeReviewsPanel', () => ({ CodeReviewsPanel: () => null }));

const refresh = refreshPullRequests as unknown as Mock;

afterEach(cleanup);

beforeEach(() => {
  refresh.mockClear();
  usePullRequestStore.setState({ loading: false });
});

describe('PR page header refresh', () => {
  it.each<[PrTab, boolean]>([
    ['my_prs', true],
    ['reviews', true],
    ['merge_queue', true],
    ['code_reviews', false],
    ['queue', false],
  ])('on the %s tab, shows the button: %s', (tab, shown) => {
    render(<PullRequestsView tab={tab} />);
    const button = screen.queryByRole('button', { name: 'Refresh from GitHub' });
    if (shown) expect(button).toBeInTheDocument();
    else expect(button).not.toBeInTheDocument();
  });

  it('asks GitHub again when pressed', () => {
    render(<PullRequestsView tab="my_prs" />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh from GitHub' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('is disabled and spins while the list loads', () => {
    usePullRequestStore.setState({ loading: true });
    render(<PullRequestsView tab="reviews" />);
    const button = screen.getByRole('button', { name: 'Refresh from GitHub' });
    expect(button).toBeDisabled();
    expect(button.querySelector('svg')).toHaveClass('animate-spin');
    fireEvent.click(button);
    expect(refresh).not.toHaveBeenCalled();
  });
});
