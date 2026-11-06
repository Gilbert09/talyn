import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { TeamMemberSource, TeamRole } from '@talyn/shared';
import { createTestDb } from './helpers/testDb.js';
import { teamMembers, teams, users, workspaces } from '../db/schema.js';

vi.mock('../services/githubIdentity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/githubIdentity.js')>()),
  ensureGithubUserId: async () => null,
}));

const {
  changeMemberRole,
  claimMemberships,
  createSpacesTeam,
  inviteMember,
  listMembers,
  listMyTeams,
  memberTeamIds,
  pickHomeWorkspace,
  removalRefusal,
  removeMember,
  renameSpacesTeam,
  resolveHomeWorkspace,
  roleChangeRefusal,
  setHomeWorkspace,
} = await import('../services/teams/membership.js');
const { TeamError, assignNamedSeats, createTeam, removeSeat } = await import('../services/billing/teams.js');

const ACCOUNTS: Record<string, { id: number; login: string }> = {
  bob: { id: 200, login: 'bob' },
  carol: { id: 300, login: 'carol' },
  newbie: { id: 900, login: 'newbie' },
};
const resolve = async (login: string) => {
  const hit = ACCOUNTS[login.toLowerCase()];
  return hit ? { ...hit, avatarUrl: null } : null;
};

async function refusal(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof TeamError) return { status: err.status, message: err.message };
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('pure role rules', () => {
  const owners = (n: number) => n;

  it.each<[string, { actorRole: TeamRole; targetRole: TeamRole; next: TeamRole; owners: number }, number | null]>([
    ['owner promotes a member to admin', { actorRole: 'owner', targetRole: 'member', next: 'admin', owners: owners(1) }, null],
    ['owner makes an admin an owner', { actorRole: 'owner', targetRole: 'admin', next: 'owner', owners: owners(1) }, null],
    ['admin promotes a member to admin', { actorRole: 'admin', targetRole: 'member', next: 'admin', owners: owners(1) }, null],
    ['admin demotes an admin', { actorRole: 'admin', targetRole: 'admin', next: 'member', owners: owners(1) }, null],
    ['admin cannot make an owner', { actorRole: 'admin', targetRole: 'member', next: 'owner', owners: owners(1) }, 403],
    ['admin cannot demote an owner', { actorRole: 'admin', targetRole: 'owner', next: 'member', owners: owners(2) }, 403],
    ['member cannot change roles', { actorRole: 'member', targetRole: 'member', next: 'admin', owners: owners(1) }, 403],
    ['the last owner cannot be demoted', { actorRole: 'owner', targetRole: 'owner', next: 'admin', owners: owners(1) }, 409],
    ['one of two owners can be demoted', { actorRole: 'owner', targetRole: 'owner', next: 'member', owners: owners(2) }, null],
    ['an owner kept as owner is a no-op', { actorRole: 'owner', targetRole: 'owner', next: 'owner', owners: owners(1) }, null],
  ])('role change: %s', (_name, input, status) => {
    expect(roleChangeRefusal(input)?.status ?? null).toBe(status);
  });

  it.each<[
    string,
    { actorRole: TeamRole; isSelf: boolean; targetRole: TeamRole; targetSource: TeamMemberSource; owners: number },
    number | null,
  ]>([
    ['member leaves', { actorRole: 'member', isSelf: true, targetRole: 'member', targetSource: 'invite', owners: 1 }, null],
    ['member removes another member', { actorRole: 'member', isSelf: false, targetRole: 'member', targetSource: 'invite', owners: 1 }, 403],
    ['admin removes a member', { actorRole: 'admin', isSelf: false, targetRole: 'member', targetSource: 'invite', owners: 1 }, null],
    ['admin removes an admin', { actorRole: 'admin', isSelf: false, targetRole: 'admin', targetSource: 'invite', owners: 1 }, null],
    ['admin removes an owner', { actorRole: 'admin', isSelf: false, targetRole: 'owner', targetSource: 'invite', owners: 2 }, 403],
    ['owner removes another owner', { actorRole: 'owner', isSelf: false, targetRole: 'owner', targetSource: 'invite', owners: 2 }, null],
    ['the last owner leaves', { actorRole: 'owner', isSelf: true, targetRole: 'owner', targetSource: 'invite', owners: 1 }, 409],
    ['one of two owners leaves', { actorRole: 'owner', isSelf: true, targetRole: 'owner', targetSource: 'invite', owners: 2 }, null],
    ['a seat holder is removed', { actorRole: 'owner', isSelf: false, targetRole: 'member', targetSource: 'seat', owners: 1 }, 409],
    ['a seat holder leaves', { actorRole: 'member', isSelf: true, targetRole: 'member', targetSource: 'seat', owners: 1 }, 409],
  ])('removal: %s', (_name, input, status) => {
    expect(removalRefusal(input)?.status ?? null).toBe(status);
  });

  it.each<[string | null, string[], string | null]>([
    ['ws-2', ['ws-1', 'ws-2'], 'ws-2'],
    [null, ['ws-1', 'ws-2'], 'ws-1'],
    ['ws-gone', ['ws-1'], 'ws-1'],
    [null, [], null],
    ['ws-gone', [], null],
  ])('home workspace: stored %s of %j is %s', (stored, owned, expected) => {
    expect(pickHomeWorkspace(stored, owned)).toBe(expected);
  });
});

