import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  billingEvents as billingEventsTable,
  tasks as tasksTable,
  teamAdmins as teamAdminsTable,
  teamSeats as teamSeatsTable,
  teams as teamsTable,
  users as usersTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import * as websocketModule from '../services/websocket.js';
import {
  buildBillingStatus,
  deriveEntitlement,
  entitlementQuery,
  FREE_ACTIVE_TASK_LIMIT,
  resolveEntitlement,
  teamGrantsSeats,
  withTaskLimitGate,
} from '../services/billing/entitlements.js';
import {
  addTeamAdmin,
  assertTeamAdmin,
  assertTeamCanCheckout,
  assignNamedSeats,
  createTeam,
  getTeamDetail,
  isValidGithubLogin,
  leaveTeam,
  normaliseGithubLogin,
  prepareSeatCountChange,
  removeSeat,
  removeTeamAdmin,
  soleAdminOfPayingTeam,
  TeamError,
  type ResolveGithubAccount,
} from '../services/billing/teams.js';
import {
  seatTiersFromPrices,
  teamCustomerExternalId,
  teamIdFromCustomerExternalId,
} from '../services/billing/polar.js';
import {
  githubUserIdFromIdentities,
  parseGithubUserId,
} from '../services/githubIdentity.js';
import { validateEnv } from '../services/validateEnv.js';

vi.mock('@polar-sh/sdk/webhooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@polar-sh/sdk/webhooks')>();
  return {
    ...actual,
    validateEvent: (body: Buffer) => JSON.parse(body.toString('utf-8')),
  };
});

const { handlePolarWebhook, applySubscriptionEvent, isTeamSubscription } = await import(
  '../services/billing/webhook.js'
);

const POLAR_ENV = {
  POLAR_ACCESS_TOKEN: 'polar-test-token',
  POLAR_WEBHOOK_SECRET: 'whsec_test',
  POLAR_ENVIRONMENT: 'sandbox',
  POLAR_PRODUCT_ID_MONTHLY: 'prod-monthly',
  POLAR_PRODUCT_ID_ANNUAL: 'prod-annual',
  POLAR_PRODUCT_ID_TEAM_MONTHLY: 'prod-team-monthly',
  POLAR_PRODUCT_ID_TEAM_ANNUAL: 'prod-team-annual',
} as const;
const savedEnv: Record<string, string | undefined> = {};

const BUYER = TEST_USER_ID;
const BUYER_GH = 1001;
const MEMBER = 'user-member';
const MEMBER_GH = 2002;
const STRANGER = 'user-stranger';

let db: Database;
let cleanup: () => Promise<void>;

/** GitHub stand-in: login → account, lower-cased; unknown logins resolve to null. */
const ACCOUNTS: Record<string, { id: number; login: string }> = {
  buyer: { id: BUYER_GH, login: 'buyer' },
  member: { id: MEMBER_GH, login: 'member' },
  carol: { id: 3003, login: 'carol' },
  dave: { id: 4004, login: 'dave' },
  erin: { id: 5005, login: 'erin' },
};
const resolve: ResolveGithubAccount = async (login) => {
  const hit = ACCOUNTS[login.toLowerCase()];
  return hit ? { ...hit, avatarUrl: null } : null;
};

async function makeTeam(opts: { seats?: number; plan?: 'team' | 'none' } = {}): Promise<string> {
  const { id } = await createTeam(BUYER, 'Acme');
  await db
    .update(teamsTable)
    .set({ seatsPurchased: opts.seats ?? 3, plan: opts.plan ?? 'team', polarSubscriptionId: 'sub-t' })
    .where(eq(teamsTable.id, id));
  return id;
}

function teamSub(teamId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-team-1',
    status: 'active',
    seats: 5,
    productId: 'prod-team-monthly',
    currentPeriodEnd: '2026-11-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    customerId: 'cust-team',
    customer: { id: 'cust-team', externalId: teamCustomerExternalId(teamId) },
    ...overrides,
  };
}

async function teamRow(teamId: string) {
  const [row] = await db.select().from(teamsTable).where(eq(teamsTable.id, teamId));
  return row!;
}

