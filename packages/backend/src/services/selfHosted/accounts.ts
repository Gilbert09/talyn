import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { FleetAgent } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { fleetAccounts, integrations as integrationsTable } from '../../db/schema.js';
import type { EncryptedEnvelope } from '../tokenCrypto.js';
import type { ClaudeOAuthCredential } from './claudeOauth.js';
import type { CodexOAuthCredential, ExhaustedQuotaRecord } from './credentials.js';

/**
 * The store for a workspace's fleet ACCOUNTS: each Claude or Codex credential it
 * holds, in the order they are tried.
 *
 * A workspace used to hold one subscription and one pasted key per vendor, as
 * keys on the selfhosted integration's config. Now it may hold several of each,
 * so a run can move to the next account when one is used up. Migration 0079
 * copied the old keys into this table. The integration row still exists: it
 * holds the half-finished Claude sign-in, and `enabled = false` on it still
 * turns the whole fleet off for the workspace.
 *
 * Every status read goes through {@link FLEET_ACCOUNT_STATUS_COLUMNS}, which
 * leaves out `credential`. Only the credential resolver and the OAuth refresh
 * read the credential.
 */

const INTEGRATION_TYPE = 'selfhosted';

export type FleetAccountKind = 'claude_oauth' | 'anthropic_key' | 'codex_oauth' | 'openai_key';

export const FLEET_ACCOUNT_KINDS: Record<FleetAgent, readonly FleetAccountKind[]> = {
  claude: ['claude_oauth', 'anthropic_key'],
  codex: ['codex_oauth', 'openai_key'],
};

export function agentForKind(kind: FleetAccountKind): FleetAgent {
  return kind === 'claude_oauth' || kind === 'anthropic_key' ? 'claude' : 'codex';
}

export function isFleetAccountKind(value: unknown): value is FleetAccountKind {
  return (
    value === 'claude_oauth' ||
    value === 'anthropic_key' ||
    value === 'codex_oauth' ||
    value === 'openai_key'
  );
}

/** The label an account gets when nobody named it. The migration uses the same words. */
export function defaultAccountLabel(kind: FleetAccountKind): string {
  switch (kind) {
    case 'claude_oauth':
      return 'Claude subscription';
    case 'anthropic_key':
      return 'Anthropic API key';
    case 'codex_oauth':
      return 'ChatGPT subscription';
    case 'openai_key':
      return 'OpenAI API key';
  }
}

/** One usage window as a vendor reports it, normalised. */
export interface FleetUsageWindow {
  key: string;
  label: string;
  /** 0..100. */
  usedPercent: number;
  /** ISO, or null when the vendor did not say. */
  resetsAt: string | null;
  /** The model a scoped window applies to (e.g. "Opus"). Absent = every model. */
  scopeModel?: string;
}

/** The last usage snapshot of one account. An `error` snapshot means "unknown". */
export type FleetAccountUsage =
  | { fetchedAt: string; windows: FleetUsageWindow[] }
  | { fetchedAt: string; error: string };

/** A pasted key (`sk-ant-api…`, `sk-ant-oat…`, or an OpenAI `sk-…`). */
export interface FleetApiKeyCredential {
  keyEnc: EncryptedEnvelope;
}

/**
 * The OAuth credentials as stored on an account. `reauthRequiredAt` is not in
 * them: it is the account's own column.
 */
export type StoredClaudeOAuth = Omit<ClaudeOAuthCredential, 'reauthRequiredAt'>;
export type StoredCodexOAuth = Omit<CodexOAuthCredential, 'reauthRequiredAt'>;

export type FleetAccountCredential = StoredClaudeOAuth | StoredCodexOAuth | FleetApiKeyCredential;

