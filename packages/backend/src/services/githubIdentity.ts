import { and, eq, isNull } from 'drizzle-orm';
import { getPoolDbClient } from '../db/client.js';
import { users as usersTable } from '../db/schema.js';
import { getSupabaseServiceClient } from './supabase.js';

/**
 * The numeric GitHub account id behind a Talyn account — what a team seat
 * binds to.
 *
 * It is read from the Supabase IDENTITY record through the admin API, never
 * from the JWT's `user_metadata`. That distinction is the whole point of this
 * module: `user_metadata` is writable by the user themselves
 * (`auth.updateUser({ data })`), so trusting its `provider_id` would let
 * anybody claim somebody else's paid seat by typing their id. The identity's
 * `identity_data` is written by Supabase from GitHub's own answer at sign-in.
 *
 * Resolved once per account and stored on `users.github_user_id`; a GitHub
 * identity does not change under a Supabase user, so it is never re-read.
 */

const NEGATIVE_CACHE_MS = 10 * 60 * 1000;
const inFlight = new Map<string, Promise<number | null>>();
const recentMisses = new Map<string, number>();

/** A GitHub user id is a positive integer; accept it as a number or a digit string. */
export function parseGithubUserId(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

interface IdentityLike {
  provider?: string;
  id?: string;
  identity_data?: Record<string, unknown> | null;
}

/** Pick the GitHub id out of a Supabase user's identities. Pure, for tests. */
export function githubUserIdFromIdentities(identities: IdentityLike[] | undefined): number | null {
  const github = identities?.find((i) => i.provider === 'github');
  if (!github) return null;
  const data = github.identity_data ?? {};
  return (
    parseGithubUserId(data.provider_id) ??
    parseGithubUserId(data.sub) ??
    parseGithubUserId(github.id)
  );
}

async function lookupAndStore(userId: string): Promise<number | null> {
  const { data, error } = await getSupabaseServiceClient().auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  const githubUserId = githubUserIdFromIdentities(data.user.identities as IdentityLike[]);
  if (githubUserId === null) return null;
  // Only fills an empty column: a value already stored came from this same
  // trusted source and is never overwritten.
  await getPoolDbClient()
    .update(usersTable)
    .set({ githubUserId })
    .where(and(eq(usersTable.id, userId), isNull(usersTable.githubUserId)));
  return githubUserId;
}

/**
 * Fill `users.github_user_id` for an account that does not have it yet.
 *
 * Best-effort by design and never throws: it runs off the auth path, and a
 * failure here must cost at most a seat that shows up one request late —
 * never a sign-in. Concurrent requests share one lookup, and a miss is not
 * retried for ten minutes so an account with no GitHub identity does not
 * cost an admin-API call per request.
 */
export function ensureGithubUserId(userId: string): Promise<number | null> {
  const existing = inFlight.get(userId);
  if (existing) return existing;
  const missedAt = recentMisses.get(userId);
  if (missedAt !== undefined && Date.now() - missedAt < NEGATIVE_CACHE_MS) {
    return Promise.resolve(null);
  }

  const run = lookupAndStore(userId)
    .catch((err: unknown) => {
      console.warn(`[githubIdentity] could not resolve the GitHub id for ${userId}:`, err);
      return null;
    })
    .then((id) => {
      if (id === null) recentMisses.set(userId, Date.now());
      else recentMisses.delete(userId);
      return id;
    })
    .finally(() => inFlight.delete(userId));
  inFlight.set(userId, run);
  return run;
}

/** Test hook. */
export function resetGithubIdentityCacheForTests(): void {
  inFlight.clear();
  recentMisses.clear();
}
