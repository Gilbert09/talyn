import { and, asc, count, eq, inArray, ne } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import {
  TEAM_MIN_SEATS,
  TEAM_OVER_ALLOCATED_ERROR_CODE,
  TEAM_SEATS_FULL_ERROR_CODE,
  type AssignTeamSeatsResponse,
  type TeamDetail,
  type TeamSeat,
} from '@talyn/shared';
import { getPoolDbClient, isRealPostgres } from '../../db/client.js';
import {
  teamAdmins as teamAdminsTable,
  teamSeats as teamSeatsTable,
  teams as teamsTable,
  users as usersTable,
} from '../../db/schema.js';
import { withBlockingAdvisoryLock } from '../advisoryLock.js';
import { ensureGithubUserId } from '../githubIdentity.js';
import { teamGrantsSeats } from './entitlements.js';

/**
 * Team plan: seat billing and nothing else.
 *
 * A team pays Polar for N seats (`teams.seats_purchased`, written only by the
 * webhook). Who holds them is ours: one `team_seats` row per GitHub account,
 * keyed by the numeric id. A seat gives that account Unlimited on its own
 * Talyn account — see `deriveEntitlement`. No workspace is shared.
 *
 * Every read and write here is on the pool: the team tables are backend-only,
 * and these routes run before `ownerScope`. Authorization is explicit instead
 * — {@link assertTeamAdmin} on every admin action.
 */

/** A refusal with an HTTP status and, where a client branches on it, a code. */
export class TeamError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'TeamError';
  }
}

const MAX_TEAM_NAME_LENGTH = 80;
// GitHub's own login rule: alphanumerics and single hyphens, no leading or
// trailing hyphen, at most 39 characters. Checked before any API call so a
// pasted URL or an "@name" is refused with a sentence, not a GitHub 404.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * A GitHub account's avatar by numeric id. GitHub serves it for any account
 * without an API call, and unlike a login-based URL it survives a rename.
 */
export function githubAvatarUrl(githubUserId: number): string {
  return `https://avatars.githubusercontent.com/u/${githubUserId}?v=4`;
}

/** Normalise one login a person typed: trim, drop a leading "@". */
export function normaliseGithubLogin(raw: string): string {
  return raw.trim().replace(/^@/, '');
}

export function isValidGithubLogin(login: string): boolean {
  return GITHUB_LOGIN.test(login);
}

/**
 * Run `fn` holding the team's seat lock, so a count-then-insert cannot be
 * raced past `seats_purchased`. This is a paywall: two admins adding the last
 * seat at once must not both win. Skipped on pglite, whose single connection
 * would self-deadlock and cannot race anyway (the `withFreePlanGate` rule).
 */
async function withTeamSeatLock<T>(teamId: string, fn: () => Promise<T>): Promise<T> {
  if (!isRealPostgres()) return fn();
  return withBlockingAdvisoryLock(getPoolDbClient(), `team-seats:${teamId}`, fn);
}

