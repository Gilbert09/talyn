import { v4 as uuid } from 'uuid';
import { and, eq, sql } from 'drizzle-orm';
import type { FleetAgent } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { integrations as integrationsTable } from '../../db/schema.js';
import {
  encryptString,
  decryptString,
  isEncryptedEnvelope,
  type EncryptedEnvelope,
} from '../tokenCrypto.js';
import { FleetCapacityError, FleetClient } from './client.js';
import {
  resolveClaudeAccessToken,
  type ClaudeCredentialStore,
  type ClaudeOAuthCredential,
} from './claudeOauth.js';
import { resolveCodexAccessToken } from './codexOauth.js';
import {
  FLEET_ACCOUNT_KINDS,
  getFleetAccountWithCredential,
  listFleetAccounts,
  listFleetAccountsWithCredential,
  orderFleetAccounts,
  removeAllFleetAccounts,
  removeFleetAccountsForAgent,
  setFleetAccountReauth,
  updateFleetAccountCredential,
  upsertPrimaryFleetAccount,
  type FleetAccountFilter,
  type FleetAccountWithCredential,
  type FleetApiKeyCredential,
  type StoredClaudeOAuth,
  type StoredCodexOAuth,
} from './accounts.js';
import { pickFleetHost } from '../fleetHosts.js';

const INTEGRATION_TYPE = 'selfhosted';

/**
 * A ChatGPT-subscription credential, as `codex login` mints it.
 *
 * Three fields rather than one because a subscription access token is short
 * lived — it is refreshed on our side, so we must hold the refresh token too —
 * and because the Codex backend wants the account id as a SECOND header
 * alongside the bearer. The account id is not a secret (it is a claim inside
 * the access token, which the fleet's proxy also reads) so it is stored in the
 * clear; both tokens are envelopes.
 */
export interface CodexOAuthCredential {
  accessTokenEnc: EncryptedEnvelope;
  refreshTokenEnc: EncryptedEnvelope;
  /** `chatgpt_account_id`, read off the access token's claims at connect time. */
  accountId: string;
  /** ISO expiry of the access token, so a refresh happens before a run, not during. */
  expiresAt: string;
  /**
   * Set when a refresh came back `invalid_grant` — the grant is gone and no
   * amount of retrying brings it back. Nothing refreshes while this is set; the
   * user has to reconnect. Same shape as PostHog Code's `oauth.reauthRequiredAt`.
   */
  reauthRequiredAt?: string;
}

/**
 * One agent's spent-quota record. `resetsAt` is present only when the vendor
 * actually named an instant — see `exhaustedQuota.ts`, which never invents one.
 */
export interface ExhaustedQuotaRecord {
  /** ISO instant the exhaustion was observed. */
  at: string;
  /** ISO instant the vendor said the quota returns, when it said so. */
  resetsAt?: string;
  /** The vendor's own sentence, for the settings card and for debugging. */
  detail?: string;
}

/**
 * The selfhosted integration row's config.
 *
 * The four CREDENTIAL keys (`claudeOAuth`, `anthropicKeyEnc`, `codexOAuth`,
 * `openaiKeyEnc`) and `quotaExhausted` are LEGACY since migration 0079: the
 * credentials live on `fleet_accounts` now, one row per account. They are read
 * only to adopt a key an old instance wrote during the deploy overlap, and every
 * account write mirrors the accounts back onto them (`mirrorLegacyKeys` in
 * `accounts.ts`), so a rolled-back backend still finds working credentials.
 * `claudePendingAuth` is still live.
 */
