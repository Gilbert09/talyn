import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import { slackInstallations } from '../../db/schema.js';
import { decryptString, encryptString, type EncryptedEnvelope } from '../tokenCrypto.js';
import { callSlack, SlackApiError } from './api.js';
import { requireSlackAppConfig } from './config.js';

/**
 * The bot token for a Slack team, renewed when it is close to expiry.
 *
 * The app has token rotation on, so a bot token lives about 12 hours and each
 * refresh returns a NEW refresh token. The old one is then spent: replaying it
 * kills the grant. So a refresh must happen once, with the row re-read inside
 * the critical section.
 *
 * Two layers make that hold:
 *  - In one process, concurrent callers share one in-flight promise per team.
 *  - Across replicas, a lease column (`refresh_lease_until`) is claimed with a
 *    conditional UPDATE. The claim's RETURNING is the re-read. A replica that
 *    loses waits for the winner's write and reads the new token.
 *
 * Not `withBlockingAdvisoryLock`: that helper holds a pooled connection idle
 * for the whole callback, here a Slack HTTP call, and P2 calls this on the
 * event path. A burst at expiry must not queue on the pool (see CLAUDE.md).
 */

/** Refresh this long before Slack's expiry, so a token never dies mid-use. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** Longer than the Slack call's own 10 s timeout, so a live lease is never stolen. */
const LEASE_MS = 30_000;
const WAIT_STEP_MS = 250;
/** How long a replica that lost the lease waits for the winner's write. */
const WAIT_MAX_MS = 15_000;

/**
 * Refresh errors that mean the grant is gone and only a reinstall helps.
 * A client-credential error (`invalid_client_id`, `bad_client_secret`) is NOT
 * here: that is our misconfiguration, fixed by an env change, and treating it
 * as a dead grant would force every team to reinstall.
 */
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_refresh_token',
  'invalid_grant',
  'token_revoked',
  'token_expired',
  'app_uninstalled',
  'account_inactive',
]);

const TOKEN_COLUMNS = {
  accessTokenEnc: slackInstallations.accessTokenEnc,
  refreshTokenEnc: slackInstallations.refreshTokenEnc,
  expiresAt: slackInstallations.expiresAt,
  tokenError: slackInstallations.tokenError,
} as const;

type TokenRow = {
  accessTokenEnc: EncryptedEnvelope | null;
  refreshTokenEnc: EncryptedEnvelope | null;
  expiresAt: Date | null;
  tokenError: string | null;
};

const inflight = new Map<string, Promise<string | null>>();

function isExpiring(row: TokenRow, now: number): boolean {
  // No expiry means a non-rotating token, which does not expire.
  if (!row.expiresAt) return false;
  return row.expiresAt.getTime() - now <= REFRESH_MARGIN_MS;
}

function usable(row: TokenRow, now: number): string | null {
  if (row.tokenError || !row.accessTokenEnc) return null;
  // Still inside its real lifetime, even if inside the refresh margin.
  if (row.expiresAt && row.expiresAt.getTime() <= now) return null;
  return decryptString(row.accessTokenEnc);
}

async function readRow(teamId: string): Promise<TokenRow | null> {
  const rows = await getPoolDbClient()
    .select(TOKEN_COLUMNS)
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, teamId))
    .limit(1);
  return (rows[0] as TokenRow | undefined) ?? null;
}

/**
 * The team's bot token, or null when there is no usable one: no installation,
 * a grant Slack refused for good (recorded on the row), or a refresh that
 * failed for now and left nothing valid.
 */
export async function getSlackBotToken(teamId: string): Promise<string | null> {
  const row = await readRow(teamId);
  if (!row || row.tokenError || !row.accessTokenEnc) return null;
  if (!isExpiring(row, Date.now())) return decryptString(row.accessTokenEnc);

  const pending = inflight.get(teamId);
  if (pending) return pending;
  const promise = refreshWithLease(teamId).finally(() => inflight.delete(teamId));
  inflight.set(teamId, promise);
  return promise;
}

async function claimLease(teamId: string): Promise<TokenRow | null> {
  const now = new Date();
  const rows = await getPoolDbClient()
    .update(slackInstallations)
    .set({ refreshLeaseUntil: new Date(now.getTime() + LEASE_MS) })
    .where(
      and(
        eq(slackInstallations.teamId, teamId),
        or(isNull(slackInstallations.refreshLeaseUntil), lt(slackInstallations.refreshLeaseUntil, now))
      )
    )
    .returning(TOKEN_COLUMNS);
  return (rows[0] as TokenRow | undefined) ?? null;
}

async function releaseLease(teamId: string): Promise<void> {
  await getPoolDbClient()
    .update(slackInstallations)
    .set({ refreshLeaseUntil: null })
    .where(eq(slackInstallations.teamId, teamId));
}