export async function isTeamAdmin(teamId: string, userId: string): Promise<boolean> {
  const rows = await getPoolDbClient()
    .select({ teamId: teamAdminsTable.teamId })
    .from(teamAdminsTable)
    .where(and(eq(teamAdminsTable.teamId, teamId), eq(teamAdminsTable.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * 404, not 403, for a team the caller does not administer — whether a team
 * id exists is not something a stranger gets to learn.
 */
export async function assertTeamAdmin(teamId: string, userId: string): Promise<void> {
  if (!(await isTeamAdmin(teamId, userId))) {
    throw new TeamError(404, 'Team not found');
  }
}

/**
 * Create a team with the caller as its first admin. One team per admin: the
 * billing status names a single team, and a person running two would be
 * managing two invoices for one set of people.
 */
export async function createTeam(userId: string, rawName: string): Promise<{ id: string }> {
  const name = rawName.trim();
  if (!name) throw new TeamError(400, 'Give the team a name.');
  if (name.length > MAX_TEAM_NAME_LENGTH) {
    throw new TeamError(400, `A team name is at most ${MAX_TEAM_NAME_LENGTH} characters.`);
  }
  const db = getPoolDbClient();
  const existing = await db
    .select({ teamId: teamAdminsTable.teamId })
    .from(teamAdminsTable)
    .where(eq(teamAdminsTable.userId, userId))
    .limit(1);
  if (existing[0]) {
    throw new TeamError(409, 'You already manage a team.');
  }
  const id = uuid();
  await db.transaction(async (tx) => {
    await tx.insert(teamsTable).values({ id, name, createdByUserId: userId });
    await tx.insert(teamAdminsTable).values({ teamId: id, userId });
  });
  return { id };
}

function assertValidSeatCount(seats: number): void {
  if (!Number.isInteger(seats) || seats < TEAM_MIN_SEATS) {
    throw new TeamError(
      400,
      `A team has at least ${TEAM_MIN_SEATS} seat${TEAM_MIN_SEATS === 1 ? '' : 's'}.`
    );
  }
}

export async function renameTeam(teamId: string, rawName: string): Promise<void> {
  const name = rawName.trim();
  if (!name) throw new TeamError(400, 'Give the team a name.');
  if (name.length > MAX_TEAM_NAME_LENGTH) {
    throw new TeamError(400, `A team name is at most ${MAX_TEAM_NAME_LENGTH} characters.`);
  }
  await getPoolDbClient()
    .update(teamsTable)
    .set({ name, updatedAt: new Date() })
    .where(eq(teamsTable.id, teamId));
}

/**
 * Whether a checkout may be started: refused while the team already has a
 * live subscription, because a second checkout would bill the team twice —
 * a live team changes its seat count instead.
 */
export async function assertTeamCanCheckout(teamId: string, seats: number): Promise<void> {
  assertValidSeatCount(seats);
  const team = await loadTeamRow(teamId);
  if (team.plan === 'team') {
    throw new TeamError(409, 'This team already has a subscription. Change its seat count instead.');
  }
}

async function countSeats(teamId: string): Promise<number> {
  const [row] = await getPoolDbClient()
    .select({ n: count() })
    .from(teamSeatsTable)
    .where(eq(teamSeatsTable.teamId, teamId));
  return Number(row?.n ?? 0);
}

async function loadTeamRow(teamId: string) {
  const [team] = await getPoolDbClient()
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      plan: teamsTable.plan,
      planOverride: teamsTable.planOverride,
      seatsPurchased: teamsTable.seatsPurchased,
      polarSubscriptionId: teamsTable.polarSubscriptionId,
      subscriptionStatus: teamsTable.subscriptionStatus,
      currentPeriodEnd: teamsTable.currentPeriodEnd,
      cancelAtPeriodEnd: teamsTable.cancelAtPeriodEnd,
      createdByUserId: teamsTable.createdByUserId,
    })
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .limit(1);
  if (!team) throw new TeamError(404, 'Team not found');
  return team;
}

/** The admin's view of a team. */
export async function getTeamDetail(teamId: string): Promise<TeamDetail> {
  const db = getPoolDbClient();
  // Repairs a team from before "every admin holds a seat", so the list never
  // shows an admin who is not a member.
  await seatAllAdmins(teamId);
  const team = await loadTeamRow(teamId);
  const seatRows = await db
    .select({
      id: teamSeatsTable.id,
      githubUserId: teamSeatsTable.githubUserId,
      githubLogin: teamSeatsTable.githubLogin,
      avatarUrl: teamSeatsTable.avatarUrl,
      source: teamSeatsTable.source,
      createdAt: teamSeatsTable.createdAt,
    })
    .from(teamSeatsTable)
    .where(eq(teamSeatsTable.teamId, teamId))
    .orderBy(asc(teamSeatsTable.createdAt));
  const signedUp = seatRows.length
    ? await db
        .select({ id: usersTable.id, githubUserId: usersTable.githubUserId })
        .from(usersTable)
        .where(
          inArray(
            usersTable.githubUserId,
            seatRows.map((s) => s.githubUserId)
          )
        )
    : [];
  const accountByGithubId = new Map(signedUp.map((u) => [u.githubUserId, u.id]));
  const adminRows = await db
    .select({
      userId: usersTable.id,
      githubUsername: usersTable.githubUsername,
      githubUserId: usersTable.githubUserId,
      email: usersTable.email,
    })
    .from(teamAdminsTable)
    .innerJoin(usersTable, eq(usersTable.id, teamAdminsTable.userId))
    .where(eq(teamAdminsTable.teamId, teamId))
    .orderBy(asc(teamAdminsTable.createdAt));
  const adminIds = new Set(adminRows.map((a) => a.userId));
  const seatedGithubIds = new Set(seatRows.map((s) => s.githubUserId));

  const seats: TeamSeat[] = seatRows.map((s) => {
    const userId = accountByGithubId.get(s.githubUserId);
    return {
      id: s.id,
      githubUserId: s.githubUserId,
      githubLogin: s.githubLogin,
      avatarUrl: s.avatarUrl,
      source: s.source === 'org' ? 'org' : 'named',
      signedUp: userId !== undefined,
      isAdmin: userId !== undefined && adminIds.has(userId),
      createdAt: s.createdAt.toISOString(),
    };
  });
  const admins = adminRows.map((a) => ({
    userId: a.userId,
    githubUsername: a.githubUsername,
    email: a.email,
    hasSeat: a.githubUserId !== null && seatedGithubIds.has(a.githubUserId),
  }));

  return {
    id: team.id,
    name: team.name,
    active: teamGrantsSeats(team),
    planSource:
      team.planOverride === 'team' || team.planOverride === 'none'
        ? 'override'
        : team.plan === 'team'
          ? 'subscription'
          : 'none',
    seatsPurchased: team.seatsPurchased,
    seatsUsed: seats.length,
    overAllocated: seats.length > team.seatsPurchased,
    ...(team.subscriptionStatus ? { subscriptionStatus: team.subscriptionStatus } : {}),
    cancelAtPeriodEnd: team.cancelAtPeriodEnd,
    ...(team.currentPeriodEnd ? { currentPeriodEnd: team.currentPeriodEnd.toISOString() } : {}),
    seats,
    admins,
  };
}

/** A GitHub account resolved from a login — injected so tests need no GitHub. */
export type ResolveGithubAccount = (
  login: string
) => Promise<{ id: number; login: string; avatarUrl: string | null } | null>;

/**
 * Give seats to GitHub accounts by login.
 *
 * All-or-nothing on CAPACITY, per-login on everything else: asking for four
 * seats with three free refuses the whole request (the admin decides who
 * goes, not the order they typed), while one mistyped login is reported
 * beside the others that worked. Logins are resolved to numeric ids BEFORE
 * the lock, so the lock is never held across a GitHub round-trip.
 */
export async function assignNamedSeats(
  teamId: string,
  assignedByUserId: string,
  rawLogins: readonly string[],
  resolveAccount: ResolveGithubAccount
): Promise<AssignTeamSeatsResponse> {
  const failed: AssignTeamSeatsResponse['failed'] = [];
  const logins = [...new Set(rawLogins.map(normaliseGithubLogin).filter(Boolean))];
  if (logins.length === 0) throw new TeamError(400, 'Enter at least one GitHub username.');

  const accounts: Array<{ id: number; login: string; avatarUrl: string | null }> = [];
  for (const login of logins) {
    if (!isValidGithubLogin(login)) {
      failed.push({ login, reason: 'Not a valid GitHub username.' });
      continue;
    }
    const account = await resolveAccount(login);
    if (!account) {
      failed.push({ login, reason: 'No GitHub user has this username.' });
      continue;
    }
    if (!accounts.some((a) => a.id === account.id)) accounts.push(account);
  }
  if (accounts.length === 0) return { assigned: [], failed };

  return withTeamSeatLock(teamId, async () => {
    const db = getPoolDbClient();
    const team = await loadTeamRow(teamId);

    const taken = await db
      .select({ githubUserId: teamSeatsTable.githubUserId, teamId: teamSeatsTable.teamId })
      .from(teamSeatsTable)
      .where(
        inArray(
          teamSeatsTable.githubUserId,
          accounts.map((a) => a.id)
        )
      );
    const toAdd = accounts.filter((account) => {
      const holder = taken.find((t) => t.githubUserId === account.id);
      if (!holder) return true;
      failed.push({
        login: account.login,
        reason:
          holder.teamId === teamId
            ? 'Already has a seat on this team.'
            : 'Already has a seat on another team.',
      });
      return false;
    });
    if (toAdd.length === 0) return { assigned: [], failed };

    const used = await countSeats(teamId);
    if (used > team.seatsPurchased) {
      throw new TeamError(
        409,
        `${used} people hold seats but the team pays for ${team.seatsPurchased}. Remove ${
          used - team.seatsPurchased
        } before adding anyone.`,
        TEAM_OVER_ALLOCATED_ERROR_CODE
      );
    }
    const free = team.seatsPurchased - used;
    if (toAdd.length > free) {
      throw new TeamError(
        409,
        free === 0
          ? `Every seat is taken. Add seats, or remove someone, first.`
          : `Only ${free} seat${free === 1 ? ' is' : 's are'} free, and this adds ${toAdd.length}.`,
        TEAM_SEATS_FULL_ERROR_CODE
      );
    }

    const now = new Date();
    const rows = toAdd.map((a) => ({
      id: uuid(),
      teamId,
      githubUserId: a.id,
      githubLogin: a.login,
      avatarUrl: a.avatarUrl,
      source: 'named',
      assignedByUserId,
      createdAt: now,
    }));
    // The unique index is the backstop for a seat another TEAM took between
    // the read above and here: that team's lock is not ours.
    const inserted = await db
      .insert(teamSeatsTable)
      .values(rows)
      .onConflictDoNothing({ target: teamSeatsTable.githubUserId })
      .returning({ githubUserId: teamSeatsTable.githubUserId });
    const insertedIds = new Set(inserted.map((r) => r.githubUserId));
    for (const row of rows) {
      if (!insertedIds.has(row.githubUserId)) {
        failed.push({ login: row.githubLogin, reason: 'Already has a seat on another team.' });
      }
    }
    const signedUp = insertedIds.size
      ? await db
          .select({ id: usersTable.id, githubUserId: usersTable.githubUserId })
          .from(usersTable)
          .where(inArray(usersTable.githubUserId, [...insertedIds]))
      : [];
    const signedUpIds = new Set(signedUp.map((u) => u.githubUserId));
    const adminIds = new Set(
      (
        await db
          .select({ userId: teamAdminsTable.userId })
          .from(teamAdminsTable)
          .where(eq(teamAdminsTable.teamId, teamId))
      ).map((a) => a.userId)
    );
    const adminGithubIds = new Set(
      signedUp.filter((u) => adminIds.has(u.id)).map((u) => u.githubUserId)
    );

    return {
      assigned: rows
        .filter((r) => insertedIds.has(r.githubUserId))
        .map((r) => ({
          id: r.id,
          githubUserId: r.githubUserId,
          githubLogin: r.githubLogin,
          avatarUrl: r.avatarUrl,
          source: 'named' as const,
          signedUp: signedUpIds.has(r.githubUserId),
          isAdmin: adminGithubIds.has(r.githubUserId),
          createdAt: now.toISOString(),
        })),
      failed,
    };
  });
}

/**
 * Give the calling admin a seat on their own team.
 *
 * The admin's GitHub id is already on their account (the sign-in stored it),
 * so this needs no GitHub lookup: it goes through `assignNamedSeats` with a
 * resolver that answers from the users row. That keeps one code path for the
 * seat cap and the one-team-per-person rule. An account whose GitHub id is not
 * known yet gets one more attempt to read it before the refusal.
 */
export async function assignSelfSeat(
  teamId: string,
  userId: string
): Promise<AssignTeamSeatsResponse> {
  const [user] = await getPoolDbClient()
    .select({ githubUserId: usersTable.githubUserId, githubUsername: usersTable.githubUsername })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const githubUserId = user?.githubUserId ?? (await ensureGithubUserId(userId));
  const login = user?.githubUsername;
  if (!githubUserId || !login) {
    throw new TeamError(
      409,
      'Talyn does not know your GitHub account yet. Sign out and sign in again with GitHub, then try again.'
    );
  }
  return assignNamedSeats(teamId, userId, [login], async () => ({
    id: githubUserId,
    login,
    avatarUrl: githubAvatarUrl(githubUserId),
  }));
}

const LAST_ADMIN_MESSAGE =
  'A team always needs at least one admin. Make someone else an admin first.';

async function teamAdminIds(teamId: string): Promise<string[]> {
  const rows = await getPoolDbClient()
    .select({ userId: teamAdminsTable.userId })
    .from(teamAdminsTable)
    .where(eq(teamAdminsTable.teamId, teamId));
  return rows.map((r) => r.userId);
}

/** The Talyn accounts behind a GitHub id — usually one, never trusted to be. */
async function accountIdsForGithubId(githubUserId: number): Promise<string[]> {
  const rows = await getPoolDbClient()
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.githubUserId, githubUserId));
  return rows.map((r) => r.id);
}