async function userRow(id: string) {
  const [row] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  return row!;
}

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  for (const [k, v] of Object.entries(POLAR_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  await seedUser(db, { id: BUYER });
  await seedUser(db, { id: MEMBER });
  await seedUser(db, { id: STRANGER });
  await db.update(usersTable).set({ githubUserId: BUYER_GH, githubUsername: 'buyer' }).where(eq(usersTable.id, BUYER));
  await db.update(usersTable).set({ githubUserId: MEMBER_GH, githubUsername: 'member' }).where(eq(usersTable.id, MEMBER));
});

afterEach(async () => {
  for (const k of Object.keys(POLAR_ENV)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await cleanup();
  vi.restoreAllMocks();
});

describe('entitlement derivation', () => {
  it.each([
    [{ plan: 'team', planOverride: null }, true],
    [{ plan: 'none', planOverride: null }, false],
    [{ plan: 'none', planOverride: 'team' }, true],
    [{ plan: 'team', planOverride: 'none' }, false],
    [null, false],
    [undefined, false],
  ])('teamGrantsSeats(%j) → %s', (team, expected) => {
    expect(teamGrantsSeats(team)).toBe(expected);
  });

  const PAID_TEAM = { plan: 'team', planOverride: null };
  const LAPSED_TEAM = { plan: 'none', planOverride: null };

  it.each([
    // user override wins over everything, in both directions
    ['user override free beats a paid seat', { plan: 'free', planOverride: 'free' }, PAID_TEAM, 'free', 'override'],
    ['user override unlimited', { plan: 'free', planOverride: 'unlimited' }, LAPSED_TEAM, 'unlimited', 'override'],
    // a personal subscription reads as the subscription, seat or not
    ['personal subscription and a seat', { plan: 'unlimited', planOverride: null }, PAID_TEAM, 'unlimited', 'subscription'],
    ['personal subscription, no team', { plan: 'unlimited', planOverride: null }, null, 'unlimited', 'subscription'],
    // the team
    ['paid seat', { plan: 'free', planOverride: null }, PAID_TEAM, 'unlimited', 'team'],
    ['comped team', { plan: 'free', planOverride: null }, { plan: 'none', planOverride: 'team' }, 'unlimited', 'team'],
    ['lapsed team', { plan: 'free', planOverride: null }, LAPSED_TEAM, 'free', 'default'],
    ['team blocked by override', { plan: 'free', planOverride: null }, { plan: 'team', planOverride: 'none' }, 'free', 'default'],
    ['no team', { plan: 'free', planOverride: null }, null, 'free', 'default'],
  ] as const)('%s', (_name, user, team, plan, source) => {
    expect(deriveEntitlement(user, team)).toEqual({ plan, source });
  });

  it('a missing user row is free whatever the team says', () => {
    expect(deriveEntitlement(undefined, PAID_TEAM)).toEqual({ plan: 'free', source: 'default' });
  });
});

describe('resolveEntitlement with seats', () => {
  it('a seated member of a paid team is unlimited through the team', async () => {
    const teamId = await makeTeam();
    await assignNamedSeats(teamId, BUYER, ['member'], resolve);
    expect(await resolveEntitlement(MEMBER)).toEqual({ plan: 'unlimited', source: 'team' });
  });

  it('a seat on a lapsed team gives nothing', async () => {
    const teamId = await makeTeam();
    await assignNamedSeats(teamId, BUYER, ['member'], resolve);
    await db.update(teamsTable).set({ plan: 'none' }).where(eq(teamsTable.id, teamId));
    expect(await resolveEntitlement(MEMBER)).toEqual({ plan: 'free', source: 'default' });
  });

  it('an account with no GitHub id yet matches no seat', async () => {
    const teamId = await makeTeam();
    await assignNamedSeats(teamId, BUYER, ['member'], resolve);
    await db.update(usersTable).set({ githubUserId: null }).where(eq(usersTable.id, MEMBER));
    expect(await resolveEntitlement(MEMBER)).toEqual({ plan: 'free', source: 'default' });
  });

  it('a stranger is untouched by somebody else’s team', async () => {
    await makeTeam();
    expect(await resolveEntitlement(STRANGER)).toEqual({ plan: 'free', source: 'default' });
  });

  it('lets a seated member past the free task limit', async () => {
    const teamId = await makeTeam();
    await assignNamedSeats(teamId, BUYER, ['member'], resolve);
    await db.insert(workspacesTable).values({ id: 'ws-m', ownerId: MEMBER, name: 'M' });
    for (let i = 0; i < FREE_ACTIVE_TASK_LIMIT; i++) {
      await db.insert(tasksTable).values({
        id: `t-${i}`,
        workspaceId: 'ws-m',
        type: 'code_writing',
        status: 'in_progress',
        title: 't',
        description: 'd',
      });
    }
    await expect(withTaskLimitGate(MEMBER, {}, async () => 'ran')).resolves.toBe('ran');
    // …and the moment the seat goes, the limit is back.
    const [seat] = await db.select().from(teamSeatsTable).where(eq(teamSeatsTable.githubUserId, MEMBER_GH));
    await removeSeat(teamId, seat!.id);
    await expect(withTaskLimitGate(MEMBER, {}, async () => 'ran')).rejects.toThrow();
  });

  it('entitlementQuery selects only the four plan columns', () => {
    const { sql } = entitlementQuery('owner-1').toSQL();
    expect(sql).toContain('"team_seats"');
    for (const blob of ['"email"', '"seats_purchased"', '"github_login"', '"polar_customer_id"']) {
      expect(sql).not.toContain(blob);
    }
  });
});

describe('billing status', () => {
  it('names the team for a seated member and flags a second personal payment', async () => {
    const teamId = await makeTeam();
    await assignNamedSeats(teamId, BUYER, ['member'], resolve);
    await db.update(usersTable).set({ plan: 'unlimited' }).where(eq(usersTable.id, MEMBER));
    const status = await buildBillingStatus(MEMBER);
    expect(status.planSource).toBe('subscription');
    expect(status.team).toEqual({
      id: teamId,
      name: 'Acme',
      isAdmin: false,
      hasSeat: true,
      seatSource: 'named',
      active: true,
      paidPersonallyToo: true,
    });
  });

  it('shows an admin without a seat as an admin who is still on the free plan', async () => {
    const teamId = await makeTeam();
    const status = await buildBillingStatus(BUYER);
    expect(status.plan).toBe('free');
    expect(status.team).toMatchObject({ id: teamId, isAdmin: true, hasSeat: false, paidPersonallyToo: false });
  });

  it('has no team field for somebody with neither a seat nor a team', async () => {
    expect((await buildBillingStatus(STRANGER)).team).toBeUndefined();
  });
});

describe('seat assignment', () => {
  it('assigns by login, dedupes, and reports each bad login beside the good ones', async () => {
    const teamId = await makeTeam({ seats: 3 });
    const result = await assignNamedSeats(
      teamId,
      BUYER,
      ['@member', 'MEMBER', 'carol', 'nobody-here', 'bad--login', '  '],
      resolve
    );
    expect(result.assigned.map((s) => s.githubLogin).sort()).toEqual(['carol', 'member']);
    expect(result.assigned.find((s) => s.githubLogin === 'member')?.signedUp).toBe(true);
    expect(result.assigned.find((s) => s.githubLogin === 'carol')?.signedUp).toBe(false);
    expect(result.failed).toEqual([
      { login: 'nobody-here', reason: 'No GitHub user has this username.' },
      { login: 'bad--login', reason: 'Not a valid GitHub username.' },
    ]);
  });

  it('refuses the whole request when it would exceed the seats paid for', async () => {
    const teamId = await makeTeam({ seats: 2 });
    await assignNamedSeats(teamId, BUYER, ['member'], resolve);
    const err = await assignNamedSeats(teamId, BUYER, ['carol', 'dave'], resolve).catch((e) => e);
    expect(err).toBeInstanceOf(TeamError);
    expect(err.code).toBe('team_seats_full');
    expect((await getTeamDetail(teamId)).seatsUsed).toBe(1);
  });

  it('refuses a team with no seats paid for yet', async () => {
    const teamId = await makeTeam({ seats: 0, plan: 'none' });
    await expect(assignNamedSeats(teamId, BUYER, ['member'], resolve)).rejects.toMatchObject({
      code: 'team_seats_full',
    });
  });

  it('refuses additions while over-allocated, and says by how many', async () => {
    const teamId = await makeTeam({ seats: 3 });
    await assignNamedSeats(teamId, BUYER, ['member', 'carol', 'dave'], resolve);
    await db.update(teamsTable).set({ seatsPurchased: 2 }).where(eq(teamsTable.id, teamId));
    const detail = await getTeamDetail(teamId);
    expect(detail.overAllocated).toBe(true);
    await expect(assignNamedSeats(teamId, BUYER, ['erin'], resolve)).rejects.toMatchObject({
      code: 'team_over_allocated',
      message: expect.stringContaining('Remove 1'),
    });
  });

  it('one team per person: a seat elsewhere is reported, not moved', async () => {
    const first = await makeTeam({ seats: 3 });
    await assignNamedSeats(first, BUYER, ['member'], resolve);
    await seedUser(db, { id: 'other-admin' });
    const { id: second } = await createTeam('other-admin', 'Other');
    await db.update(teamsTable).set({ seatsPurchased: 3, plan: 'team' }).where(eq(teamsTable.id, second));

    const result = await assignNamedSeats(second, 'other-admin', ['member'], resolve);
    expect(result.assigned).toEqual([]);
    expect(result.failed).toEqual([{ login: 'member', reason: 'Already has a seat on another team.' }]);
    const again = await assignNamedSeats(first, BUYER, ['member'], resolve);
    expect(again.failed).toEqual([{ login: 'member', reason: 'Already has a seat on this team.' }]);
  });

  it('a member can leave, and then has nothing to leave', async () => {
    const teamId = await makeTeam();
    await assignNamedSeats(teamId, BUYER, ['member'], resolve);
    await leaveTeam(MEMBER);
    expect((await getTeamDetail(teamId)).seatsUsed).toBe(0);
    await expect(leaveTeam(MEMBER)).rejects.toMatchObject({ status: 404 });
  });

  it('removeSeat only removes a seat of THIS team', async () => {
    const teamId = await makeTeam();
    const { assigned } = await assignNamedSeats(teamId, BUYER, ['member'], resolve);
    await expect(removeSeat('another-team', assigned[0]!.id)).rejects.toMatchObject({ status: 404 });
    await removeSeat(teamId, assigned[0]!.id);
    expect((await getTeamDetail(teamId)).seats).toEqual([]);
  });

  it.each([
    ['octocat', true],
    ['a', true],
    ['a-b-c', true],
    ['-leading', false],
    ['trailing-', false],
    ['double--hyphen', false],
    ['has space', false],
    ['https://github.com/octocat', false],
    ['x'.repeat(39), true],
    ['x'.repeat(40), false],
  ])('isValidGithubLogin(%j) → %s', (login, expected) => {
    expect(isValidGithubLogin(login)).toBe(expected);
  });

  it('normalises a typed login', () => {
    expect(normaliseGithubLogin('  @octocat ')).toBe('octocat');
  });
});

describe('team administration', () => {
  it('one team per admin', async () => {
    await createTeam(BUYER, 'Acme');
    await expect(createTeam(BUYER, 'Again')).rejects.toMatchObject({ status: 409 });
  });

  it.each([
    ['', 400],
    ['   ', 400],
    ['x'.repeat(81), 400],
  ])('refuses the team name %j', async (name, status) => {
    await expect(createTeam(BUYER, name)).rejects.toMatchObject({ status });
  });

  it('a non-admin gets 404, not 403', async () => {
    const teamId = await makeTeam();
    await expect(assertTeamAdmin(teamId, STRANGER)).rejects.toMatchObject({ status: 404 });
    await expect(assertTeamAdmin(teamId, BUYER)).resolves.toBeUndefined();
  });

  it('adds an admin by login only when that person has signed in', async () => {
    const teamId = await makeTeam();
    await expect(addTeamAdmin(teamId, 'carol')).rejects.toMatchObject({ status: 404 });
    await addTeamAdmin(teamId, '@member');
    expect((await getTeamDetail(teamId)).admins.map((a) => a.userId).sort()).toEqual([BUYER, MEMBER].sort());
  });

  it('never removes the last admin', async () => {
    const teamId = await makeTeam();
    await expect(removeTeamAdmin(teamId, BUYER)).rejects.toMatchObject({ status: 409 });
    await addTeamAdmin(teamId, 'member');
    await removeTeamAdmin(teamId, BUYER);
    expect((await getTeamDetail(teamId)).admins.map((a) => a.userId)).toEqual([MEMBER]);
  });

  it('flags the sole admin of a PAYING team, and only that', async () => {
    const teamId = await makeTeam({ plan: 'team' });
    expect(await soleAdminOfPayingTeam(BUYER)).toEqual({ id: teamId, name: 'Acme' });
    await addTeamAdmin(teamId, 'member');
    expect(await soleAdminOfPayingTeam(BUYER)).toBeNull();
    await removeTeamAdmin(teamId, MEMBER);
    await db.update(teamsTable).set({ plan: 'none' }).where(eq(teamsTable.id, teamId));
    expect(await soleAdminOfPayingTeam(BUYER)).toBeNull();
  });

  it.each([
    [1, 400],
    [2.5, 400],
    [Number.NaN, 400],
  ])('refuses a seat count of %s', async (seats, status) => {
    const teamId = await makeTeam();
    await expect(prepareSeatCountChange(teamId, seats)).rejects.toMatchObject({ status });
  });

  it('refuses going below the seats assigned, and allows it at the line', async () => {
    const teamId = await makeTeam({ seats: 5 });
    await assignNamedSeats(teamId, BUYER, ['member', 'carol', 'dave'], resolve);
    await expect(prepareSeatCountChange(teamId, 2)).rejects.toMatchObject({
      code: 'team_over_allocated',
    });
    await expect(prepareSeatCountChange(teamId, 3)).resolves.toBe('sub-t');
  });

  it('refuses a seat change with no live subscription', async () => {
    const teamId = await makeTeam({ plan: 'none' });
    await expect(prepareSeatCountChange(teamId, 4)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a second checkout for a team that already pays', async () => {
    const paying = await makeTeam({ plan: 'team' });
    await expect(assertTeamCanCheckout(paying, 3)).rejects.toMatchObject({ status: 409 });
    await db.update(teamsTable).set({ plan: 'none' }).where(eq(teamsTable.id, paying));
    await expect(assertTeamCanCheckout(paying, 3)).resolves.toBeUndefined();
    await expect(assertTeamCanCheckout(paying, 1)).rejects.toMatchObject({ status: 400 });
  });
});

describe('team subscription webhook', () => {
  it.each([
    { external: 'team', productId: 'prod-other', expected: true },
    { external: 'user', productId: 'prod-team-annual', expected: true },
    { external: 'user', productId: 'prod-monthly', expected: false },
    { external: 'none', productId: undefined, expected: false },
  ])('isTeamSubscription external=$external product=$productId → $expected', ({ external, productId, expected }) => {
    const externalId = external === 'team' ? 'team_abc' : external === 'user' ? BUYER : null;
    expect(isTeamSubscription({ id: 's', status: 'active', productId, customer: { externalId } })).toBe(expected);
  });

  it.each([
    { type: 'subscription.created', status: 'active', plan: 'team' },
    { type: 'subscription.updated', status: 'past_due', plan: 'team' },
    { type: 'subscription.updated', status: 'canceled', plan: 'none' },
    { type: 'subscription.revoked', status: 'active', plan: 'none' },
  ])('$type ($status) → team plan $plan, and the buyer’s own plan never moves', async ({ type, status, plan }) => {
    const { id: teamId } = await createTeam(BUYER, 'Acme');
    const result = await applySubscriptionEvent(type, teamSub(teamId, { status }), new Date(1_780_000_000_000));
    expect(result).toMatchObject({ applied: true, teamId });
    const team = await teamRow(teamId);
    expect(team.plan).toBe(plan);
    expect(team.seatsPurchased).toBe(5);
    expect(team.polarSubscriptionId).toBe('sub-team-1');
    expect(team.polarCustomerId).toBe('cust-team');
    const buyer = await userRow(BUYER);
    expect(buyer.plan).toBe('free');
    expect(buyer.polarSubscriptionId).toBeNull();
  });

  it('routes a team PRODUCT to the team by its stored customer id, never to the user', async () => {
    const { id: teamId } = await createTeam(BUYER, 'Acme');
    await db.update(teamsTable).set({ polarCustomerId: 'cust-team' }).where(eq(teamsTable.id, teamId));
    const sub = teamSub(teamId, { customer: { id: 'cust-team', externalId: BUYER } });
    const result = await applySubscriptionEvent('subscription.active', sub, new Date());
    expect(result).toMatchObject({ applied: true, teamId });
    expect((await userRow(BUYER)).plan).toBe('free');
  });

  it('an unknown team is recorded as no_team and touches no users row', async () => {
    const result = await applySubscriptionEvent(
      'subscription.active',
      teamSub('does-not-exist', { customerId: 'cust-x', customer: { id: 'cust-x', externalId: 'team_does-not-exist' } }),
      new Date()
    );
    expect(result).toEqual({ applied: false, reason: 'no_team' });
    expect((await userRow(BUYER)).plan).toBe('free');
  });

  it('skips an older event for the same subscription', async () => {
    const { id: teamId } = await createTeam(BUYER, 'Acme');
    await applySubscriptionEvent('subscription.updated', teamSub(teamId, { seats: 8 }), new Date(2_000_000));
    const stale = await applySubscriptionEvent('subscription.updated', teamSub(teamId, { seats: 3 }), new Date(1_000_000));
    expect(stale).toMatchObject({ applied: false, reason: 'stale' });
    expect((await teamRow(teamId)).seatsPurchased).toBe(8);
  });

  it('keeps the stored seat count when an event carries none', async () => {
    const { id: teamId } = await createTeam(BUYER, 'Acme');
    await applySubscriptionEvent('subscription.created', teamSub(teamId, { seats: 4 }), new Date(1_000));
    await applySubscriptionEvent('subscription.updated', teamSub(teamId, { seats: null }), new Date(2_000));
    expect((await teamRow(teamId)).seatsPurchased).toBe(4);
  });

  it('a lowered seat count leaves everybody seated and the team over-allocated', async () => {
    const { id: teamId } = await createTeam(BUYER, 'Acme');
    await applySubscriptionEvent('subscription.created', teamSub(teamId, { seats: 3 }), new Date(1_000));
    await db.delete(teamSeatsTable).where(eq(teamSeatsTable.teamId, teamId));
    await assignNamedSeats(teamId, BUYER, ['member', 'carol', 'dave'], resolve);
    await applySubscriptionEvent('subscription.updated', teamSub(teamId, { seats: 2 }), new Date(2_000));
    const detail = await getTeamDetail(teamId);
    expect(detail.seatsUsed).toBe(3);
    expect(detail.overAllocated).toBe(true);
  });

  describe('through the HTTP handler', () => {
    let url: string;
    let close: () => Promise<void>;

    beforeEach(async () => {
      const app = express();
      app.post('/webhooks/polar', express.raw({ type: () => true }), (req, res) => {
        void handlePolarWebhook(req, res);
      });
      const server: Server = createServer(app);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      close = () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        });
    });
    afterEach(async () => close());

    async function post(eventId: string, body: unknown, timestamp = 1_780_000_000) {
      return fetch(`${url}/webhooks/polar`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': eventId,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': 'v1,good',
        },
        body: JSON.stringify(body),
      });
    }

    it('seats the creator on the first activation, records the team, and pushes every member', async () => {
      const emit = vi.spyOn(websocketModule, 'emitSubscriptionUpdated').mockImplementation(() => {});
      const { id: teamId } = await createTeam(BUYER, 'Acme');

      const res = await post('evt-team-1', { type: 'subscription.created', data: teamSub(teamId) });
      expect(res.status).toBe(200);

      const [event] = await db.select().from(billingEventsTable).where(eq(billingEventsTable.eventId, 'evt-team-1'));
      expect(event).toMatchObject({ applied: true, teamId, userId: null });
      const seats = await db.select().from(teamSeatsTable).where(eq(teamSeatsTable.teamId, teamId));
      expect(seats.map((s) => s.githubUserId)).toEqual([BUYER_GH]);
      expect(await resolveEntitlement(BUYER)).toEqual({ plan: 'unlimited', source: 'team' });
      expect(emit).toHaveBeenCalledWith(BUYER, expect.objectContaining({ planSource: 'team' }));
    });

    it('does not re-seat a creator who removed their own seat', async () => {
      vi.spyOn(websocketModule, 'emitSubscriptionUpdated').mockImplementation(() => {});
      const { id: teamId } = await createTeam(BUYER, 'Acme');
      await post('evt-a', { type: 'subscription.created', data: teamSub(teamId) }, 1_780_000_000);
      await db.delete(teamSeatsTable).where(eq(teamSeatsTable.teamId, teamId));
      await post('evt-b', { type: 'subscription.updated', data: teamSub(teamId, { seats: 6 }) }, 1_780_000_100);
      expect(await db.select().from(teamSeatsTable).where(eq(teamSeatsTable.teamId, teamId))).toEqual([]);
    });
  });
});

