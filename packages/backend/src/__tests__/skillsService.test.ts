import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SKILL_MAX_BYTES } from '@talyn/shared';
import {
  listRepoSkills,
  getRepoSkillContent,
  getSkillUsage,
  bumpSkillUsage,
  clearRepoSkillCache,
} from '../services/skills.js';
import { githubService } from '../services/github.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
} from '../db/schema.js';

vi.mock('../services/github.js', () => ({
  githubService: {
    getDirectoryListing: vi.fn(),
    getFileContent: vi.fn(),
  },
}));

const mockListing = vi.mocked(githubService.getDirectoryListing);
const mockContent = vi.mocked(githubService.getFileContent);

const SKILL_MD = '---\nname: reviewer\ndescription: Reviews PRs\n---\n\nReview carefully.';

function dirEntry(name: string, type: 'file' | 'dir' = 'dir', size = 0) {
  return { name, path: `.claude/skills/${name}`, type, size };
}

/** Wire the happy path: one skill dir `reviewer` with SKILL.md + a helper file. */
function mockHappyPath() {
  mockListing.mockImplementation(async (_ws, _o, _r, path) => {
    if (path === '.claude/skills') return [dirEntry('reviewer'), dirEntry('README.md', 'file')];
    if (path === '.claude/skills/reviewer') {
      return [
        { name: 'SKILL.md', path: '.claude/skills/reviewer/SKILL.md', type: 'file', size: 70 },
        { name: 'checklist.md', path: '.claude/skills/reviewer/checklist.md', type: 'file', size: 10 },
      ];
    }
    return null;
  });
  mockContent.mockResolvedValue({ content: SKILL_MD, size: SKILL_MD.length });
}

describe('skills service', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    clearRepoSkillCache();
    mockListing.mockReset();
    mockContent.mockReset();
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'acme/widgets',
      url: 'https://github.com/acme/widgets',
      defaultBranch: 'develop',
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  describe('listRepoSkills', () => {
    it('discovers skills with frontmatter metadata and supporting-files flag', async () => {
      mockHappyPath();
      const result = await listRepoSkills('ws1', 'repo1');
      expect(result.status).toBe('ok');
      expect(result.skills).toHaveLength(1);
      const skill = result.skills[0];
      expect(skill.name).toBe('reviewer');
      expect(skill.description).toBe('Reviews PRs');
      expect(skill.key).toBe('repo:acme/widgets:reviewer');
      expect(skill.repoPath).toBe('.claude/skills/reviewer/SKILL.md');
      expect(skill.hasSupportingFiles).toBe(true);
      expect(skill.content).toBe(SKILL_MD);
      // Discovery must use the repo's default branch as the ref.
      expect(mockListing).toHaveBeenCalledWith('ws1', 'acme', 'widgets', '.claude/skills', 'develop');
    });

    it('returns status none when the skills dir is missing (404)', async () => {
      mockListing.mockResolvedValue(null);
      const result = await listRepoSkills('ws1', 'repo1');
      expect(result.status).toBe('none');
      expect(result.skills).toEqual([]);
    });

    it('falls back to the directory name when frontmatter has no name', async () => {
      mockHappyPath();
      mockContent.mockResolvedValue({ content: 'no frontmatter here', size: 19 });
      const result = await listRepoSkills('ws1', 'repo1');
      expect(result.skills[0].name).toBe('reviewer');
      expect(result.skills[0].description).toBe('');
    });

    it('lists an oversized skill without content', async () => {
      mockHappyPath();
      mockContent.mockResolvedValue({ content: null, size: SKILL_MAX_BYTES + 1 });
      const result = await listRepoSkills('ws1', 'repo1');
      expect(result.skills[0].content).toBeNull();
      expect(result.skills[0].contentSize).toBe(SKILL_MAX_BYTES + 1);
    });

    it('skips dirs without a SKILL.md', async () => {
      mockListing.mockImplementation(async (_ws, _o, _r, path) => {
        if (path === '.claude/skills') return [dirEntry('empty-dir')];
        return [{ name: 'other.md', path: '.claude/skills/empty-dir/other.md', type: 'file', size: 5 }];
      });
      const result = await listRepoSkills('ws1', 'repo1');
      expect(result.status).toBe('ok');
      expect(result.skills).toEqual([]);
    });

    it('serves from cache within the TTL and re-fetches on refresh', async () => {
      mockHappyPath();
      await listRepoSkills('ws1', 'repo1');
      await listRepoSkills('ws1', 'repo1');
      // 2 listing calls for the first fetch (root + skill dir), none for the second.
      expect(mockListing).toHaveBeenCalledTimes(2);
      await listRepoSkills('ws1', 'repo1', { refresh: true });
      expect(mockListing).toHaveBeenCalledTimes(4);
    });

    it('serves the stale cache when GitHub errors after a good fetch', async () => {
      mockHappyPath();
      const first = await listRepoSkills('ws1', 'repo1');
      expect(first.status).toBe('ok');
      mockListing.mockRejectedValue(new Error('rate limited'));
      const second = await listRepoSkills('ws1', 'repo1', { refresh: true });
      expect(second.status).toBe('ok');
      expect(second.skills).toHaveLength(1);
    });

    it('returns error status when GitHub fails with no cache', async () => {
      mockListing.mockRejectedValue(new Error('boom'));
      const result = await listRepoSkills('ws1', 'repo1');
      expect(result.status).toBe('error');
      expect(result.skills).toEqual([]);
    });

    it('returns error for an unknown or cross-workspace repository', async () => {
      expect((await listRepoSkills('ws1', 'nope')).status).toBe('error');
      expect((await listRepoSkills('ws-other', 'repo1')).status).toBe('error');
    });
  });

  describe('getRepoSkillContent', () => {
    it('returns the cached skill by name', async () => {
      mockHappyPath();
      const skill = await getRepoSkillContent('ws1', 'repo1', 'reviewer');
      expect(skill?.content).toBe(SKILL_MD);
    });

    it('refreshes once when the name is not in a fresh listing', async () => {
      mockHappyPath();
      await listRepoSkills('ws1', 'repo1'); // warm the cache without "new-skill"
      expect(await getRepoSkillContent('ws1', 'repo1', 'new-skill')).toBeNull();
      // The miss must have forced a refresh fetch (2 initial + 2 refresh).
      expect(mockListing).toHaveBeenCalledTimes(4);
    });
  });

  describe('skill usage', () => {
    it('bumps a counter with upsert semantics and reads it back', async () => {
      await bumpSkillUsage('ws1', 'platform:abc');
      await bumpSkillUsage('ws1', 'platform:abc');
      await bumpSkillUsage('ws1', 'local:reviewer');
      const usage = await getSkillUsage('ws1');
      expect(usage['platform:abc'].count).toBe(2);
      expect(usage['local:reviewer'].count).toBe(1);
      expect(new Date(usage['platform:abc'].lastUsedAt).getTime()).toBeGreaterThan(0);
    });

    it('scopes usage to the workspace', async () => {
      await seedUser(db, { id: 'user-2' });
      await db.insert(workspacesTable).values({ id: 'ws2', ownerId: 'user-2', name: 'other', settings: {} });
      await bumpSkillUsage('ws1', 'platform:abc');
      await bumpSkillUsage('ws2', 'platform:abc');
      expect(Object.keys(await getSkillUsage('ws1'))).toEqual(['platform:abc']);
      expect((await getSkillUsage('ws1'))['platform:abc'].count).toBe(1);
    });
  });
});