/**
 * Remove someone from the team: their seat and, if they had it, the admin
 * role, because an admin is a member with extra rights. The holder drops to
 * their own plan at once. Refused for the team's only admin — a team with no
 * admin is a subscription nobody can manage or cancel.
 */
export async function removeSeat(teamId: string, seatId: string): Promise<void> {
  const db = getPoolDbClient();
  const [seat] = await db
    .select({ githubUserId: teamSeatsTable.githubUserId })
    .from(teamSeatsTable)
    .where(and(eq(teamSeatsTable.teamId, teamId), eq(teamSeatsTable.id, seatId)))
    .limit(1);
  if (!seat) throw new TeamError(404, 'Seat not found');
  await dropMember(teamId, seat.githubUserId);
}

/** Give up your own seat, and the admin role with it. */
export async function leaveTeam(userId: string): Promise<void> {
  const db = getPoolDbClient();
  const [user] = await db
    .select({ githubUserId: usersTable.githubUserId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!user?.githubUserId) throw new TeamError(404, 'You do not hold a team seat.');
  const [seat] = await db
    .select({ teamId: teamSeatsTable.teamId })
    .from(teamSeatsTable)
    .where(eq(teamSeatsTable.githubUserId, user.githubUserId))
    .limit(1);
  if (!seat) throw new TeamError(404, 'You do not hold a team seat.');
  await dropMember(seat.teamId, user.githubUserId);
}

async function dropMember(teamId: string, githubUserId: number): Promise<void> {
  const db = getPoolDbClient();
  const admins = await teamAdminIds(teamId);
  const accounts = await accountIdsForGithubId(githubUserId);
  const theirAdminIds = admins.filter((id) => accounts.includes(id));
  if (theirAdminIds.length > 0 && theirAdminIds.length === admins.length) {
    throw new TeamError(409, LAST_ADMIN_MESSAGE);
  }
  await db.transaction(async (tx) => {
    await tx
      .delete(teamSeatsTable)
      .where(and(eq(teamSeatsTable.teamId, teamId), eq(teamSeatsTable.githubUserId, githubUserId)));
    if (theirAdminIds.length > 0) {
      await tx
        .delete(teamAdminsTable)
        .where(
          and(eq(teamAdminsTable.teamId, teamId), inArray(teamAdminsTable.userId, theirAdminIds))
        );
    }
  });
}

/**
 * Make a seat's holder an admin, or take the role away. Admins are members:
 * the role is set on a seat, and only a holder who has signed in can have it,
 * because an admin is an account and a GitHub login alone has none.
 */
export async function setSeatAdmin(teamId: string, seatId: string, admin: boolean): Promise<void> {
  const db = getPoolDbClient();
  const [seat] = await db
    .select({ githubUserId: teamSeatsTable.githubUserId, githubLogin: teamSeatsTable.githubLogin })
    .from(teamSeatsTable)
    .where(and(eq(teamSeatsTable.teamId, teamId), eq(teamSeatsTable.id, seatId)))
    .limit(1);
  if (!seat) throw new TeamError(404, 'Seat not found');
  const accounts = await accountIdsForGithubId(seat.githubUserId);

  if (!admin) {
    const admins = await teamAdminIds(teamId);
    const theirs = admins.filter((id) => accounts.includes(id));
    if (theirs.length === 0) return;
    if (theirs.length === admins.length) throw new TeamError(409, LAST_ADMIN_MESSAGE);
    await db
      .delete(teamAdminsTable)
      .where(and(eq(teamAdminsTable.teamId, teamId), inArray(teamAdminsTable.userId, theirs)));
    return;
  }

  if (accounts.length === 0) {
    throw new TeamError(
      409,
      `@${seat.githubLogin} has not signed in to Talyn yet, so they cannot be an admin.`
    );
  }
  if (accounts.length > 1) {
    throw new TeamError(409, `More than one Talyn account uses @${seat.githubLogin}. Contact support.`);
  }
  const userId = accounts[0]!;
  const elsewhere = await db
    .select({ teamId: teamAdminsTable.teamId })
    .from(teamAdminsTable)
    .where(and(eq(teamAdminsTable.userId, userId), ne(teamAdminsTable.teamId, teamId)))
    .limit(1);
  if (elsewhere[0]) throw new TeamError(409, `@${seat.githubLogin} already manages another team.`);
  await db.insert(teamAdminsTable).values({ teamId, userId }).onConflictDoNothing();
}

/**
 * Validate a new seat count before it is sent to Polar. Returns the live
 * subscription id to change. Refuses going below the seats already assigned —
 * nobody is un-seated as a side effect of a number.
 */
export async function prepareSeatCountChange(teamId: string, seats: number): Promise<string> {
  assertValidSeatCount(seats);
  const team = await loadTeamRow(teamId);
  if (!team.polarSubscriptionId || !teamGrantsSeats(team)) {
    throw new TeamError(409, 'The team has no active subscription to change.');
  }
  const used = await countSeats(teamId);
  if (seats < used) {
    throw new TeamError(
      409,
      `${used} people hold seats. Remove ${used - seats} before going down to ${seats}.`,
      TEAM_OVER_ALLOCATED_ERROR_CODE
    );
  }
  return team.polarSubscriptionId;
}

/**
 * Add a Talyn user as an admin by their GitHub login. They must have signed
 * in at least once: an admin is an account, and a login alone has none.
 */
export async function addTeamAdmin(teamId: string, rawLogin: string): Promise<void> {
  const login = normaliseGithubLogin(rawLogin);
  if (!isValidGithubLogin(login)) throw new TeamError(400, 'Not a valid GitHub username.');
  const db = getPoolDbClient();
  const matches = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.githubUsername, login))
    .limit(2);
  if (matches.length === 0) {
    throw new TeamError(404, `@${login} has not signed in to Talyn yet.`);
  }
  if (matches.length > 1) {
    throw new TeamError(409, `More than one Talyn account uses @${login}. Contact support.`);
  }
  const userId = matches[0]!.id;
  const elsewhere = await db
    .select({ teamId: teamAdminsTable.teamId })
    .from(teamAdminsTable)
    .where(and(eq(teamAdminsTable.userId, userId), ne(teamAdminsTable.teamId, teamId)))
    .limit(1);
  if (elsewhere[0]) throw new TeamError(409, `@${login} already manages another team.`);
  await db.insert(teamAdminsTable).values({ teamId, userId }).onConflictDoNothing();
}