interface SelfHostedIntegrationConfig {
  /**
   * The workspace's Claude SUBSCRIPTION credential, signed in through OAuth and
   * refreshed in place — see `claudeOauth.ts`.
   *
   * Preferred over `anthropicKeyEnc` when both are present, for the reason
   * `codexOAuth` is preferred over `openaiKeyEnc`: it is the thing the user is
   * already paying for, and it can be renewed rather than silently expiring.
   */
  claudeOAuth?: ClaudeOAuthCredential;
  /**
   * A half-finished sign-in: the PKCE verifier, held between the authorize leg
   * and the pasted code.
   *
   * On the integration row rather than in a table of its own, unlike PostHog
   * Code's `posthog_oauth_states`. That flow needs one because its callback is
   * a redirect carrying no session, so `state` is the only thing tying the code
   * back to a workspace. Here the user pastes the code into the app, so the
   * completing request is authenticated and already names the workspace — the
   * only thing that has to survive the round trip is the verifier, and it
   * belongs to the same integration the finished credential lands on.
   */
  claudePendingAuth?: {
    /** Echoed back on the pasted `code#state`, so a stale paste is refused. */
    state: string;
    codeVerifierEnc: EncryptedEnvelope;
    expiresAt: string;
  };
  /** The workspace's own Claude credential — an OAuth token from a Claude
   *  subscription (`sk-ant-oat…`), or a Console API key (`sk-ant-api…`),
   *  pasted rather than signed in. Still supported: a metered workspace has no
   *  subscription to sign in to. */
  anthropicKeyEnc?: EncryptedEnvelope;
  /**
   * The workspace's ChatGPT-subscription credential, for runs dispatched at a
   * Codex model. Refreshed in place — see `codexOauth.ts`.
   */
  codexOAuth?: CodexOAuthCredential;
  /**
   * An OpenAI PLATFORM key (`sk-…`), the metered alternative to a subscription.
   *
   * A different credential from `codexOAuth` and not interchangeable with it:
   * the fleet's proxy classifies by shape and routes a platform key to
   * api.openai.com while a subscription token goes to the Codex backend. A
   * workspace may hold either; `codexOAuth` wins when it holds both, because
   * that is the one the user pays a subscription for.
   */
  openaiKeyEnc?: EncryptedEnvelope;

  /**
   * Agents whose subscription a vendor has told us is spent, and when (if the
   * vendor said) it comes back. Written by `exhaustedQuota.noteExhausted` on
   * the failure that discovered it; read by the fleet's dispatch, which skips
   * a spent agent instead of booting a microVM to be refused again.
   *
   * On the integration row rather than in memory because the alternative dies
   * at the next deploy — which for this repo is every push to main — and a
   * loop firing hourly would then re-discover the same exhaustion all day.
   */
  quotaExhausted?: Partial<Record<FleetAgent, ExhaustedQuotaRecord>>;

  // Legacy, read nowhere. Both were fields on the settings card and neither was
  // ever the workspace's to give: `fleetTokenEnc` authenticated the BACKEND to a
  // host, and `fleetEndpoint` chose WHICH host, which is the registry's job.
  // They live in deployment config now (FLEET_API_TOKEN / FLEET_PINNED_ENDPOINT)
  // and stay in the type so an old row is recognisably old rather than
  // mysteriously shaped.
  fleetTokenEnc?: EncryptedEnvelope;
  fleetEndpoint?: string;
}

/**
 * A workspace's fleet credentials, resolved and ready to send.
 *
 * BOTH are optional and at least one is always set — a workspace may connect
 * Claude, Codex, or both. That is a change from when `claudeToken` was
 * mandatory: a Codex-only workspace used to read as "the fleet is not
 * configured", which is the wrong answer to a different question.
 *
 * Neither field is ever an empty string. The dispatch path sends exactly one of
 * them and REFUSES when the one its model needs is absent, because the sandbox
 * gateway fills an absent or blank key from its own tenant's sealed custody —
 * so a blank here would silently spend somebody else's subscription.
 */
