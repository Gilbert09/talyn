import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The Refresh button re-reads the cached list after the force-poll whatever
 * happened, so a refresh that never reached GitHub looked exactly like one that
 * found nothing new. It must say so.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */

type PollResult = { message: string; skipped: boolean; repos: number; failedRepos: number; failure: string | null };

function poll(): { next: PollResult | Error } {
  const g = globalThis as unknown as { __talynPoll?: { next: PollResult | Error } };
  g.__talynPoll ??= { next: { message: 'Poll triggered', skipped: false, repos: 1, failedRepos: 0, failure: null } };
  return g.__talynPoll;
}

vi.mock('../lib/api', () => ({
  api: {
    pullRequests: { list: async () => [] },
    repositories: {
      forcePoll: async () => {
        const next = poll().next;
        if (next instanceof Error) throw next;
        return next;
      },
    },
  },
}));
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: { getState: () => ({ currentWorkspaceId: 'ws1' }) },
}));

import { refreshPullRequests } from '../hooks/usePullRequestSync';
import { useToastStore } from '../stores/toast';

const ok = (over: Partial<PollResult> = {}): PollResult => ({
  message: 'Poll triggered',
  skipped: false,
  repos: 13,
  failedRepos: 0,
  failure: null,
  ...over,
});

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
});

describe('Refresh reports what happened', () => {
  it.each<[string, PollResult | Error, Array<{ variant: string; title: string; description?: string }>]>([
    ['a clean refresh stays quiet', ok(), []],
    [
      'a refresh that reached GitHub for no repo is an error',
      new Error('GitHub is rate-limiting your account. Try again in about 5 min.'),
      [{ variant: 'error', title: "Couldn't refresh from GitHub", description: 'GitHub is rate-limiting your account. Try again in about 5 min.' }],
    ],
    [
      'a partial refresh says how many repos failed and why',
      ok({ failedRepos: 2, failure: 'PostHog/secrets: HTTP 502' }),
      [{ variant: 'info', title: "2 of 13 repos couldn't be refreshed", description: 'PostHog/secrets: HTTP 502' }],
    ],
    [
      'a skipped refresh says one is already running',
      ok({ skipped: true, repos: 0 }),
      [{ variant: 'info', title: 'A refresh is already running', description: 'The list updates as it finishes.' }],
    ],
  ])('%s', async (_label, next, expected) => {
    poll().next = next;

    await refreshPullRequests();

    expect(useToastStore.getState().toasts.map(({ variant, title, description }) => ({ variant, title, description })))
      .toEqual(expected.map((t) => ({ description: undefined, ...t })));
  });
});