describe('team billing helpers', () => {
  it.each([
    ['team_abc', 'abc'],
    ['team_', null],
    ['user-1', null],
    [null, null],
    [undefined, null],
  ])('teamIdFromCustomerExternalId(%j) → %j', (input, expected) => {
    expect(teamIdFromCustomerExternalId(input)).toBe(expected);
  });

  it('reads the live seat-based price and ignores archived and fixed ones', () => {
    const tiers = {
      seatTierType: 'volume',
      minimumSeats: 2,
      maximumSeats: null,
      tiers: [
        { minSeats: 2, maxSeats: 9, pricePerSeat: 1200 },
        { minSeats: 10, maxSeats: null, pricePerSeat: 1000 },
      ],
    };
    expect(
      seatTiersFromPrices([
        { amountType: 'fixed', priceAmount: 1500 },
        { amountType: 'seat_based', isArchived: true, seatTiers: { ...tiers, minimumSeats: 99 } },
        { amountType: 'seat_based', isArchived: false, priceCurrency: 'usd', seatTiers: tiers },
      ])
    ).toEqual({
      currency: 'usd',
      tierType: 'volume',
      minimumSeats: 2,
      maximumSeats: null,
      tiers: [
        { minSeats: 2, maxSeats: 9, pricePerSeat: 1200 },
        { minSeats: 10, maxSeats: null, pricePerSeat: 1000 },
      ],
    });
    expect(seatTiersFromPrices([{ amountType: 'fixed' }])).toBeNull();
  });
});