export interface SelfHostedCredentials {
  /** `sk-ant-oat…` (OAuth) or `sk-ant-api…` (Console key) — the fleet's
   *  credential proxy accepts either and picks the right auth header. */
  claudeToken?: string;
  /** The FLEET ACCOUNT `claudeToken` came from (a `fleet_accounts.id`). */
  claudeAccountId?: string;
  /**
   * The FLEET ACCOUNT `openaiKey` came from (a `fleet_accounts.id`). Not the
   * ChatGPT account id, which stays a claim inside the token.
   */
  codexAccountId?: string;
  /**
   * A ChatGPT-subscription access token (already refreshed if it was due), or an
   * OpenAI platform key. Same story: the proxy classifies it by shape.
   *
   * The ChatGPT ACCOUNT ID is deliberately not carried beside it. The Codex
   * backend does want it as a second header, but it is a claim inside the token
   * and the fleet's proxy reads it there (`proxy.authCodex`) — a copy here would
   * be a second source for something the credential already contains. We decode
   * it once, at connect time, only to refuse a token that has none.
   */
  openaiKey?: string;
}

/**
 * The bearer the backend presents to a fleet host's API.
 *
 * Deployment config, not a workspace secret. It authenticates ONE service to
 * another — every host in a deployment shares it, and no user of the product
 * has any reason to know it exists, let alone to paste it into a settings form.
 * Putting it in the UI made the workspace responsible for a credential it does
 * not own and cannot rotate.
 *
 * Set it on the backend and on every host's `/etc/fleet/secrets.env`
 * (`FLEET_API_TOKEN`); the two must match or dispatch 401s.
 */
export function fleetApiToken(): string {
  return process.env.FLEET_API_TOKEN ?? '';
}

/**
 * The bearer the backend presents to the SANDBOX GATEWAY, when one is pinned.
 *
 * A gateway and a fleet host are different trust domains and issue different
 * credentials. `FLEET_API_TOKEN` is a deployment-wide operator secret shared
 * with every host's `/etc/fleet/secrets.env`; a gateway key is a per-tenant API
 * key the gateway minted and can revoke on its own. Sending either one to the
 * other simply 401s.
 *
 * They cannot be the same variable because BOTH destinations are still in use:
 * dispatch goes to the gateway, while the operator console keeps talking to
 * hosts directly — deliberately, since draining a specific box and reading its
 * goldens are host operations that no gateway route covers. Reusing
 * FLEET_API_TOKEN for the pin therefore fixes dispatch and blanks the console.
 *
 * Falls back to `fleetApiToken()`, so a deployment that has not been given a
 * gateway key behaves exactly as it did before this existed.
 */
export function fleetGatewayToken(): string {
  return process.env.FLEET_GATEWAY_TOKEN?.trim() || fleetApiToken();
}

/**
 * The ONE endpoint dispatch addresses: the sandbox gateway. Blank falls back to
 * dialling a host out of the registry.
 *
 * # This is the normal path now, not an override
 *
 * The variable is called `FLEET_PINNED_ENDPOINT` because it began as a
 * debugging pin — force every run onto one box while you bisect it — and the
 * name is deployed, so renaming it would be a coordinated restart of the
 * backend to change a string. What it points at changed on 2026-08-24: it is
 * the control plane, which does the placing itself.
 *
 * That inverts the old warning rather than repeating it. Pinned at a HOST this
 * really was dangerous — one box, chosen once, no idea whether it is draining
 * or offline, and a stale value silently routed every task to a machine that
 * had been down for a week. Pinned at the GATEWAY it is the opposite: the
 * gateway reads the same reports the registry does, places per create, retries
 * a 503 on the next candidate, and — the part no client-side registry can do —
 * refuses to offer an AGENTIC id to a second host when an answer is lost. A
 * duplicated sandbox is idle capacity; a duplicated agent is a second LLM bill
 * for the same work, and only the party holding the index can prevent it.
 *
 * The registry fallback stays, and is not dead code: it is what a deployment
 * with no control plane uses, and it is the path every run took before this.
 * It is also still the operator console's path — see fleetGatewayToken.
 */
