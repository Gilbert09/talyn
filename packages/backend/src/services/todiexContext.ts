import { eq } from 'drizzle-orm';
import { getPoolDbClient } from '../db/client.js';
import { users as usersTable, workspaces as workspacesTable } from '../db/schema.js';

/**
 * Who and what an inbox event is about, in words a person recognises.
 *
 * The events in todiex.ts used to carry ids and nothing else — `workspace_id:
 * "ws_8f3a…"` on a lock screen says a workspace did something and stops
 * there. Answering "whose?" meant opening the admin panel, or a SQL prompt,
 * which is the exact round trip the inbox exists to remove. So every event
 * now resolves the names behind its ids: the workspace's name, its owner's
 * email and GitHub handle, and whether they are paying.
 *
 * Two rules hold everything here together:
 *
 * - **Never throws, never blocks the caller.** Resolution runs inside the
 *   fire-and-forget POST (see `notifyTodiex`'s thunk form), and a lookup that
 *   fails degrades to the id-only event we sent before rather than losing the
 *   notification.
 * - **Reads the POOL client, never `getDbClient()`.** Every call site is
 *   detached background work scheduled from a request handler, and
 *   AsyncLocalStorage propagates that request's owner-scoped TRANSACTION
 *   handle into detached promises — by the time this runs the transaction has
 *   committed and queries on it hang or die with 25P02. See
 *   `runWithoutScope`'s note in db/client.ts.
 */

/** A person, as the feed should name them. Every field may be unknown. */
export interface PersonContext {
  userId: string | null;
  email: string | null;
  githubUsername: string | null;
  /** Effective plan — `plan_override` wins, matching entitlement checks. */
  plan: string | null;
}

/** A workspace and the person who owns it. */
export interface WorkspaceContext {
  workspaceId: string;
  workspaceName: string | null;
  owner: PersonContext;
}

/**
 * Names change (a workspace rename, a GitHub handle) and `workspace.activated`
 * is fired on EVERY dispatch — deduplicated at todiex, not here — so this is a
 * short TTL rather than the forever-cache analytics.ts uses for ownership. It
 * costs one query per workspace per five minutes and keeps a busy dispatch
 * loop off the database.
 */
const CACHE_TTL_MS = 5 * 60_000;

const workspaceCache = new Map<string, { at: number; value: WorkspaceContext }>();
const userCache = new Map<string, { at: number; value: PersonContext }>();

function cached<T>(store: Map<string, { at: number; value: T }>, key: string): T | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

/** Tests: drop the resolved-name caches between cases. */
export function resetTodiexContextCacheForTests(): void {
  workspaceCache.clear();
  userCache.clear();
}

const unknownPerson = (userId: string | null): PersonContext => ({
  userId,
  email: null,
  githubUsername: null,
  plan: null,
});

/** Look up a workspace's name and its owner. Never throws. */
export async function describeWorkspace(workspaceId: string): Promise<WorkspaceContext> {
  const hit = cached(workspaceCache, workspaceId);
  if (hit) return hit;

  const fallback: WorkspaceContext = {
    workspaceId,
    workspaceName: null,
    owner: unknownPerson(null),
  };
  try {
    const rows = await getPoolDbClient()
      .select({
        name: workspacesTable.name,
        ownerId: workspacesTable.ownerId,
        email: usersTable.email,
        githubUsername: usersTable.githubUsername,
        plan: usersTable.plan,
        planOverride: usersTable.planOverride,
      })
      .from(workspacesTable)
      .leftJoin(usersTable, eq(usersTable.id, workspacesTable.ownerId))
      .where(eq(workspacesTable.id, workspaceId))
      .limit(1);
    const row = rows[0];
    if (!row) return fallback;
    const value: WorkspaceContext = {
      workspaceId,
      workspaceName: row.name ?? null,
      owner: {
        userId: row.ownerId ?? null,
        email: row.email ?? null,
        githubUsername: row.githubUsername ?? null,
        plan: row.planOverride ?? row.plan ?? null,
      },
    };
    workspaceCache.set(workspaceId, { at: Date.now(), value });
    return value;
  } catch {
    return fallback;
  }
}

/**
 * Look up one person by our user id. Never throws.
 *
 * `refresh` skips the cache, and the billing webhook passes it: that handler
 * has just written the user's new plan, and a five-minute-old cache entry
 * would announce a fresh subscription against the plan it replaced.
 */
export async function describeUser(
  userId: string,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<PersonContext> {
  const hit = refresh ? null : cached(userCache, userId);
  if (hit) return hit;

  try {
    const rows = await getPoolDbClient()
      .select({
        email: usersTable.email,
        githubUsername: usersTable.githubUsername,
        plan: usersTable.plan,
        planOverride: usersTable.planOverride,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    const row = rows[0];
    if (!row) return unknownPerson(userId);
    const value: PersonContext = {
      userId,
      email: row.email ?? null,
      githubUsername: row.githubUsername ?? null,
      plan: row.planOverride ?? row.plan ?? null,
    };
    userCache.set(userId, { at: Date.now(), value });
    return value;
  } catch {
    return unknownPerson(userId);
  }
}

/**
 * How to name a workspace in a title. The fallback is the wording the
 * id-only events used, so a failed lookup reads like the old notification
 * rather than like a bug ("null ran its first task").
 */
export function workspaceLabel(ctx: WorkspaceContext): string {
  return ctx.workspaceName?.trim() || 'A Talyn workspace';
}

/** How to name a person in a title or message. Null when we know nothing. */
export function personLabel(person: PersonContext): string | null {
  if (person.email) return person.email;
  if (person.githubUsername) return `@${person.githubUsername}`;
  return null;
}

/** "Owner: tom@example.com (@tom, unlimited plan)" — or nothing to say. */
export function ownerLine(ctx: WorkspaceContext): string | null {
  const who = personLabel(ctx.owner);
  if (!who) return null;
  const extra = [
    ctx.owner.email && ctx.owner.githubUsername ? `@${ctx.owner.githubUsername}` : null,
    ctx.owner.plan ? `${ctx.owner.plan} plan` : null,
  ].filter(Boolean);
  return `Owner: ${who}${extra.length ? ` (${extra.join(', ')})` : ''}`;
}

/** Drop the keys we have no value for — a feed row of nulls helps nobody. */
export function compactMetadata(
  entries: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, v]) => v !== null && v !== undefined && v !== ''),
  );
}

/**
 * A person's properties, names first. `prefix` distinguishes the subject of
 * the event ('' — the person who signed up) from a bystander ('owner' — the
 * person behind a workspace that did something).
 */
export function personMetadata(
  person: PersonContext,
  prefix = '',
): Record<string, unknown> {
  const key = (name: string): string => (prefix ? `${prefix}_${name}` : name);
  return compactMetadata({
    [key('email')]: person.email,
    [key('github_username')]: person.githubUsername,
    [key('github_url')]: person.githubUsername
      ? `https://github.com/${person.githubUsername}`
      : null,
    [key('plan')]: person.plan,
    [key('user_id')]: person.userId,
  });
}

/**
 * A workspace's properties plus its owner's. `workspace_id` is kept — it is
 * what a support conversation ends up pasting into a query — but it is no
 * longer the only thing the event says.
 */
export function workspaceMetadata(ctx: WorkspaceContext): Record<string, unknown> {
  return compactMetadata({
    workspace: ctx.workspaceName,
    ...personMetadata(ctx.owner, 'owner'),
    workspace_id: ctx.workspaceId,
  });
}
