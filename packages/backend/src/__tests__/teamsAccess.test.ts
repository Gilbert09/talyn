import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { spaces, teamMembers, teams, users, workspaces } from '../db/schema.js';

vi.mock('../services/githubIdentity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/githubIdentity.js')>()),
  ensureGithubUserId: async () => null,
}));

const { canUserReadRepo, canViewItem, createViewer, filterViewable, resetRepoReadCacheForTests, assertSpaceMember, spacesFor } =
  await import('../services/teams/access.js');
const { githubService } = await import('../services/github.js');
const { TeamError } = await import('../services/billing/teams.js');
type AccessDeps = import('../services/teams/access.js').AccessDeps;
type ViewableItem = import('../services/teams/access.js').ViewableItem;

/**
 * The world for the pure checks: Ana owns ws-ana and is in team-1. Ben owns
 * ws-ben and is in team-1. Cy is in team-2 only. Ben's GitHub account cannot
 * read acme/secret.
 */
function fakeDeps(overrides: Partial<AccessDeps> = {}) {
  const canReadRepo = vi.fn(async (userId: string, _teamId: string, repo: string) =>
    !(userId === 'ben' && repo === 'acme/secret')
  );
  const deps: AccessDeps = {
    ownedWorkspaceIds: async (userId) => new Set({ ana: ['ws-ana'], ben: ['ws-ben'], cy: ['ws-cy'] }[userId] ?? []),
    memberTeamIds: async (userId) => ({ ana: ['team-1'], ben: ['team-1'], cy: ['team-2'] }[userId] ?? []),
    spaceTeams: async (ids) => new Map(ids.filter((id) => id in SPACE_TEAMS).map((id) => [id, SPACE_TEAMS[id]!])),
    canReadRepo,
    ...overrides,
  };
  return { deps, canReadRepo };
}
const SPACE_TEAMS: Record<string, string> = { 'space-1': 'team-1', 'space-2': 'team-2' };

const item = (overrides: Partial<ViewableItem> = {}): ViewableItem => ({
  workspaceId: 'ws-ana',
  spaceId: 'space-1',
  repoFullName: 'acme/app',
  ...overrides,
});

describe('canViewItem', () => {
  it.each<[string, string, ViewableItem, boolean]>([
    ['the owner, in a space', 'ana', item(), true],
    ['the owner, in Personal', 'ana', item({ spaceId: null }), true],
    ['the owner, on a repo they cannot read as a member', 'ana', item({ repoFullName: 'acme/secret' }), true],
    ['a team member who can read the repo', 'ben', item(), true],
    ['a team member who cannot read the repo', 'ben', item({ repoFullName: 'acme/secret' }), false],
    ['a team member, on an item in Personal', 'ben', item({ spaceId: null }), false],
    ['a team member, on an item with no repo', 'ben', item({ repoFullName: null }), false],
    ['a member of another team', 'cy', item(), false],
    ['a member of the item team, on a space of another team', 'ben', item({ spaceId: 'space-2' }), false],
    ['anyone, on a space that does not exist', 'ben', item({ spaceId: 'space-gone' }), false],
    ['a person in no team', 'dee', item(), false],
    ['a removed member', 'ben-removed', item(), false],
  ])('%s', async (_name, userId, target, expected) => {
    const { deps } = fakeDeps();
    expect(await canViewItem(userId, target, deps)).toBe(expected);
  });

  it('checks each repository once per viewer, and skips the check for the owner', async () => {
    const { deps, canReadRepo } = fakeDeps();
    const view = createViewer('ben', deps);
    await view(item());
    await view(item({ workspaceId: 'ws-other' }));
    await view(item({ repoFullName: 'ACME/APP' }));
    await view(item({ repoFullName: 'acme/other' }));
    expect(canReadRepo).toHaveBeenCalledTimes(2);
    await createViewer('ana', deps)(item());
    expect(canReadRepo).toHaveBeenCalledTimes(2);
  });

  it('counts the items a viewer cannot see', async () => {
    const { deps } = fakeDeps();
    const items = [item(), item({ repoFullName: 'acme/secret' }), item({ spaceId: 'space-2' }), item({ workspaceId: 'ws-ben' })];
    const result = await filterViewable('ben', items, deps);
    expect(result.visible).toEqual([items[0], items[3]]);
    expect(result.hiddenCount).toBe(2);
  });
});