export function fleetPinnedEndpoint(): string {
  return (process.env.FLEET_PINNED_ENDPOINT ?? '').replace(/\/+$/, '');
}

/** Thrown when the deployment itself is misconfigured — not a per-workspace fault. */
export class FleetNotDeployedError extends Error {
  constructor() {
    super(
      'Neither FLEET_GATEWAY_TOKEN nor FLEET_API_TOKEN is set on the backend, so it cannot ' +
        'authenticate to the sandbox gateway or to any fleet host. ' +
        'This is deployment configuration, not a workspace setting.',
    );
    this.name = 'FleetNotDeployedError';
  }
}

function readEnc(env: EncryptedEnvelope | undefined, label: string): string | null {
  if (env && isEncryptedEnvelope(env)) {
    try {
      return decryptString(env);
    } catch (err) {
      console.error(`[selfhosted] failed to decrypt ${label}:`, err);
      return null;
    }
  }
  return null;
}

/**
 * How `claudeOauth.ts` reads and writes one account's stored pair.
 *
 * Passed in rather than imported there, so the OAuth module owns the protocol
 * and this module owns the row — and so its tests need no database. The
 * account's `reauth_required_at` column travels as the credential's
 * `reauthRequiredAt`.
 */
export const claudeStore: ClaudeCredentialStore = {
  read: async (accountId) => {
    const account = await getFleetAccountWithCredential(accountId);
    if (!account || account.kind !== 'claude_oauth') return undefined;
    return toClaudeCredential(account);
  },
  patch: async (accountId, next) => {
    const { reauthRequiredAt, ...credential } = next;
    // Marking a dead grant leaves the pair as it is; writing a new pair clears
    // the mark, because a pair that was just issued works.
    if (reauthRequiredAt) await setFleetAccountReauth(accountId, new Date(reauthRequiredAt));
    else await updateFleetAccountCredential(accountId, credential);
  },
};

function toClaudeCredential(account: FleetAccountWithCredential): ClaudeOAuthCredential {
  return {
    ...(account.credential as StoredClaudeOAuth),
    ...(account.reauthRequiredAt ? { reauthRequiredAt: account.reauthRequiredAt } : {}),
  };
}

function toCodexCredential(account: FleetAccountWithCredential): CodexOAuthCredential {
  return {
    ...(account.credential as StoredCodexOAuth),
    ...(account.reauthRequiredAt ? { reauthRequiredAt: account.reauthRequiredAt } : {}),
  };
}

/** The raw integration config for a workspace, or undefined when unconfigured. */
async function readSelfHostedConfig(
  workspaceId: string,
): Promise<SelfHostedIntegrationConfig | undefined> {
  const rows = await getDbClient()
    .select({ config: integrationsTable.config, enabled: integrationsTable.enabled })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || !row.enabled) return undefined;
  return (row.config as SelfHostedIntegrationConfig | null) ?? {};
}

/**
 * Merge fields into the stored config, creating the row if there is none.
 *
 * A read-modify-write rather than a jsonb patch because the row is small and
 * written rarely — and because a refresh racing a disconnect should lose the
 * whole write, not half of it.
 *
 * # It used to return silently when the row was missing, and that broke sign-in
 *
 * The Claude OAuth authorize leg stores its PKCE verifier here before sending
 * the user to Anthropic. With no row it wrote NOTHING, answered 200 with a
 * perfectly good authorize URL, and left the user to complete a real sign-in
 * against a server that had no memory of starting one — so `/complete` reported
 * "this one was not found", every time, with no way through.
 *
 * Nobody could hit it while the fleet was allow-listed: every allow-listed
 * workspace had been set up by hand and already had a row. Releasing the fleet
 * made "no row yet" the normal state for a new user, and the first one to try
 * it was stuck. Disconnecting DELETES the row outright (see
 * `removeSelfHostedCredentials`), so disconnect-then-reconnect was the same
 * dead end for an existing user.
 *
 * The no-op was not defensive — a caller asking to store something and getting
 * silence back cannot tell that from success. `setSelfHostedCredentials` had
 * always upserted for exactly this reason; this now matches it.
 *
 * A patch that only DELETES keys still no-ops on a missing row: clearing a
 * pending sign-in that was never stored has nothing to write, and creating an
 * empty row to represent "nothing" would make `hasCredentials` answer for a
 * workspace that has never connected anything.
 */
