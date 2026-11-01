import { createHash, randomBytes } from 'crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { WorkbenchPreviewLink } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import {
  workbenchPreviewHosts as hosts,
  workbenchPreviewSessions as sessions,
  workbenchPreviewTickets as tickets,
  workspaces,
} from '../../db/schema.js';
import { workspaceMayUseWorkbenches } from '../workbenches/access.js';
import { getWorkbench } from '../workbenches/store.js';
import type { PortTarget } from './portsHttp.js';
import { previewOrigin, type PreviewHostMatch } from './previewHost.js';

/**
 * Hosted preview links: a session's port on its own host name,
 * `<id>-<port>.<PREVIEW_BASE_DOMAIN>`, for a browser with no desktop app.
 *
 * - The id is 128 random bits. The server maps it to (session, port). The
 *   port in the name must agree with the stored port.
 * - A ticket (`POST /workbenches/:id/ports/:port/ticket`) opens the host once.
 *   `/__talyn/auth?ticket=…` swaps it for a cookie on that host only.
 * - Tickets and cookies are random tokens, stored as SHA-256 hashes.
 * - Each request checks the cookie, the session and the owner's access. The
 *   answer is cached for `AUTH_CACHE_MS`, so a revoked access stops within it.
 */

/** `__Host-` makes the browser refuse a Domain attribute, so a sibling preview cannot set it. */
export const PREVIEW_COOKIE = '__Host-talyn-preview';
export const PREVIEW_AUTH_PATH = '/__talyn/auth';
/** Long enough to paste a share link and open it. A leaked link dies soon after. */
export const PREVIEW_TICKET_TTL_MS = 10 * 60_000;
/** One working day. The owner's access is checked on every request anyway. */
export const PREVIEW_SESSION_TTL_MS = 12 * 60 * 60_000;
/** Must stay well under a minute: a revoked access stops working within this time. */
const AUTH_CACHE_MS = 20_000;
/** A cache entry per open preview cookie. The bound only stops a flood of bad cookies from growing it. */
const AUTH_CACHE_MAX = 5_000;
/** Per user. One mint is one click on "Open preview"; 30 a minute is far above a person. */
export const PREVIEW_TICKET_RATE = { windowMs: 60_000, max: 30 } as const;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashPreviewToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const newToken = () => randomBytes(32).toString('base64url');