/** Remove an admin. A team always keeps at least one, or nobody can manage it. */
export async function removeTeamAdmin(teamId: string, userId: string): Promise<void> {
  const db = getPoolDbClient();
  const admins = await db
    .select({ userId: teamAdminsTable.userId })
    .from(teamAdminsTable)
    .where(eq(teamAdminsTable.teamId, teamId));
  if (!admins.some((a) => a.userId === userId)) throw new TeamError(404, 'Admin not found');
  if (admins.length === 1) throw new TeamError(409, LAST_ADMIN_MESSAGE);
  await db
    .delete(teamAdminsTable)
    .where(and(eq(teamAdminsTable.teamId, teamId), eq(teamAdminsTable.userId, userId)));
}

/**
 * The team this user is the ONLY admin of while it still pays, if any. The
 * account wipe refuses on it: deleting the last admin would leave a
 * subscription billing on with nobody able to manage or cancel it.
 */
export async function soleAdminOfPayingTeam(
  userId: string
): Promise<{ id: string; name: string } | null> {
  const db = getPoolDbClient();
  const teamsManaged = await db
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      plan: teamsTable.plan,
      planOverride: teamsTable.planOverride,
    })
    .from(teamAdminsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, teamAdminsTable.teamId))
    .where(eq(teamAdminsTable.userId, userId));
  for (const team of teamsManaged) {
    if (team.plan !== 'team') continue;
    const [others] = await db
      .select({ n: count() })
      .from(teamAdminsTable)
      .where(and(eq(teamAdminsTable.teamId, team.id), ne(teamAdminsTable.userId, userId)));
    if (Number(others?.n ?? 0) === 0) return { id: team.id, name: team.name };
  }
  return null;
}