/** An account as every status, list and selection read sees it. No credential. */
export interface FleetAccount {
  id: string;
  workspaceId: string;
  agent: FleetAgent;
  kind: FleetAccountKind;
  label: string;
  /** 1 is tried first. */
  priority: number;
  /** ISO. Set when the vendor rejected the grant; nothing refreshes it until a reconnect. */
  reauthRequiredAt: string | null;
  /** The last confirmed exhaustion. Whether it still holds is `exhaustedQuota.isHeldBack`'s call. */
  quotaExhausted: ExhaustedQuotaRecord | null;
  usage: FleetAccountUsage | null;
  createdAt: string;
  updatedAt: string;
}

export type FleetAccountWithCredential = FleetAccount & { credential: FleetAccountCredential };

/** A refusal a route can show as it is: a bad reorder, an unknown account. */
export class FleetAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetAccountError';
  }
}

/** Every column but `credential`. The status projection. */
export const FLEET_ACCOUNT_STATUS_COLUMNS = {
  id: fleetAccounts.id,
  workspaceId: fleetAccounts.workspaceId,
  agent: fleetAccounts.agent,
  kind: fleetAccounts.kind,
  label: fleetAccounts.label,
  priority: fleetAccounts.priority,
  reauthRequiredAt: fleetAccounts.reauthRequiredAt,
  quotaExhausted: fleetAccounts.quotaExhausted,
  usage: fleetAccounts.usage,
  createdAt: fleetAccounts.createdAt,
  updatedAt: fleetAccounts.updatedAt,
} as const;

type StatusRow = Pick<typeof fleetAccounts.$inferSelect, keyof typeof FLEET_ACCOUNT_STATUS_COLUMNS>;

