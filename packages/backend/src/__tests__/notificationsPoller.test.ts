import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  notificationsPoller,
  parsePrNumber,
} from '../services/notificationsPoller.js';
import { githubService } from '../services/github.js';
import { prMonitorService } from '../services/prMonitor.js';

function notif(over: Partial<{
  type: string;
  fullName: string;
  number: number;
  reason: string;
}> = {}) {
  const number = over.number ?? 42;
  return {
    id: 'n1',
    reason: over.reason ?? 'review_requested',
    updated_at: '2026-06-03T00:00:00Z',
    subject: {
      title: 'Add feature',
      url: `https://api.github.com/repos/${over.fullName ?? 'acme/widgets'}/pulls/${number}`,
      type: over.type ?? 'PullRequest',
    },
    repository: { full_name: over.fullName ?? 'acme/widgets' },
  };
}

const WATCHED = [
  {
    id: 'repo1',
    workspaceId: 'ws1',
    owner: 'acme',
    repo: 'widgets',
    fullName: 'acme/widgets',
    defaultBranch: 'main',
  },
];

describe('parsePrNumber', () => {
  it('extracts the PR number from a subject API url', () => {
    expect(parsePrNumber('https://api.github.com/repos/acme/widgets/pulls/123')).toBe(123);
    expect(parsePrNumber('https://api.github.com/repos/acme/widgets/pulls/9?x=1')).toBe(9);
  });
  it('returns null for issue/non-PR urls and nulls', () => {
    expect(parsePrNumber('https://api.github.com/repos/acme/widgets/issues/5')).toBeNull();
    expect(parsePrNumber(null)).toBeNull();
  });
});

describe('notificationsPoller', () => {
  let refreshSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    notificationsPoller._reset();
    vi.spyOn(githubService, 'getConnectedWorkspaces').mockReturnValue(['ws1']);
    vi.spyOn(prMonitorService, 'getWatchedRepos').mockResolvedValue(WATCHED as never);
    refreshSpy = vi.spyOn(prMonitorService, 'refreshPr').mockResolvedValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('refetches a watched-repo PR on a notification', async () => {
    vi.spyOn(githubService, 'listNotifications').mockResolvedValue({
      status: 200,
      notifications: [notif({ number: 42 })] as never,
      lastModified: 'Tue, 03 Jun 2026 00:00:00 GMT',
      pollInterval: 60,
    });

    await notificationsPoller.forcePollWorkspace('ws1');

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith('ws1', 'acme', 'widgets', 42);
  });

  it('ignores non-PullRequest notifications', async () => {
    vi.spyOn(githubService, 'listNotifications').mockResolvedValue({
      status: 200,
      notifications: [notif({ type: 'Issue', number: 7 })] as never,
      lastModified: null,
      pollInterval: 60,
    });

    await notificationsPoller.forcePollWorkspace('ws1');
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('ignores notifications for repos we do not watch', async () => {
    vi.spyOn(githubService, 'listNotifications').mockResolvedValue({
      status: 200,
      notifications: [notif({ fullName: 'other/repo', number: 7 })] as never,
      lastModified: null,
      pollInterval: 60,
    });

    await notificationsPoller.forcePollWorkspace('ws1');
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('does nothing (and skips the watched-repo lookup) on a 304', async () => {
    const watchedSpy = vi.spyOn(prMonitorService, 'getWatchedRepos');
    vi.spyOn(githubService, 'listNotifications').mockResolvedValue({
      status: 304,
      notifications: [],
      lastModified: 'Tue, 03 Jun 2026 00:00:00 GMT',
      pollInterval: 90,
    });

    await notificationsPoller.forcePollWorkspace('ws1');
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(watchedSpy).not.toHaveBeenCalled();
  });

  it('passes the prior Last-Modified back as the conditional header', async () => {
    const listSpy = vi
      .spyOn(githubService, 'listNotifications')
      .mockResolvedValueOnce({
        status: 200,
        notifications: [],
        lastModified: 'Tue, 03 Jun 2026 00:00:00 GMT',
        pollInterval: 60,
      })
      .mockResolvedValueOnce({
        status: 304,
        notifications: [],
        lastModified: 'Tue, 03 Jun 2026 00:00:00 GMT',
        pollInterval: 60,
      });

    await notificationsPoller.forcePollWorkspace('ws1');
    await notificationsPoller.forcePollWorkspace('ws1');

    expect(listSpy.mock.calls[1][1]?.ifModifiedSince).toBe('Tue, 03 Jun 2026 00:00:00 GMT');
  });
});