/**
 * Every Talyn account a change to this team's billing affects: its admins and
 * the signed-up holders of its seats. The webhook pushes each a fresh billing
 * status.
 */
export async function teamAudienceUserIds(teamId: string): Promise<string[]> {
  const db = getPoolDbClient();
  const admins = await db
    .select({ userId: teamAdminsTable.userId })
    .from(teamAdminsTable)
    .where(eq(teamAdminsTable.teamId, teamId));
  const holders = await db
    .select({ userId: usersTable.id })
    .from(teamSeatsTable)
    .innerJoin(usersTable, eq(usersTable.githubUserId, teamSeatsTable.githubUserId))
    .where(eq(teamSeatsTable.teamId, teamId));
  return [...new Set([...admins.map((a) => a.userId), ...holders.map((h) => h.userId)])];
}

/**
 * Every admin holds a seat — Tom's rule: the people listed on a team are its
 * members, and an admin is a member with extra rights. This makes it true.
 *
 * Runs when a team is first paid for (the buyer, its first admin, is seated
 * then: there are no seats to hold before payment) and whenever the team is
 * read, which repairs a team from before the rule. Nothing else can produce a
 * seatless admin: only a seated account can be made an admin, and losing the
 * seat takes the role with it.
 *
 * An admin's seat is seated even past `seats_purchased`. The team then reads
 * as over-allocated, which refuses new seats until an admin fixes it — the
 * visible, recoverable failure, rather than an admin who silently pays and
 * gets nothing.
 */