describe('team membership service', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
    await testDb.db.insert(users).values([
      { id: 'u-alice', email: 'a@x.test', githubUserId: 100, githubUsername: 'alice' },
      { id: 'u-bob', email: 'b@x.test', githubUserId: 200, githubUsername: 'bob' },
      { id: 'u-carol', email: 'c@x.test', githubUserId: 300, githubUsername: 'carol' },
      { id: 'u-stranger', email: 's@x.test', githubUserId: 400, githubUsername: 'stranger' },
      { id: 'u-nogh', email: 'n@x.test' },
    ]);
    await testDb.db.insert(workspaces).values([
      { id: 'ws-alice-old', ownerId: 'u-alice', name: 'Old', createdAt: new Date('2026-01-01') },
      { id: 'ws-alice-new', ownerId: 'u-alice', name: 'New', createdAt: new Date('2026-06-01') },
      { id: 'ws-bob', ownerId: 'u-bob', name: 'Bob' },
    ]);
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  async function teamWithBob(role: TeamRole = 'member'): Promise<string> {
    const team = await createSpacesTeam('u-alice', 'Acme');
    await inviteMember(team.id, 'u-alice', 'bob', resolve);
    if (role !== 'member') {
      const bob = (await listMembers(team.id, 'u-alice')).find((m) => m.githubLogin === 'bob')!;
      await changeMemberRole(team.id, 'u-alice', bob.id, role);
    }
    return team.id;
  }

  const memberId = async (teamId: string, login: string) =>
    (await listMembers(teamId, 'u-alice')).find((m) => m.githubLogin === login)!.id;

  it('creates a free team with the caller as owner and their oldest workspace as home', async () => {
    const team = await createSpacesTeam('u-alice', '  Acme  ');
    expect(team).toMatchObject({ name: 'Acme', role: 'owner', homeWorkspaceId: 'ws-alice-old', spaces: [] });
    const [row] = await testDb.db.select({ plan: teams.plan }).from(teams).where(eq(teams.id, team.id));
    expect(row?.plan).toBe('none');
    expect(await listMembers(team.id, 'u-alice')).toEqual([
      expect.objectContaining({ githubLogin: 'alice', role: 'owner', source: 'invite', signedUp: true }),
    ]);
  });

  it.each([
    ['', 400],
    ['x'.repeat(81), 400],
  ])('refuses the team name %j', async (name, status) => {
    expect((await refusal(createSpacesTeam('u-alice', name))).status).toBe(status);
  });

  it('refuses to create a team for an account with no known GitHub id', async () => {
    expect((await refusal(createSpacesTeam('u-nogh', 'Acme'))).status).toBe(409);
  });

  it('invites by login and lists the invite for the invitee', async () => {
    const teamId = await teamWithBob();
    const teamsOfBob = await listMyTeams('u-bob');
    expect(teamsOfBob).toEqual([expect.objectContaining({ id: teamId, role: 'member', homeWorkspaceId: 'ws-bob' })]);
    expect(await memberTeamIds('u-bob')).toEqual([teamId]);
    expect(await memberTeamIds('u-stranger')).toEqual([]);
  });

  it.each([
    ['not a login', 'bad login!', 400],
    ['an unknown account', 'ghost', 404],
    ['an existing member', 'bob', 409],
  ])('refuses an invite of %s', async (_name, login, status) => {
    const teamId = await teamWithBob();
    expect((await refusal(inviteMember(teamId, 'u-alice', login, resolve))).status).toBe(status);
  });

  it.each([
    ['a plain member', 'u-bob', 403],
    ['a stranger', 'u-stranger', 404],
  ])('refuses an invite from %s', async (_name, actor, status) => {
    const teamId = await teamWithBob();
    expect((await refusal(inviteMember(teamId, actor, 'carol', resolve))).status).toBe(status);
  });

  it('lets an admin invite', async () => {
    const teamId = await teamWithBob('admin');
    await inviteMember(teamId, 'u-bob', 'carol', resolve);
    expect((await listMembers(teamId, 'u-bob')).map((m) => m.githubLogin)).toEqual(['alice', 'bob', 'carol']);
  });

  it('claims an invite for a person who signs up later', async () => {
    const team = await createSpacesTeam('u-alice', 'Acme');
    await inviteMember(team.id, 'u-alice', 'newbie', resolve);
    const [before] = await testDb.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(eq(teamMembers.githubUserId, 900));
    expect(before?.userId).toBeNull();
    expect((await listMembers(team.id, 'u-alice')).find((m) => m.githubLogin === 'newbie')?.signedUp).toBe(false);

    await testDb.db.insert(users).values({ id: 'u-newbie', email: 'nb@x.test', githubUserId: 900, githubUsername: 'newbie' });
    expect(await listMyTeams('u-newbie')).toEqual([expect.objectContaining({ id: team.id, role: 'member' })]);
    const [after] = await testDb.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(eq(teamMembers.githubUserId, 900));
    expect(after?.userId).toBe('u-newbie');
  });

  it('never lets a second account take a row another account claimed', async () => {
    const teamId = await teamWithBob();
    await testDb.db.insert(users).values({ id: 'u-bob-dup', email: 'bd@x.test', githubUserId: 200 });
    await claimMemberships('u-bob-dup', 200);
    expect(await memberTeamIds('u-bob-dup')).toEqual([]);
    expect(await memberTeamIds('u-bob')).toEqual([teamId]);
  });

  it('keeps one owner: the last owner cannot step down or leave', async () => {
    const team = await createSpacesTeam('u-alice', 'Acme');
    const aliceId = await memberId(team.id, 'alice');
    expect((await refusal(changeMemberRole(team.id, 'u-alice', aliceId, 'member'))).status).toBe(409);
    expect((await refusal(removeMember(team.id, 'u-alice', aliceId))).status).toBe(409);
  });

  it('lets an owner hand over ownership and then leave', async () => {
    const teamId = await teamWithBob();
    const bobId = await memberId(teamId, 'bob');
    expect((await changeMemberRole(teamId, 'u-alice', bobId, 'owner')).role).toBe('owner');
    await removeMember(teamId, 'u-alice', await memberId(teamId, 'alice'));
    expect(await memberTeamIds('u-alice')).toEqual([]);
    expect((await listMembers(teamId, 'u-bob')).map((m) => [m.githubLogin, m.role])).toEqual([['bob', 'owner']]);
  });

  it('refuses an unknown role', async () => {
    const teamId = await teamWithBob();
    expect((await refusal(changeMemberRole(teamId, 'u-alice', await memberId(teamId, 'bob'), 'king'))).status).toBe(400);
  });

  it('lets a member leave, and refuses them removing someone else', async () => {
    const teamId = await teamWithBob();
    await inviteMember(teamId, 'u-alice', 'carol', resolve);
    const carolId = await memberId(teamId, 'carol');
    expect((await refusal(removeMember(teamId, 'u-bob', carolId))).status).toBe(403);
    await removeMember(teamId, 'u-bob', await memberId(teamId, 'bob'));
    expect(await memberTeamIds('u-bob')).toEqual([]);
  });

  it('renames for managers only', async () => {
    const teamId = await teamWithBob();
    expect((await refusal(renameSpacesTeam(teamId, 'u-bob', 'Nope'))).status).toBe(403);
    await renameSpacesTeam(teamId, 'u-alice', 'Acme 2');
    expect((await listMyTeams('u-bob'))[0]?.name).toBe('Acme 2');
  });

  it('sets a home workspace the caller owns, and only that', async () => {
    const team = await createSpacesTeam('u-alice', 'Acme');
    expect(await resolveHomeWorkspace(team.id, 'u-alice')).toBe('ws-alice-old');
    await setHomeWorkspace(team.id, 'u-alice', 'ws-alice-new');
    expect(await resolveHomeWorkspace(team.id, 'u-alice')).toBe('ws-alice-new');
    expect((await refusal(setHomeWorkspace(team.id, 'u-alice', 'ws-bob'))).status).toBe(404);
    expect((await refusal(setHomeWorkspace(team.id, 'u-stranger', 'ws-bob'))).status).toBe(404);
    // A deleted home falls back to the oldest workspace.
    await testDb.db.delete(workspaces).where(eq(workspaces.id, 'ws-alice-new'));
    expect(await resolveHomeWorkspace(team.id, 'u-alice')).toBe('ws-alice-old');
  });

  describe('seat sync with the billing team', () => {
    async function paidTeam(): Promise<string> {
      const { id } = await createTeam('u-alice', 'Paid');
      await testDb.db.update(teams).set({ plan: 'team', seatsPurchased: 5 }).where(eq(teams.id, id));
      return id;
    }

    async function memberRow(teamId: string, githubUserId: number) {
      const [row] = await testDb.db
        .select({ role: teamMembers.role, source: teamMembers.source })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.githubUserId, githubUserId)));
      return row ?? null;
    }

    it('makes the billing team creator its owner', async () => {
      const teamId = await paidTeam();
      expect(await memberRow(teamId, 100)).toEqual({ role: 'owner', source: 'invite' });
    });

    it('adds a seat holder as a seat member, and removes them with the seat', async () => {
      const teamId = await paidTeam();
      const result = await assignNamedSeats(teamId, 'u-alice', ['carol'], resolve);
      expect(await memberRow(teamId, 300)).toEqual({ role: 'member', source: 'seat' });
      await removeSeat(teamId, result.assigned[0]!.id);
      expect(await memberRow(teamId, 300)).toBeNull();
    });

    it('keeps an invited member when their seat comes and goes', async () => {
      const teamId = await paidTeam();
      await inviteMember(teamId, 'u-alice', 'carol', resolve);
      const result = await assignNamedSeats(teamId, 'u-alice', ['carol'], resolve);
      expect(await memberRow(teamId, 300)).toEqual({ role: 'member', source: 'invite' });
      await removeSeat(teamId, result.assigned[0]!.id);
      expect(await memberRow(teamId, 300)).toEqual({ role: 'member', source: 'invite' });
    });

    it('keeps an admin whose seat goes, as an invited admin', async () => {
      const teamId = await paidTeam();
      const result = await assignNamedSeats(teamId, 'u-alice', ['bob'], resolve);
      await changeMemberRole(teamId, 'u-alice', await memberId(teamId, 'bob'), 'admin');
      await removeSeat(teamId, result.assigned[0]!.id);
      expect(await memberRow(teamId, 200)).toEqual({ role: 'admin', source: 'invite' });
    });
  });
});