async function refreshWithLease(teamId: string): Promise<string | null> {
  const deadline = Date.now() + WAIT_MAX_MS;
  for (;;) {
    const claimed = await claimLease(teamId);
    if (claimed) return refreshClaimed(teamId, claimed);

    // Another replica holds the lease (or the row is gone). Wait for its write.
    const row = await readRow(teamId);
    if (!row || row.tokenError) return null;
    if (row.accessTokenEnc && !isExpiring(row, Date.now())) return decryptString(row.accessTokenEnc);
    if (Date.now() >= deadline) return usable(row, Date.now());
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
}

async function refreshClaimed(teamId: string, row: TokenRow): Promise<string | null> {
  const now = Date.now();
  // The re-read: whoever held the lease before us may already have rotated.
  if (row.tokenError || !row.accessTokenEnc) {
    await releaseLease(teamId);
    return null;
  }
  if (!isExpiring(row, now)) {
    await releaseLease(teamId);
    return decryptString(row.accessTokenEnc);
  }
  if (!row.refreshTokenEnc) {
    await releaseLease(teamId);
    return usable(row, now);
  }

  try {
    const config = requireSlackAppConfig();
    const doc = await callSlack<{
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    }>('oauth.v2.access', {
      form: {
        grant_type: 'refresh_token',
        refresh_token: decryptString(row.refreshTokenEnc),
        client_id: config.clientId,
        client_secret: config.clientSecret,
      },
    });
    if (typeof doc.access_token !== 'string' || !doc.access_token) {
      throw new SlackApiError('oauth.v2.access', 'missing_access_token');
    }
    const expiresIn = typeof doc.expires_in === 'number' ? doc.expires_in : null;
    await getPoolDbClient()
      .update(slackInstallations)
      .set({
        accessTokenEnc: encryptString(doc.access_token),
        // Rotation always sends a new one. Keep the old only if Slack sent none.
        refreshTokenEnc:
          typeof doc.refresh_token === 'string' && doc.refresh_token
            ? encryptString(doc.refresh_token)
            : row.refreshTokenEnc,
        expiresAt: expiresIn !== null ? new Date(Date.now() + expiresIn * 1000) : null,
        refreshLeaseUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(slackInstallations.teamId, teamId));
    return doc.access_token;
  } catch (err) {
    if (err instanceof SlackApiError && TERMINAL_REFRESH_ERRORS.has(err.code)) {
      await markSlackNeedsReinstall(teamId, err.code, 'the token refresh');
      return null;
    }
    // Transient. Leave the grant alone; the current token may still be valid.
    console.warn(
      `[slack] team ${teamId}: token refresh failed: ${err instanceof Error ? err.message : String(err)}`
    );
    await releaseLease(teamId);
    return usable(row, Date.now());
  }
}

/**
 * Record that Slack refused this team's grant for good. Recorded, not only
 * reported: later callers stop spending a dead token, and GET /slack can say
 * "install again" (`needsReinstall`).
 */
export async function markSlackNeedsReinstall(teamId: string, code: string, what: string): Promise<void> {
  await getPoolDbClient()
    .update(slackInstallations)
    .set({
      tokenError: code,
      tokenErrorAt: new Date(),
      accessTokenEnc: null,
      refreshTokenEnc: null,
      refreshLeaseUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(slackInstallations.teamId, teamId));
  console.warn(`[slack] team ${teamId}: Slack refused ${what} (${code}); reinstall needed`);
}

/**
 * Errors from an ordinary Web API call that mean the bot token itself is dead.
 * `not_authed` is not here: it means no token was sent, which is our bug.
 */
const REVOKED_CALL_ERRORS = new Set(['token_revoked', 'invalid_auth', 'account_inactive', 'token_expired', 'app_uninstalled']);

/**
 * Call a Web API method as the team's bot, with the current (refreshed when
 * near expiry) token. A team with no usable token throws `no_bot_token`; a
 * call Slack answers with a dead-token error marks the installation
 * `needsReinstall` and rethrows.
 */
export async function callSlackAsBot<T extends Record<string, unknown>>(
  teamId: string,
  method: string,
  form: Record<string, string | undefined> = {}
): Promise<T> {
  const token = await getSlackBotToken(teamId);
  if (!token) throw new SlackApiError(method, 'no_bot_token');
  try {
    return await callSlack<T>(method, { token, form });
  } catch (err) {
    if (err instanceof SlackApiError && REVOKED_CALL_ERRORS.has(err.code)) {
      await markSlackNeedsReinstall(teamId, err.code, method).catch(() => undefined);
    }
    throw err;
  }
}

/** Tests: forget in-flight refreshes between cases. */
export function resetSlackTokenStateForTests(): void {
  inflight.clear();
}