export async function seatAllAdmins(teamId: string): Promise<void> {
  await withTeamSeatLock(teamId, async () => {
    const db = getPoolDbClient();
    const team = await loadTeamRow(teamId);
    if (!teamGrantsSeats(team)) return;
    const admins = await db
      .select({
        userId: usersTable.id,
        githubUserId: usersTable.githubUserId,
        githubUsername: usersTable.githubUsername,
      })
      .from(teamAdminsTable)
      .innerJoin(usersTable, eq(usersTable.id, teamAdminsTable.userId))
      .where(eq(teamAdminsTable.teamId, teamId));
    for (const admin of admins) {
      // The id is normally stored at sign-in, but that is best-effort: read it
      // now rather than leave an admin without the seat they paid for.
      const githubUserId = admin.githubUserId ?? (await ensureGithubUserId(admin.userId));
      if (!githubUserId || !admin.githubUsername) continue;
      await db
        .insert(teamSeatsTable)
        .values({
          id: uuid(),
          teamId,
          githubUserId,
          githubLogin: admin.githubUsername,
          avatarUrl: githubAvatarUrl(githubUserId),
          source: 'named',
          assignedByUserId: admin.userId,
        })
        .onConflictDoNothing({ target: teamSeatsTable.githubUserId });
    }
  });
}
