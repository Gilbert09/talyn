import type { ListSkillsResponse } from '@talyn/shared';
import {
  loadSkills,
  prefetchSkills,
  getCachedSkills,
  clearSkillsCache,
} from '../renderer/lib/skillsData';

const mockList = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: {
    skills: {
      list: (...args: unknown[]) => mockList(...args),
    },
  },
}));

const mockListLocal = jest.fn();
beforeAll(() => {
  (window as unknown as { electron: unknown }).electron = {
    skills: { listLocal: (...args: unknown[]) => mockListLocal(...args) },
  };
});

const backendResponse = (over: Partial<ListSkillsResponse> = {}): ListSkillsResponse => ({
  platform: [{ key: 'platform:1', source: 'platform', name: 'pr-review', description: '', id: '1' }],
  repo: [
    {
      key: 'repo:acme/w:lint',
      source: 'repo',
      name: 'lint',
      description: '',
      repositoryId: 'r1',
      repoPath: '.claude/skills/lint/SKILL.md',
    },
  ],
  repoStatus: 'ok',
  usage: {},
  ...over,
});

const localFile = {
  dirName: 'notes',
  path: '/x/SKILL.md',
  size: 10,
  mtimeMs: 0,
  content: '---\nname: notes\n---\nbody',
};

beforeEach(() => {
  clearSkillsCache();
  mockList.mockReset().mockResolvedValue(backendResponse());
  mockListLocal.mockReset().mockResolvedValue([localFile]);
});

describe('loadSkills', () => {
  it('merges repo + platform + local into one snapshot and caches it', async () => {
    const { snapshot, error } = await loadSkills('ws1', 'r1');
    expect(error).toBeNull();
    expect(snapshot.skills.map((s) => s.key)).toEqual([
      'repo:acme/w:lint',
      'platform:1',
      'local:notes',
    ]);
    expect(snapshot.localFiles).toEqual([localFile]);
    expect(getCachedSkills('ws1', 'r1')).toBe(snapshot);
  });

  it('keeps and returns the stale snapshot when the backend fails', async () => {
    const { snapshot: warm } = await loadSkills('ws1', 'r1');
    mockList.mockRejectedValue(new Error('offline'));
    const { snapshot, error } = await loadSkills('ws1', 'r1');
    expect(error).toBe('offline');
    expect(snapshot).toBe(warm); // not blanked
    expect(getCachedSkills('ws1', 'r1')).toBe(warm);
  });

  it('falls back to local-only (repoStatus error) on a cold backend failure', async () => {
    mockList.mockRejectedValue(new Error('offline'));
    const { snapshot, error } = await loadSkills('ws1', 'r1');
    expect(error).toBe('offline');
    expect(snapshot.repoStatus).toBe('error');
    expect(snapshot.skills.map((s) => s.key)).toEqual(['local:notes']);
    expect(getCachedSkills('ws1', 'r1')).toBeUndefined(); // failures are not cached
  });

  it('still loads backend skills when the local IPC listing fails', async () => {
    mockListLocal.mockRejectedValue(new Error('no fs'));
    const { snapshot, error } = await loadSkills('ws1', 'r1');
    expect(error).toBeNull();
    expect(snapshot.skills.map((s) => s.key)).toEqual(['repo:acme/w:lint', 'platform:1']);
  });
});

describe('prefetchSkills', () => {
  it('warms the cache for every watched repo', async () => {
    await prefetchSkills('ws1', ['r1', 'r2']);
    expect(getCachedSkills('ws1', 'r1')).toBeDefined();
    expect(getCachedSkills('ws1', 'r2')).toBeDefined();
    expect(mockList).toHaveBeenCalledWith('ws1', 'r1', undefined);
    expect(mockList).toHaveBeenCalledWith('ws1', 'r2', undefined);
  });

  it('warms a repo-less entry when the workspace has no repos', async () => {
    await prefetchSkills('ws1', []);
    expect(getCachedSkills('ws1', null)).toBeDefined();
    expect(mockList).toHaveBeenCalledWith('ws1', undefined, undefined);
  });

  it('does not reject when a repo prefetch fails', async () => {
    mockList.mockRejectedValue(new Error('boom'));
    await expect(prefetchSkills('ws1', ['r1'])).resolves.toBeUndefined();
  });
});