async function patchSelfHostedConfig(
  workspaceId: string,
  patch: Partial<SelfHostedIntegrationConfig>,
): Promise<void> {
  // A finished Claude sign-in is an ACCOUNT now, not a config key. The sign-in
  // route still hands it over this way, so it lands on the Claude sign-in account
  // here — the same compat rule as `storeSelfHostedCredentials`.
  if (patch.claudeOAuth) {
    const { claudeOAuth, ...rest } = patch;
    await writeConfigPatch(workspaceId, { ...rest, enabledRow: true });
    const { reauthRequiredAt: _dropped, ...credential } = claudeOAuth;
    await upsertPrimaryFleetAccount(workspaceId, 'claude_oauth', credential);
    return;
  }
  await writeConfigPatch(workspaceId, patch);
}

async function writeConfigPatch(
  workspaceId: string,
  input: Partial<SelfHostedIntegrationConfig> & { enabledRow?: boolean },
): Promise<void> {
  const { enabledRow, ...patch } = input;
  const db = getDbClient();
  const rows = await db
    .select({ id: integrationsTable.id, config: integrationsTable.config })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    )
    .limit(1);
  const row = rows[0];
  const prior = (row?.config as SelfHostedIntegrationConfig | null) ?? {};
  const next: SelfHostedIntegrationConfig = { ...prior };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete (next as Record<string, unknown>)[key];
    else (next as Record<string, unknown>)[key] = value;
  }

  const now = new Date();
  if (row) {
    // Only the patched keys change. Writing back the whole config read above
    // would overwrite the legacy keys a concurrent account write mirrored.
    const removed = Object.entries(patch).filter(([, value]) => value === undefined).map(([key]) => key);
    const set = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    const base = sql`CASE WHEN jsonb_typeof(${integrationsTable.config}) = 'object' THEN ${integrationsTable.config} ELSE '{}'::jsonb END`;
    const stripped = removed.reduce((acc, key) => sql`(${acc} - ${key}::text)`, base);
    await db
      .update(integrationsTable)
      .set({ config: sql`${stripped} || ${JSON.stringify(set)}::jsonb`, updatedAt: now })
      .where(eq(integrationsTable.id, row.id));
    return;
  }
  // Nothing to store and nothing to store it in — unless an account is about
  // to be written, which needs the row to say the fleet is on.
  if (Object.keys(next).length === 0 && !enabledRow) return;
  await db.insert(integrationsTable).values({
    id: uuid(),
    workspaceId,
    type: INTEGRATION_TYPE,
    enabled: true,
    config: next,
    createdAt: now,
    updatedAt: now,
  });
}

export { readSelfHostedConfig, patchSelfHostedConfig };

/** What `getSelfHostedCredentials` may be told about which accounts to use. */
export interface SelfHostedCredentialOptions {
  /** Try this Claude account first (a running task's pinned account). */
  claudeAccountId?: string;
  /** Try this Codex account first. */
  codexAccountId?: string;
  /**
   * Which accounts may be used at all. The seam for the usage threshold: an
   * account the filter refuses is never resolved. Absent = every account.
   */
  accountFilter?: FleetAccountFilter;
}