describe('GitHub identity', () => {
  it.each([
    [12345, 12345],
    ['12345', 12345],
    ['0', null],
    [0, null],
    [-4, null],
    [1.5, null],
    ['12a', null],
    ['', null],
    [null, null],
    [Number.MAX_SAFE_INTEGER + 1, null],
  ])('parseGithubUserId(%j) → %j', (input, expected) => {
    expect(parseGithubUserId(input)).toBe(expected);
  });

  it('reads the GitHub identity, never another provider', () => {
    expect(
      githubUserIdFromIdentities([
        { provider: 'email', id: '999' },
        { provider: 'github', id: 'uuid-ish', identity_data: { provider_id: '4242', sub: '4242' } },
      ])
    ).toBe(4242);
    expect(githubUserIdFromIdentities([{ provider: 'github', identity_data: { sub: '77' } }])).toBe(77);
    expect(githubUserIdFromIdentities([{ provider: 'google', identity_data: { provider_id: '1' } }])).toBeNull();
    expect(githubUserIdFromIdentities(undefined)).toBeNull();
  });
});

describe('team env group', () => {
  const base = {
    POLAR_ACCESS_TOKEN: 'x',
    POLAR_WEBHOOK_SECRET: 'x',
    POLAR_ENVIRONMENT: 'sandbox',
    POLAR_PRODUCT_ID_MONTHLY: 'x',
    POLAR_PRODUCT_ID_ANNUAL: 'x',
  };
  const teamErrors = (env: Record<string, string>) =>
    validateEnv(env as NodeJS.ProcessEnv).filter((e) => e.includes('team plan'));

  it.each([
    ['neither team id', { ...base }, 0],
    ['both team ids', { ...base, POLAR_PRODUCT_ID_TEAM_MONTHLY: 'm', POLAR_PRODUCT_ID_TEAM_ANNUAL: 'a' }, 0],
    ['only monthly', { ...base, POLAR_PRODUCT_ID_TEAM_MONTHLY: 'm' }, 1],
    ['team without billing', { POLAR_PRODUCT_ID_TEAM_MONTHLY: 'm', POLAR_PRODUCT_ID_TEAM_ANNUAL: 'a' }, 1],
  ])('%s', (_name, env, count) => {
    expect(teamErrors(env)).toHaveLength(count);
  });
});

// Keeps the admins table import honest: a direct row read the tests above rely on.
it('createTeam makes the caller its first admin', async () => {
  const { id } = await createTeam(BUYER, 'Acme');
  expect(await db.select().from(teamAdminsTable).where(eq(teamAdminsTable.teamId, id))).toEqual([
    expect.objectContaining({ teamId: id, userId: BUYER }),
  ]);
});