/** Mints a ticket for (session, port). The host for that pair is made once and then kept. */
export async function mintPreviewTicket(
  input: { workbenchId: string; port: number; userId: string },
  domain: string,
): Promise<WorkbenchPreviewLink> {
  const db = getPoolDbClient();
  const now = new Date();
  await db.delete(tickets).where(lt(tickets.expiresAt, now));
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
  await db.insert(hosts)
    .values({ id: randomBytes(16).toString('hex'), workbenchId: input.workbenchId, port: input.port })
    .onConflictDoNothing();
  const [host] = await db.select({ id: hosts.id }).from(hosts)
    .where(and(eq(hosts.workbenchId, input.workbenchId), eq(hosts.port, input.port))).limit(1);
  if (!host) throw new Error('Could not make the preview host.');
  const ticket = newToken();
  const expiresAt = new Date(now.getTime() + PREVIEW_TICKET_TTL_MS);
  await db.insert(tickets).values({ tokenHash: hashPreviewToken(ticket), hostId: host.id, userId: input.userId, expiresAt });
  const origin = previewOrigin(`${host.id}-${input.port}.${domain}`);
  return {
    url: `${origin}${PREVIEW_AUTH_PATH}?ticket=${ticket}`,
    origin,
    port: input.port,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Spends a ticket on the host it was minted for, once. Returns the new cookie
 * value. A ticket shown to another host stays unspent and does nothing there.
 */
export async function redeemPreviewTicket(hostId: string, ticket: string): Promise<{ token: string; expiresAt: Date } | null> {
  if (!TOKEN_PATTERN.test(ticket)) return null;
  const db = getPoolDbClient();
  const [spent] = await db.delete(tickets)
    .where(and(eq(tickets.tokenHash, hashPreviewToken(ticket)), eq(tickets.hostId, hostId), gt(tickets.expiresAt, new Date())))
    .returning({ userId: tickets.userId });
  if (!spent) return null;
  const token = newToken();
  const expiresAt = new Date(Date.now() + PREVIEW_SESSION_TTL_MS);
  await db.insert(sessions).values({ tokenHash: hashPreviewToken(token), hostId, userId: spent.userId, expiresAt });
  return { token, expiresAt };
}

export type PreviewAccess =
  | { ok: true; target: PortTarget; expiresAt: number }
  | { ok: false; status: 401 | 403 | 404 | 410 | 503; message: string };

const OPEN_AGAIN = 'Open the preview from Talyn again.';
const denied = (status: 401 | 403 | 404 | 410 | 503, message: string): PreviewAccess => ({ ok: false, status, message });

const cache = new Map<string, { at: number; value: PreviewAccess }>();

export function resetPreviewAccessCacheForTests(): void {
  cache.clear();
}

/** Checks the request's preview cookies for this host. The first one that grants access wins. */
export async function authorisePreview(host: PreviewHostMatch, cookies: string[]): Promise<PreviewAccess> {
  let answer = denied(401, `You are not signed in to this preview. ${OPEN_AGAIN}`);
  for (const token of cookies.slice(0, 4)) {
    if (!TOKEN_PATTERN.test(token)) continue;
    const result = await authoriseOne(host, hashPreviewToken(token));
    if (result.ok) return result;
    if (result.status !== 401) answer = result;
  }
  return answer;
}

async function authoriseOne(host: PreviewHostMatch, tokenHash: string): Promise<PreviewAccess> {
  const key = `${host.id}:${tokenHash}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < AUTH_CACHE_MS && (!hit.value.ok || hit.value.expiresAt > now)) return hit.value;
  const value = await lookup(host, tokenHash);
  // "Not ready yet" changes in seconds, so it is not kept.
  if (value.ok || value.status !== 503) {
    cache.delete(key);
    if (cache.size >= AUTH_CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: now, value });
  }
  return value;
}

async function lookup(host: PreviewHostMatch, tokenHash: string): Promise<PreviewAccess> {
  const db = getPoolDbClient();
  const [row] = await db
    .select({ userId: sessions.userId, expiresAt: sessions.expiresAt, workbenchId: hosts.workbenchId, port: hosts.port })
    .from(sessions)
    .innerJoin(hosts, eq(hosts.id, sessions.hostId))
    .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.hostId, host.id), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row || row.port !== host.port) return denied(401, `This preview sign-in has expired. ${OPEN_AGAIN}`);
  const workbench = await getWorkbench(row.workbenchId);
  if (!workbench) return denied(404, 'This session no longer exists.');
  const [workspace] = await db.select({ ownerId: workspaces.ownerId }).from(workspaces)
    .where(eq(workspaces.id, workbench.workspaceId)).limit(1);
  if (workspace?.ownerId !== row.userId) return denied(401, `The person who shared this preview no longer has access to it. ${OPEN_AGAIN}`);
  if (!(await workspaceMayUseWorkbenches(workbench.workspaceId))) return denied(403, 'Sessions are not available for this account.');
  if (workbench.runtime !== 'sandbox') return denied(403, 'Only sandbox sessions have hosted previews.');
  if (workbench.archivedAt || workbench.status === 'archived') return denied(410, 'This session is archived. Restore it in Talyn to open its preview.');
  if (workbench.status !== 'ready' || !workbench.sandboxId) return denied(503, 'This session is not ready yet. Try again in a moment.');
  return {
    ok: true,
    target: { workspaceId: workbench.workspaceId, fleetHost: workbench.fleetHost, sandboxId: workbench.sandboxId, port: host.port },
    expiresAt: row.expiresAt.getTime(),
  };
}