/**
 * Resolve a workspace's fleet credentials, or null when it holds none.
 *
 * AN AGENT CREDENTIAL is what makes a workspace configured — EITHER vendor's. A
 * Codex-only workspace is fully configured and must not read as "the fleet is
 * not set up", which would send the user back to a form they already filled in.
 *
 * Each agent's accounts are tried in priority order (the preferred id first,
 * when given). An account that cannot give a token — a grant that needs
 * reauth — falls through to the next, which is what a signed-in subscription
 * with a pasted key behind it always did. When no account gives a token and one
 * of them THREW, that error is thrown: a refresh that failed on an expired
 * token must not read as "not connected".
 */
export async function getSelfHostedCredentials(
  workspaceId: string,
  opts: SelfHostedCredentialOptions = {},
): Promise<SelfHostedCredentials | null> {
  const accounts = await listFleetAccountsWithCredential(workspaceId);
  if (accounts.length === 0) return null;

  const claude = await resolveAgentToken(
    orderFleetAccounts(
      accounts.filter((a) => a.agent === 'claude'),
      { preferId: opts.claudeAccountId, usable: opts.accountFilter },
    ),
  );
  const codex = await resolveAgentToken(
    orderFleetAccounts(
      accounts.filter((a) => a.agent === 'codex'),
      { preferId: opts.codexAccountId, usable: opts.accountFilter },
    ),
  );
  if (!claude && !codex) return null;

  return {
    ...(claude ? { claudeToken: claude.token, claudeAccountId: claude.accountId } : {}),
    ...(codex ? { openaiKey: codex.token, codexAccountId: codex.accountId } : {}),
  };
}

async function resolveAgentToken(
  candidates: FleetAccountWithCredential[],
): Promise<{ token: string; accountId: string } | null> {
  let firstError: unknown;
  for (const account of candidates) {
    try {
      const token = await resolveAccountToken(account);
      if (token) return { token, accountId: account.id };
    } catch (err) {
      firstError ??= err;
    }
  }
  if (firstError !== undefined) throw firstError;
  return null;
}

/** One account's usable token, refreshed if it was due. Null = nothing usable. */
async function resolveAccountToken(account: FleetAccountWithCredential): Promise<string | null> {
  switch (account.kind) {
    case 'claude_oauth':
      return resolveClaudeAccessToken(account.id, toClaudeCredential(account), claudeStore);
    case 'codex_oauth':
      return (await resolveCodexAccessToken(account.id, toCodexCredential(account)))?.accessToken ?? null;
    case 'anthropic_key':
      return readEnc((account.credential as FleetApiKeyCredential).keyEnc, 'Claude token');
    case 'openai_key':
      return readEnc((account.credential as FleetApiKeyCredential).keyEnc, 'OpenAI key');
    default:
      return null;
  }
}

/** Build a client for a workspace, or null if it isn't configured. */
export async function getSelfHostedClient(workspaceId: string): Promise<FleetClient | null> {
  const target = await resolveFleetTarget(workspaceId);
  return target ? new FleetClient(target.endpoint, target.token) : null;
}

/** Where a workspace's fleet runs, and how to authenticate to it. */
export interface FleetTarget {
  endpoint: string;
  token: string;
  /**
   * The host this resolved to, when the REGISTRY chose it.
   *
   * Absent for the gateway, which has not placed anything yet at the moment this
   * is called. Nothing may treat that absence as "unknown forever": the create
   * answers with the name (FleetClient.createSandbox), and the dispatch records
   * it, because `resolveRunCredentials` refuses a credential pull for a run with
   * no host on it.
   */
  host?: string;
}