function toAccount(row: StatusRow): FleetAccount {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agent: row.agent as FleetAgent,
    kind: row.kind as FleetAccountKind,
    label: row.label,
    priority: row.priority,
    reauthRequiredAt: row.reauthRequiredAt ? row.reauthRequiredAt.toISOString() : null,
    quotaExhausted: row.quotaExhausted ?? null,
    usage: row.usage ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Legacy adoption
// ---------------------------------------------------------------------------

/**
 * The id an adopted legacy credential gets. Same derivation as migration 0079's
 * `md5(workspace_id || ':' || kind)::uuid`, so the two can never insert twice.
 */
export function legacyAccountId(workspaceId: string, kind: FleetAccountKind): string {
  const hex = createHash('md5').update(`${workspaceId}:${kind}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Migration 0079's backfill for one workspace, for an agent that has legacy
 * config keys and no accounts.
 *
 * The migration covers every row that existed when it ran. This covers a row an
 * old instance wrote AFTER it, during the deploy overlap: without it that
 * credential would be on the row and invisible. The id is the migration's, so
 * a second run inserts nothing.
 */
async function adoptLegacyFleetAccounts(workspaceId: string): Promise<void> {
  await getDbClient().execute(sql`
    INSERT INTO "fleet_accounts" (
      "id", "workspace_id", "agent", "kind", "label", "priority", "credential",
      "reauth_required_at", "quota_exhausted", "created_at", "updated_at"
    )
    SELECT
      md5(s.workspace_id || ':' || s.kind)::uuid::text,
      s.workspace_id, s.agent, s.kind, s.label,
      (row_number() OVER (PARTITION BY s.workspace_id, s.agent ORDER BY s.rank))::int,
      s.credential,
      CASE WHEN s.reauth ~ '^\\d{4}-\\d{2}-\\d{2}T' THEN s.reauth::timestamptz END,
      NULLIF(s.hold, 'null'::jsonb),
      now(), now()
    FROM (
      SELECT i.workspace_id, 'claude' AS agent, 'claude_oauth' AS kind,
        'Claude subscription' AS label, 1 AS rank,
        (i.config -> 'claudeOAuth') - 'reauthRequiredAt' AS credential,
        i.config -> 'claudeOAuth' ->> 'reauthRequiredAt' AS reauth,
        i.config -> 'quotaExhausted' -> 'claude' AS hold
      FROM "integrations" i
      WHERE i.workspace_id = ${workspaceId} AND i.type = 'selfhosted'
        AND jsonb_typeof(i.config -> 'claudeOAuth') = 'object'
      UNION ALL
      SELECT i.workspace_id, 'claude', 'anthropic_key', 'Anthropic API key', 2,
        jsonb_build_object('keyEnc', i.config -> 'anthropicKeyEnc'), NULL,
        i.config -> 'quotaExhausted' -> 'claude'
      FROM "integrations" i
      WHERE i.workspace_id = ${workspaceId} AND i.type = 'selfhosted'
        AND jsonb_typeof(i.config -> 'anthropicKeyEnc') = 'object'
      UNION ALL
      SELECT i.workspace_id, 'codex', 'codex_oauth', 'ChatGPT subscription', 1,
        (i.config -> 'codexOAuth') - 'reauthRequiredAt',
        i.config -> 'codexOAuth' ->> 'reauthRequiredAt',
        i.config -> 'quotaExhausted' -> 'codex'
      FROM "integrations" i
      WHERE i.workspace_id = ${workspaceId} AND i.type = 'selfhosted'
        AND jsonb_typeof(i.config -> 'codexOAuth') = 'object'
      UNION ALL
      SELECT i.workspace_id, 'codex', 'openai_key', 'OpenAI API key', 2,
        jsonb_build_object('keyEnc', i.config -> 'openaiKeyEnc'), NULL,
        i.config -> 'quotaExhausted' -> 'codex'
      FROM "integrations" i
      WHERE i.workspace_id = ${workspaceId} AND i.type = 'selfhosted'
        AND jsonb_typeof(i.config -> 'openaiKeyEnc') = 'object'
    ) s
    WHERE NOT EXISTS (
      SELECT 1 FROM "fleet_accounts" fa
      WHERE fa.workspace_id = s.workspace_id AND fa.agent = s.agent
    )
    ON CONFLICT ("id") DO NOTHING
  `);
}

/**
 * Whether the workspace's fleet is switched off, and whether a legacy key is
 * waiting to be adopted. One small query: the config blob itself never ships.
 */
async function readIntegrationGate(
  workspaceId: string,
): Promise<{ disabled: boolean; adopt: boolean }> {
  const rows = await getDbClient()
    .select({
      enabled: integrationsTable.enabled,
      // Qualified by hand: drizzle renders a column of a one-table select
      // unqualified, and inside this subquery `workspace_id` would then bind
      // to `fa` and compare it with itself.
      adopt: sql<boolean>`(
        (
          (jsonb_typeof(${integrationsTable.config} -> 'claudeOAuth') = 'object'
            OR jsonb_typeof(${integrationsTable.config} -> 'anthropicKeyEnc') = 'object')
          AND NOT EXISTS (
            SELECT 1 FROM "fleet_accounts" fa
            WHERE fa.workspace_id = "integrations"."workspace_id" AND fa.agent = 'claude'
          )
        ) OR (
          (jsonb_typeof(${integrationsTable.config} -> 'codexOAuth') = 'object'
            OR jsonb_typeof(${integrationsTable.config} -> 'openaiKeyEnc') = 'object')
          AND NOT EXISTS (
            SELECT 1 FROM "fleet_accounts" fa
            WHERE fa.workspace_id = "integrations"."workspace_id" AND fa.agent = 'codex'
          )
        )
      )`,
    })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    )
    .limit(1);
  const row = rows[0];
  // No row is NOT disabled: accounts can exist before anything wrote the row.
  if (!row) return { disabled: false, adopt: false };
  return { disabled: !row.enabled, adopt: Boolean(row.adopt) };
}

/** Run before any read of a workspace's accounts. False = the fleet is switched off. */
async function prepareWorkspace(workspaceId: string): Promise<boolean> {
  const gate = await readIntegrationGate(workspaceId);
  if (gate.disabled) return false;
  if (gate.adopt) await adoptLegacyFleetAccounts(workspaceId);
  return true;
}

const LEGACY_KEYS: Record<FleetAgent, { oauth: string; key: string; oauthKind: FleetAccountKind; keyKind: FleetAccountKind }> = {
  claude: { oauth: 'claudeOAuth', key: 'anthropicKeyEnc', oauthKind: 'claude_oauth', keyKind: 'anthropic_key' },
  codex: { oauth: 'codexOAuth', key: 'openaiKeyEnc', oauthKind: 'codex_oauth', keyKind: 'openai_key' },
};

/**
 * Write an agent's accounts back onto the legacy config keys, in the shape a
 * backend from before migration 0079 reads. Call it after every write to an
 * agent's accounts.
 *
 * This is what makes a rollback safe. An OAuth refresh rotates the refresh
 * token, so a legacy key that kept the pre-migration pair would be dead within
 * hours, and an old backend would then mark every subscription for reauth.
 *
 *   - `claudeOAuth` / `codexOAuth`: the first sign-in account by priority, with
 *     its `reauthRequiredAt`.
 *   - `anthropicKeyEnc` / `openaiKeyEnc`: the first pasted-key account.
 *   - `quotaExhausted.<agent>`: the first account's hold, only when EVERY
 *     account of the agent is held. The old backend reads it as "this agent
 *     cannot run".
 *
 * An agent with no accounts loses all three keys. Without that, adoption would
 * bring a removed credential back on the next read. Adoption cannot copy a
 * mirrored key twice: it runs only for an agent that has no accounts.
 *
 * One statement, so two concurrent writes cannot leave a mix of their reads.
 */
async function mirrorLegacyKeys(workspaceId: string, agent: FleetAgent): Promise<void> {
  const { oauth, key, oauthKind, keyKind } = LEGACY_KEYS[agent];
  const config = sql`CASE WHEN jsonb_typeof(i."config") = 'object' THEN i."config" ELSE '{}'::jsonb END`;
  const holds = sql`(
    (CASE WHEN jsonb_typeof(i."config" -> 'quotaExhausted') = 'object'
      THEN i."config" -> 'quotaExhausted' ELSE '{}'::jsonb END) - ${agent}::text
  ) || CASE WHEN s.hold IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(${agent}::text, s.hold) END`;
  // Accounts can exist before anything wrote the integration row (the accounts
  // API adds one directly). An old backend needs the row to see any credential.
  await getDbClient().execute(sql`
    INSERT INTO "integrations" ("id", "workspace_id", "type", "enabled", "config", "created_at", "updated_at")
    SELECT ${uuid()}, ${workspaceId}, ${INTEGRATION_TYPE}, true, '{}'::jsonb, now(), now()
    WHERE EXISTS (
      SELECT 1 FROM "fleet_accounts" fa WHERE fa."workspace_id" = ${workspaceId} AND fa."agent" = ${agent}
    )
    ON CONFLICT ("workspace_id", "type") DO NOTHING
  `);
  await getDbClient().execute(sql`
    UPDATE "integrations" AS i
    SET
      "config" = (${config} - ${oauth}::text - ${key}::text - 'quotaExhausted'::text)
        || CASE WHEN s.oauth IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(${oauth}::text, s.oauth) END
        || CASE WHEN s.apikey IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(${key}::text, s.apikey) END
        || CASE WHEN ${holds} = '{}'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('quotaExhausted', ${holds}) END,
      "updated_at" = now()
    FROM (
      SELECT
        (SELECT fa."credential" || CASE WHEN fa."reauth_required_at" IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('reauthRequiredAt',
              to_char(fa."reauth_required_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END
          FROM "fleet_accounts" fa
          WHERE fa."workspace_id" = ${workspaceId} AND fa."kind" = ${oauthKind}
          ORDER BY fa."priority", fa."created_at" LIMIT 1) AS oauth,
        (SELECT fa."credential" -> 'keyEnc'
          FROM "fleet_accounts" fa
          WHERE fa."workspace_id" = ${workspaceId} AND fa."kind" = ${keyKind}
          ORDER BY fa."priority", fa."created_at" LIMIT 1) AS apikey,
        (SELECT CASE WHEN count(*) > 0 AND bool_and(fa."quota_exhausted" IS NOT NULL)
            THEN (array_agg(fa."quota_exhausted" ORDER BY fa."priority", fa."created_at"))[1] END
          FROM "fleet_accounts" fa
          WHERE fa."workspace_id" = ${workspaceId} AND fa."agent" = ${agent}) AS hold
    ) s
    WHERE i."workspace_id" = ${workspaceId} AND i."type" = ${INTEGRATION_TYPE}
  `);
}

/** Mirror each (workspace, agent) pair that a write touched, once. */
async function mirrorTouched(rows: readonly { workspaceId: string; agent: string }[]): Promise<void> {
  const seen = new Set<string>();
  for (const row of rows) {
    const pair = `${row.workspaceId}\u0000${row.agent}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    await mirrorLegacyKeys(row.workspaceId, row.agent as FleetAgent);
  }
}

const TOUCHED_COLUMNS = { workspaceId: fleetAccounts.workspaceId, agent: fleetAccounts.agent } as const;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * A workspace's accounts in priority order, without credentials. Empty when the
 * fleet integration is switched off.
 */
export async function listFleetAccounts(
  workspaceId: string,
  agent?: FleetAgent,
): Promise<FleetAccount[]> {
  if (!(await prepareWorkspace(workspaceId))) return [];
  const rows = await getDbClient()
    .select(FLEET_ACCOUNT_STATUS_COLUMNS)
    .from(fleetAccounts)
    .where(
      and(
        eq(fleetAccounts.workspaceId, workspaceId),
        agent ? eq(fleetAccounts.agent, agent) : undefined,
      ),
    )
    .orderBy(asc(fleetAccounts.agent), asc(fleetAccounts.priority), asc(fleetAccounts.createdAt));
  return rows.map(toAccount);
}

/** The same list WITH credentials. For the credential resolver only. */
export async function listFleetAccountsWithCredential(
  workspaceId: string,
  agent?: FleetAgent,
): Promise<FleetAccountWithCredential[]> {
  if (!(await prepareWorkspace(workspaceId))) return [];
  const rows = await getDbClient()
    .select({ ...FLEET_ACCOUNT_STATUS_COLUMNS, credential: fleetAccounts.credential })
    .from(fleetAccounts)
    .where(
      and(
        eq(fleetAccounts.workspaceId, workspaceId),
        agent ? eq(fleetAccounts.agent, agent) : undefined,
      ),
    )
    .orderBy(asc(fleetAccounts.agent), asc(fleetAccounts.priority), asc(fleetAccounts.createdAt));
  return rows.map((row) => ({ ...toAccount(row), credential: row.credential }));
}

/** One account, without its credential. */
export async function getFleetAccount(accountId: string): Promise<FleetAccount | null> {
  const rows = await getDbClient()
    .select(FLEET_ACCOUNT_STATUS_COLUMNS)
    .from(fleetAccounts)
    .where(eq(fleetAccounts.id, accountId))
    .limit(1);
  return rows[0] ? toAccount(rows[0]) : null;
}

/** One account with its credential. For the OAuth refresh, which re-reads inside its lock. */
export async function getFleetAccountWithCredential(
  accountId: string,
): Promise<FleetAccountWithCredential | null> {
  const rows = await getDbClient()
    .select({ ...FLEET_ACCOUNT_STATUS_COLUMNS, credential: fleetAccounts.credential })
    .from(fleetAccounts)
    .where(eq(fleetAccounts.id, accountId))
    .limit(1);
  const row = rows[0];
  return row ? { ...toAccount(row), credential: row.credential } : null;
}

// ---------------------------------------------------------------------------
// Selection seam
// ---------------------------------------------------------------------------

/** Says whether an account may be used for the run being resolved. */
export type FleetAccountFilter = (account: FleetAccount) => boolean;

/**
 * The accounts to try, in the order to try them: `preferId` first when it names
 * one of them, then the rest by priority. Accounts the filter refuses are left
 * out, so an empty result means "none of this agent's accounts may be used".
 *
 * Phase 3's usage threshold plugs in here as the filter. With no filter every
 * account is a candidate, and the resolver falls through one that cannot give a
 * token (a grant that needs reauth) to the next.
 */
export function orderFleetAccounts<T extends FleetAccount>(
  accounts: readonly T[],
  opts: { preferId?: string; usable?: FleetAccountFilter } = {},
): T[] {
  const sorted = [...accounts].sort(
    (a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
  );
  const allowed = opts.usable ? sorted.filter(opts.usable) : sorted;
  const preferred = opts.preferId ? allowed.find((a) => a.id === opts.preferId) : undefined;
  return preferred ? [preferred, ...allowed.filter((a) => a !== preferred)] : allowed;
}

/** The first account in priority order the filter accepts, or null. */
export function pickAccount<T extends FleetAccount>(
  accounts: readonly T[],
  usable?: FleetAccountFilter,
): T | null {
  return orderFleetAccounts(accounts, { usable })[0] ?? null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function cleanLabel(label: string | undefined, kind: FleetAccountKind): string {
  const trimmed = label?.trim();
  return trimmed ? trimmed : defaultAccountLabel(kind);
}

/** Add an account at the END of its agent's priority order. */
export async function addFleetAccount(
  workspaceId: string,
  input: { kind: FleetAccountKind; credential: FleetAccountCredential; label?: string },
): Promise<FleetAccount> {
  // Adopt first, so a legacy key waiting on the row lands ahead of the new one.
  await prepareWorkspace(workspaceId);
  const agent = agentForKind(input.kind);
  const now = new Date();
  const rows = await getDbClient()
    .insert(fleetAccounts)
    .values({
      id: uuid(),
      workspaceId,
      agent,
      kind: input.kind,
      label: cleanLabel(input.label, input.kind),
      // One statement, so two concurrent adds cannot read the same maximum
      // before either writes. Ties would still order by created_at.
      priority: sql`(SELECT COALESCE(MAX("priority"), 0) + 1 FROM "fleet_accounts" WHERE "workspace_id" = ${workspaceId} AND "agent" = ${agent})`,
      credential: input.credential,
      createdAt: now,
      updatedAt: now,
    })
    .returning(FLEET_ACCOUNT_STATUS_COLUMNS);
  await mirrorLegacyKeys(workspaceId, agent);
  return toAccount(rows[0]!);
}

/**
 * Write a credential the single-credential way, by (workspace, agent, KIND).
 * The compatibility path for the old API: an old client's "save this Claude
 * key" means "this is my Claude key", and it must not cost the workspace the
 * Claude sign-in it also holds.
 *
 *   - An account of that kind exists: the first one by priority gets the new
 *     credential and keeps its id, label and priority. Its reauth mark is
 *     cleared, because the new credential is the reconnect.
 *   - None exists: a new account. A sign-in goes FIRST and a pasted key goes
 *     LAST, so a subscription still wins over a key, as it always did.
 */
export async function upsertPrimaryFleetAccount(
  workspaceId: string,
  kind: FleetAccountKind,
  credential: FleetAccountCredential,
): Promise<FleetAccount> {
  const agent = agentForKind(kind);
  const own = await listFleetAccounts(workspaceId, agent);
  const sameKind = own.find((a) => a.kind === kind);
  if (sameKind) {
    const rows = await getDbClient()
      .update(fleetAccounts)
      .set({ credential, reauthRequiredAt: null, updatedAt: new Date() })
      .where(eq(fleetAccounts.id, sameKind.id))
      .returning(FLEET_ACCOUNT_STATUS_COLUMNS);
    await mirrorLegacyKeys(workspaceId, agent);
    return toAccount(rows[0]!);
  }
  if (kind === 'anthropic_key' || kind === 'openai_key' || own.length === 0) {
    return addFleetAccount(workspaceId, { kind, credential });
  }
  // A sign-in with no account of its kind: shift the others down, then take 1.
  const db = getDbClient();
  await db
    .update(fleetAccounts)
    .set({ priority: sql`${fleetAccounts.priority} + 1`, updatedAt: new Date() })
    .where(and(eq(fleetAccounts.workspaceId, workspaceId), eq(fleetAccounts.agent, agent)));
  const now = new Date();
  const rows = await db
    .insert(fleetAccounts)
    .values({
      id: uuid(),
      workspaceId,
      agent,
      kind,
      label: defaultAccountLabel(kind),
      priority: 1,
      credential,
      createdAt: now,
      updatedAt: now,
    })
    .returning(FLEET_ACCOUNT_STATUS_COLUMNS);
  await mirrorLegacyKeys(workspaceId, agent);
  return toAccount(rows[0]!);
}

/**
 * Replace one account's credential. Clears `reauth_required_at`, because a
 * credential that was just written (a refresh, a reconnect) works.
 */
export async function updateFleetAccountCredential(
  accountId: string,
  credential: FleetAccountCredential,
): Promise<void> {
  const rows = await getDbClient()
    .update(fleetAccounts)
    .set({ credential, reauthRequiredAt: null, updatedAt: new Date() })
    .where(eq(fleetAccounts.id, accountId))
    .returning(TOUCHED_COLUMNS);
  await mirrorTouched(rows);
}

/** Rename an account. False when the workspace has no such account. */
export async function updateFleetAccountLabel(
  workspaceId: string,
  accountId: string,
  label: string,
): Promise<boolean> {
  const trimmed = label.trim();
  if (!trimmed) throw new FleetAccountError('An account needs a name.');
  const rows = await getDbClient()
    .update(fleetAccounts)
    .set({ label: trimmed, updatedAt: new Date() })
    .where(and(eq(fleetAccounts.id, accountId), eq(fleetAccounts.workspaceId, workspaceId)))
    .returning({ id: fleetAccounts.id });
  return rows.length > 0;
}

/**
 * Set an agent's priority order. `orderedIds` must name every account of that
 * agent exactly once: a partial list would leave the others with priorities
 * that collide with the new ones.
 */
export async function reorderFleetAccounts(
  workspaceId: string,
  agent: FleetAgent,
  orderedIds: readonly string[],
): Promise<FleetAccount[]> {
  const current = await listFleetAccounts(workspaceId, agent);
  const known = new Set(current.map((a) => a.id));
  const given = new Set(orderedIds);
  if (given.size !== orderedIds.length) {
    throw new FleetAccountError('The order names an account more than once.');
  }
  if (given.size !== known.size || orderedIds.some((id) => !known.has(id))) {
    throw new FleetAccountError(
      'The order must name every account of this agent exactly once. Reload and try again.',
    );
  }
  if (orderedIds.length === 0) return [];
  const cases = sql.join(
    orderedIds.map((id, i) => sql`WHEN ${id} THEN ${i + 1}::int`),
    sql` `,
  );
  await getDbClient()
    .update(fleetAccounts)
    .set({ priority: sql`CASE ${fleetAccounts.id} ${cases} END`, updatedAt: new Date() })
    .where(
      and(
        eq(fleetAccounts.workspaceId, workspaceId),
        eq(fleetAccounts.agent, agent),
        inArray(fleetAccounts.id, [...orderedIds]),
      ),
    );
  await mirrorLegacyKeys(workspaceId, agent);
  return listFleetAccounts(workspaceId, agent);
}

/** Remove one account. False when the workspace has no such account. */
export async function removeFleetAccount(workspaceId: string, accountId: string): Promise<boolean> {
  const rows = await getDbClient()
    .delete(fleetAccounts)
    .where(and(eq(fleetAccounts.id, accountId), eq(fleetAccounts.workspaceId, workspaceId)))
    .returning({ agent: fleetAccounts.agent });
  const removed = rows[0];
  if (!removed) return false;
  await mirrorLegacyKeys(workspaceId, removed.agent as FleetAgent);
  return true;
}

/** Remove an agent's accounts — all of them, or only those of the given kinds. */
export async function removeFleetAccountsForAgent(
  workspaceId: string,
  agent: FleetAgent,
  kinds?: readonly FleetAccountKind[],
): Promise<void> {
  // Adopt first: a legacy key the delete does not see would come back.
  await prepareWorkspace(workspaceId);
  await getDbClient()
    .delete(fleetAccounts)
    .where(
      and(
        eq(fleetAccounts.workspaceId, workspaceId),
        eq(fleetAccounts.agent, agent),
        kinds ? inArray(fleetAccounts.kind, [...kinds]) : undefined,
      ),
    );
  await mirrorLegacyKeys(workspaceId, agent);
}

/** Remove every account of a workspace. The integration row is the caller's. */
export async function removeAllFleetAccounts(workspaceId: string): Promise<void> {
  await getDbClient().delete(fleetAccounts).where(eq(fleetAccounts.workspaceId, workspaceId));
}

/** Store the latest usage snapshot. Never touches the credential. */
export async function setFleetAccountUsage(
  accountId: string,
  usage: FleetAccountUsage,
): Promise<void> {
  await getDbClient()
    .update(fleetAccounts)
    .set({ usage, updatedAt: new Date() })
    .where(eq(fleetAccounts.id, accountId));
}

/** Record that the vendor rejected this account's grant. */
export async function setFleetAccountReauth(accountId: string, at: Date = new Date()): Promise<void> {
  const rows = await getDbClient()
    .update(fleetAccounts)
    .set({ reauthRequiredAt: at, updatedAt: new Date() })
    .where(eq(fleetAccounts.id, accountId))
    .returning(TOUCHED_COLUMNS);
  await mirrorTouched(rows);
}

export async function clearFleetAccountReauth(accountId: string): Promise<void> {
  const rows = await getDbClient()
    .update(fleetAccounts)
    .set({ reauthRequiredAt: null, updatedAt: new Date() })
    .where(and(eq(fleetAccounts.id, accountId), isNotNull(fleetAccounts.reauthRequiredAt)))
    .returning(TOUCHED_COLUMNS);
  await mirrorTouched(rows);
}

/** Write a quota hold on accounts — one id, or every account of an agent. */
export async function setFleetAccountExhausted(
  target: { accountId: string } | { workspaceId: string; agent: FleetAgent },
  record: ExhaustedQuotaRecord,
): Promise<void> {
  // By agent, adopt first: a legacy key not yet adopted has no row to hold.
  if (!('accountId' in target)) await prepareWorkspace(target.workspaceId);
  const rows = await getDbClient()
    .update(fleetAccounts)
    .set({ quotaExhausted: record, updatedAt: new Date() })
    .where(
      'accountId' in target
        ? eq(fleetAccounts.id, target.accountId)
        : and(eq(fleetAccounts.workspaceId, target.workspaceId), eq(fleetAccounts.agent, target.agent)),
    )
    .returning(TOUCHED_COLUMNS);
  await mirrorTouched(rows);
}

/** Clear a quota hold — one id, or every account of an agent. Rows with none are not written. */
export async function clearFleetAccountExhausted(
  target: { accountId: string } | { workspaceId: string; agent: FleetAgent },
): Promise<void> {
  // By agent, adopt first, or a later adoption would copy the legacy hold back.
  if (!('accountId' in target)) await prepareWorkspace(target.workspaceId);
  const rows = await getDbClient()
    .update(fleetAccounts)
    .set({ quotaExhausted: null, updatedAt: new Date() })
    .where(
      and(
        isNotNull(fleetAccounts.quotaExhausted),
        'accountId' in target
          ? eq(fleetAccounts.id, target.accountId)
          : and(
              eq(fleetAccounts.workspaceId, target.workspaceId),
              eq(fleetAccounts.agent, target.agent),
            ),
      ),
    )
    .returning(TOUCHED_COLUMNS);
  await mirrorTouched(rows);
}