describe('the repository read check and space membership', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    resetRepoReadCacheForTests();
    testDb = await createTestDb();
    await testDb.db.insert(users).values([
      { id: 'u-ana', email: 'a@x.test', githubUserId: 100, githubUsername: 'ana' },
      { id: 'u-ben', email: 'b@x.test', githubUserId: 200, githubUsername: 'ben' },
      { id: 'u-cy', email: 'c@x.test', githubUserId: 300, githubUsername: 'cy' },
    ]);
    await testDb.db.insert(workspaces).values([
      { id: 'ws-ana', ownerId: 'u-ana', name: 'A' },
      { id: 'ws-ben', ownerId: 'u-ben', name: 'B' },
    ]);
    await testDb.db.insert(teams).values([{ id: 'team-1', name: 'One' }, { id: 'team-2', name: 'Two' }]);
    await testDb.db.insert(teamMembers).values([
      { id: 'm-ana', teamId: 'team-1', githubUserId: 100, userId: 'u-ana', githubLogin: 'ana', role: 'owner' },
      { id: 'm-ben', teamId: 'team-1', githubUserId: 200, githubLogin: 'ben', homeWorkspaceId: 'ws-ben' },
      { id: 'm-cy', teamId: 'team-2', githubUserId: 300, userId: 'u-cy', githubLogin: 'cy', role: 'owner' },
    ]);
    await testDb.db.insert(spaces).values([
      { id: 'space-1', teamId: 'team-1', name: 'Web' },
      { id: 'space-old', teamId: 'team-1', name: 'Old', archivedAt: new Date() },
      { id: 'space-2', teamId: 'team-2', name: 'Other' },
    ]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await testDb.cleanup();
  });

  it('asks GitHub through the member home workspace and caches the answer', async () => {
    const check = vi.spyOn(githubService, 'canAccessRepository').mockResolvedValue(true);
    expect(await canUserReadRepo('u-ben', 'team-1', 'acme/app')).toBe(true);
    expect(await canUserReadRepo('u-ben', 'team-1', 'Acme/App')).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith('ws-ben', 'acme', 'app');
  });

  it('caches a refusal, and does not cache a GitHub fault', async () => {
    const check = vi.spyOn(githubService, 'canAccessRepository').mockRejectedValueOnce(new Error('boom')).mockResolvedValue(false);
    expect(await canUserReadRepo('u-ben', 'team-1', 'acme/app')).toBe(false);
    expect(await canUserReadRepo('u-ben', 'team-1', 'acme/app')).toBe(false);
    expect(await canUserReadRepo('u-ben', 'team-1', 'acme/app')).toBe(false);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a malformed name', 'u-ben', 'team-1', 'not-a-repo'],
    ['a person who is not a member', 'u-cy', 'team-1', 'acme/app'],
  ])('answers no without GitHub for %s', async (_name, userId, teamId, repo) => {
    const check = vi.spyOn(githubService, 'canAccessRepository').mockResolvedValue(true);
    expect(await canUserReadRepo(userId, teamId, repo)).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it('lists the live spaces of the user teams, claimed or not', async () => {
    expect((await spacesFor('u-ben')).map((s) => s.id)).toEqual(['space-1']);
    expect((await spacesFor('u-cy')).map((s) => s.id)).toEqual(['space-2']);
  });

  it.each([
    ['u-ben', 'space-1', true],
    ['u-ben', 'space-old', true],
    ['u-ben', 'space-2', false],
    ['u-cy', 'space-1', false],
    ['u-ana', 'space-gone', false],
  ])('assertSpaceMember(%s, %s) allows: %s', async (userId, spaceId, allowed) => {
    if (allowed) {
      expect((await assertSpaceMember(userId, spaceId)).id).toBe(spaceId);
    } else {
      await expect(assertSpaceMember(userId, spaceId)).rejects.toThrow(TeamError);
    }
  });
});