/**
 * Resolve where this workspace's next run goes, and how to authenticate to it.
 *
 * The credential says WHETHER a workspace may use the fleet; something else
 * says WHERE. Splitting them is what makes more than one host possible: a
 * workspace does not know which box is least loaded, or which is draining, or
 * which has stopped reporting, so it was never in a position to choose one.
 *
 * Order:
 *   1. The GATEWAY (`FLEET_PINNED_ENDPOINT`), when one is configured. The
 *      normal path: it does the placing, so this returns no `host` and the
 *      caller learns which box took the work from the create's own answer —
 *      see FleetTarget.host and FleetClient.createSandbox.
 *   2. The least-loaded dispatchable host in the local registry. The path a
 *      deployment with no control plane takes, and the one every run took
 *      before the gateway.
 *
 * Returns null when the workspace has no credential at all — the fleet is not
 * configured for it, which is different from "configured and nothing is up".
 * That distinction is why the second case throws rather than returning null:
 * "you have not set this up" and "your hardware is down" need different
 * answers, and collapsing them into one silent null gives neither.
 */
export async function resolveFleetTarget(workspaceId: string): Promise<FleetTarget | null> {
  const creds = await getSelfHostedCredentials(workspaceId);
  if (!creds) return null;

  // Deliberately thrown, not returned as null: a missing deployment token is
  // an operator error and every workspace hits it identically. Reporting it as
  // "not configured" would send the user back to a settings form they have
  // already filled in correctly.
  // The gateway is resolved BEFORE the host token, because it is authenticated
  // by a different credential — see fleetGatewayToken. Reading FLEET_API_TOKEN
  // first would make a gateway-only deployment fail on a variable it has no
  // reason to set.
  const gateway = fleetPinnedEndpoint();
  if (gateway) {
    const gatewayToken = fleetGatewayToken();
    if (!gatewayToken) throw new FleetNotDeployedError();
    // No `host`, and that is the honest answer rather than a gap: placement has
    // not happened yet. The create's response names the box that took it.
    return { endpoint: gateway, token: gatewayToken };
  }

  const token = fleetApiToken();
  if (!token) throw new FleetNotDeployedError();

  const host = await pickFleetHost();
  if (!host?.apiEndpoint) {
    // A capacity error, not a terminal one: no host is dispatchable right now,
    // which is exactly the condition fail-back exists for (§11.6). Failing the
    // user's task because every box is busy or offline would be the wrong
    // shape — another provider can still run it.
    throw new FleetCapacityError(
      'no self-hosted fleet host is currently dispatchable ' +
        '(none registered, all draining, all at capacity, or none advertising an endpoint)',
    );
  }
  return { endpoint: host.apiEndpoint, token, host: host.name };
}

/**
 * What a save may change. Every field is optional and `null` means "clear this
 * vendor" — a workspace may connect Claude, connect Codex, or drop one without
 * touching the other.
 */
export interface SelfHostedCredentialPatch {
  /** `sk-ant-oat…` or `sk-ant-api…`. */
  claudeToken?: string | null;
  /** A completed ChatGPT-subscription sign-in. */
  codex?: CodexOAuthCredential | null;
  /** An OpenAI PLATFORM key (`sk-…`) — the metered alternative to a subscription. */
  openaiKey?: string | null;
}

/**
 * Save a workspace's fleet credentials the single-credential way — the old
 * `PUT /cloud-providers/selfhosted/config` body, which old desktop builds still
 * send.
 *
 * Each credential maps onto ACCOUNTS, by kind (see `upsertPrimaryFleetAccount`):
 *   - a credential writes the first account of ITS kind, or adds one — a
 *     sign-in first, a pasted key last; other accounts are left alone;
 *   - `claudeToken: null` removes every Claude account;
 *   - `codex: null` with `openaiKey: null` removes every Codex account, and
 *     either one alone removes only the accounts of that kind. The provider
 *     sends `openaiKey: null` beside a new Codex sign-in, which is how the old
 *     config replaced a key with a subscription; that is kept.
 *
 * It also makes sure the integration row exists and is enabled, and drops the
 * dead `fleetTokenEnc`/`fleetEndpoint` keys from it: a workspace configured
 * before those left the card still carries them, and keeping them would look
 * like a per-workspace routing override that nothing honours.
 */
