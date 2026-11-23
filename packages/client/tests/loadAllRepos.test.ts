import { afterEach, describe, expect, it, vi } from 'vitest';
import { github, loadAllRepos, mergeRepos, type GitHubRepo } from '../src/native';

const repo = (fullName: string): GitHubRepo => {
  const [owner, name] = fullName.split('/');
  return {
    id: fullName.length,
    name,
    full_name: fullName,
    private: false,
    html_url: `https://github.com/${fullName}`,
    default_branch: 'main',
    owner: { login: owner, avatar_url: '' },
  } as GitHubRepo;
};
const page = (owner: string, count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => repo(`${owner}/r${from + i}`));
const names = (repos: GitHubRepo[]) => repos.map((r) => r.full_name).sort();

function mockSources(
  userPages: Array<GitHubRepo[] | Error>,
  orgs: string[] | Error,
  orgPages: Record<string, Array<GitHubRepo[] | Error>> = {}
) {
  const answer = (pages: Array<GitHubRepo[] | Error>, n: number) => {
    const value = pages[n - 1] ?? [];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  };
  return {
    user: vi.spyOn(github, 'listReposPage').mockImplementation((_ws, n) => answer(userPages, n)),
    orgs: vi
      .spyOn(github, 'listOrgs')
      .mockImplementation(() =>
        orgs instanceof Error
          ? Promise.reject(orgs)
          : Promise.resolve(orgs.map((login) => ({ login, avatar_url: '' })))
      ),
    org: vi
      .spyOn(github, 'listOrgReposPage')
      .mockImplementation((_ws, org, n) => answer(orgPages[org] ?? [], n)),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadAllRepos', () => {
  it('walks pages until a short page and merges every source by full name', async () => {
    const spies = mockSources(
      [page('me', 100), page('me', 3, 100)],
      ['acme', 'globex'],
      { acme: [[repo('acme/a'), repo('me/r0')]], globex: [page('globex', 100), []] }
    );
    const repos = await loadAllRepos('ws1');
    expect(repos).toHaveLength(103 + 1 + 100);
    expect(new Set(names(repos)).size).toBe(repos.length);
    expect(spies.user.mock.calls.map((c) => c[1])).toEqual([1, 2]);
    expect(spies.org.mock.calls.filter((c) => c[1] === 'globex').map((c) => c[2])).toEqual([1, 2]);
    expect(spies.org.mock.calls.filter((c) => c[1] === 'acme').map((c) => c[2])).toEqual([1]);
  });

  it('reports a growing merged list after each page that adds repositories', async () => {
    mockSources([[repo('me/a')]], ['acme'], { acme: [[repo('acme/b')]] });
    const progress: string[][] = [];
    const repos = await loadAllRepos('ws1', { onProgress: (list) => progress.push(names(list)) });
    expect(progress).toHaveLength(2);
    expect(progress[0]).toHaveLength(1);
    expect(progress[1]).toEqual(['acme/b', 'me/a']);
    expect(names(repos)).toEqual(['acme/b', 'me/a']);
  });

  it('sends no progress for an empty page', async () => {
    mockSources([[]], []);
    const onProgress = vi.fn();
    await expect(loadAllRepos('ws1', { onProgress })).resolves.toEqual([]);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('stops at the 20-page cap', async () => {
    const spies = mockSources(
      Array.from({ length: 25 }, (_, i) => page('me', 100, i * 100)),
      []
    );
    const repos = await loadAllRepos('ws1');
    expect(spies.user).toHaveBeenCalledTimes(20);
    expect(repos).toHaveLength(2000);
  });

  it('reads at most four orgs at the same time', async () => {
    let open = 0;
    let peak = 0;
    vi.spyOn(github, 'listReposPage').mockResolvedValue([]);
    vi.spyOn(github, 'listOrgs').mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ login: `org${i}`, avatar_url: '' }))
    );
    const org = vi.spyOn(github, 'listOrgReposPage').mockImplementation(async (_ws, login) => {
      open++;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 1));
      open--;
      return [repo(`${login}/x`)];
    });
    const repos = await loadAllRepos('ws1');
    expect(repos).toHaveLength(10);
    expect(org).toHaveBeenCalledTimes(10);
    expect(peak).toBe(4);
  });

  type Pages = Array<GitHubRepo[] | Error>;
  it.each<[string, Pages, string[] | Error, Record<string, Pages>, string[]]>([
    ['the user list', [new Error('user')], ['acme'], { acme: [[repo('acme/a')]] }, ['acme/a']],
    ['one org', [[repo('me/a')]], ['acme', 'globex'], { acme: [new Error('acme')], globex: [[repo('globex/b')]] }, ['globex/b', 'me/a']],
    ['the org list', [[repo('me/a')]], new Error('orgs'), {}, ['me/a']],
    ['a later page', [page('me', 100), new Error('page 2')], [], {}, names(page('me', 100))],
  ])('keeps the other sources when %s fails', async (_label, user, orgs, orgPages, expected) => {
    mockSources(user, orgs, orgPages);
    expect(names(await loadAllRepos('ws1'))).toEqual(expected);
  });

  it('rejects with the first error when no source answers', async () => {
    const userError = new Error('user');
    mockSources([userError], ['acme'], { acme: [new Error('acme')] });
    await expect(loadAllRepos('ws1')).rejects.toBe(userError);
  });

  it('rejects when the user list fails and there are no orgs', async () => {
    mockSources([new Error('user')], new Error('orgs'));
    await expect(loadAllRepos('ws1')).rejects.toThrow('user');
  });

  it('stops requesting pages and sends no progress once cancelled', async () => {
    let cancelled = false;
    const spies = mockSources([page('me', 100), page('me', 100, 100)], []);
    spies.user.mockImplementation(async (_ws, n) => {
      cancelled = true;
      return page('me', 100, (n - 1) * 100);
    });
    const onProgress = vi.fn();
    await loadAllRepos('ws1', { onProgress, isCancelled: () => cancelled });
    expect(spies.user).toHaveBeenCalledTimes(1);
    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe('mergeRepos', () => {
  it('appends only the repositories the base does not hold', () => {
    const base = [repo('me/a'), repo('me/b')];
    expect(names(mergeRepos(base, [repo('me/b'), repo('me/c')]))).toEqual(['me/a', 'me/b', 'me/c']);
  });

  it('returns the same array when nothing is new', () => {
    const base = [repo('me/a')];
    expect(mergeRepos(base, [repo('me/a')])).toBe(base);
    expect(mergeRepos(base, [])).toBe(base);
  });

  it('returns the extra list for an empty base', () => {
    expect(names(mergeRepos([], [repo('me/a')]))).toEqual(['me/a']);
  });
});