export async function storeSelfHostedCredentials(
  workspaceId: string,
  patch: SelfHostedCredentialPatch,
): Promise<void> {
  const db = getDbClient();
  const existing = await db
    .select({ id: integrationsTable.id })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    )
    .limit(1);

  const now = new Date();
  if (existing[0]) {
    // Remove the two keys in SQL rather than writing back the config read
    // above, which would overwrite keys a concurrent write changed.
    await db
      .update(integrationsTable)
      .set({
        config: sql`(CASE WHEN jsonb_typeof(${integrationsTable.config}) = 'object' THEN ${integrationsTable.config} ELSE '{}'::jsonb END) - 'fleetTokenEnc'::text - 'fleetEndpoint'::text`,
        enabled: true,
        updatedAt: now,
      })
      .where(eq(integrationsTable.id, existing[0].id));
  } else {
    await db.insert(integrationsTable).values({
      id: uuid(),
      workspaceId,
      type: INTEGRATION_TYPE,
      enabled: true,
      config: {},
      createdAt: now,
      updatedAt: now,
    });
  }

  if (patch.claudeToken === null) {
    await removeFleetAccountsForAgent(workspaceId, 'claude');
  } else if (patch.claudeToken !== undefined) {
    await upsertPrimaryFleetAccount(workspaceId, 'anthropic_key', {
      keyEnc: encryptString(patch.claudeToken),
    });
  }

  if (patch.codex === null && patch.openaiKey === null) {
    await removeFleetAccountsForAgent(workspaceId, 'codex');
    return;
  }
  // Each field on its own, as the old config keys were: a set writes that
  // kind's account, a null removes that kind's accounts and nothing else.
  if (patch.codex) {
    const { reauthRequiredAt: _dropped, ...credential } = patch.codex;
    await upsertPrimaryFleetAccount(workspaceId, 'codex_oauth', credential);
  } else if (patch.codex === null) {
    await removeFleetAccountsForAgent(workspaceId, 'codex', ['codex_oauth']);
  }
  if (patch.openaiKey) {
    await upsertPrimaryFleetAccount(workspaceId, 'openai_key', {
      keyEnc: encryptString(patch.openaiKey),
    });
  } else if (patch.openaiKey === null) {
    await removeFleetAccountsForAgent(workspaceId, 'codex', ['openai_key']);
  }
}

/**
 * Which agent vendors a workspace has connected, and which of them need
 * reconnecting. Presence only — never the values.
 *
 * A dead Codex grant is reported as CONNECTED AND needing reauth, not as
 * disconnected: the settings card has to render the agent to offer a
 * "Reconnect" button, and dropping it from the list would tell the user they
 * never set it up.
 */
export async function fleetAgentStatus(
  workspaceId: string,
): Promise<{ connectedAgents: ('claude' | 'codex')[]; reauthAgents: ('claude' | 'codex')[] }> {
  const accounts = await listFleetAccounts(workspaceId);
  const connectedAgents: ('claude' | 'codex')[] = [];
  const reauthAgents: ('claude' | 'codex')[] = [];
  for (const agent of Object.keys(FLEET_ACCOUNT_KINDS) as ('claude' | 'codex')[]) {
    const own = accounts.filter((a) => a.agent === agent);
    if (own.length === 0) continue;
    connectedAgents.push(agent);
    // Only when EVERY account needs it. A workspace with one account still able
    // to run has nothing it must do, so asking it to sign in again would be
    // asking for something it does not need.
    if (own.every((a) => a.reauthRequiredAt)) reauthAgents.push(agent);
  }
  return { connectedAgents, reauthAgents };
}

/** Remove a workspace's fleet credentials: every account and the integration row. */
export async function removeSelfHostedCredentials(workspaceId: string): Promise<void> {
  const db = getDbClient();
  await removeAllFleetAccounts(workspaceId);
  await db
    .delete(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    );
}
