import { Router, type Request, type Response } from 'express';
import { DEFAULT_FLEET_SWITCH_AT_PERCENT, cloudProviderRank, type CloudProviderType, type ApiResponse, type FleetAgent, type FleetAccountView, type FleetAccountsResponse } from '@talyn/shared';
import { randomBytes } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { buildAuthorizeUrl, exchangeCode, splitPastedCode } from '../services/selfHosted/claudeOauth.js';
import {
  patchSelfHostedConfig,
  readSelfHostedConfig,
} from '../services/selfHosted/credentials.js';
import { createPkcePair } from '../services/posthogCode/oauth.js';
import { decryptString, encryptString } from '../services/tokenCrypto.js';

/**
 * How long a half-finished Claude sign-in stays valid.
 *
 * Short enough that an abandoned attempt does not leave a usable verifier lying
 * in the row, long enough for what the user is actually being asked to do — and
 * the first version budgeted ten minutes for that, which measured the wrong
 * thing. It is not "approve a prompt": a new user opens Anthropic, signs in or
 * creates an account, clears 2FA, picks an organisation, and only then gets a
 * code to copy back. Half an hour covers that without being an eternity for a
 * secret at rest, and the failure it prevents is the one that reads as the flow
 * being broken rather than as having taken too long.
 *
 * Expiry clears the row, so a user who does overrun is told to start again and
 * can — which is only true since the authorize leg started creating the row it
 * writes to. See `patchSelfHostedConfig`.
 */
const PENDING_AUTH_TTL_MS = 30 * 60_000;

/** Opaque, single-use, and only ever compared against what we minted. */
function randomState(): string {
  return randomBytes(16).toString('hex');
}
import { getCloudProvider, listCloudProviders } from '../services/cloudProviders/registry.js';
import {
  ensureCloudEnvironment,
  notifyProviderConnected,
} from '../services/cloudProviders/environment.js';
import { fleetRefusalReason, workspaceMayUseFleet } from '../services/cloudProviders/fleetAccess.js';
import { fleetAgentStatus } from '../services/selfHosted/credentials.js';
import { clearExhaustedAgent } from '../services/selfHosted/exhaustedQuota.js';
import { clearExhaustedAccount, isHeldBack, probeAfter } from '../services/selfHosted/exhaustedQuota.js';
import { addFleetAccount, getFleetAccount, listFleetAccounts, removeFleetAccount, reorderFleetAccounts, updateFleetAccountCredential, updateFleetAccountLabel, FleetAccountError, type FleetAccount } from '../services/selfHosted/accounts.js';
import { refreshFleetAccountUsage } from '../services/selfHosted/accountUsage.js';
import { isOverThreshold } from '../services/selfHosted/usage.js';
import { workspaceHasFeature } from '../services/featureFlags.js';
import { fleetApiKeyError } from '../services/cloudProviders/selfhosted/provider.js';

async function mayAddAccount(workspaceId: string, agent: FleetAgent): Promise<boolean> {
  const existing = await listFleetAccounts(workspaceId, agent);
  return existing.length === 0 || (await workspaceHasFeature('fleetMultiAccount', workspaceId)).enabled;
}

async function accountForCaller(req: Request, res: Response): Promise<FleetAccount | null> {
  const account = await getFleetAccount(req.params.id);
  if (account) {
    try {
      await requireWorkspaceAccess(req, account.workspaceId);
      return account;
    } catch { /* Hide account ids from other workspaces. */ }
  }
  res.status(404).json({ success: false, error: 'Account not found' });
  return null;
}

function toFleetAccountView(account: FleetAccount, threshold: number): FleetAccountView {
  const held = account.quotaExhausted && isHeldBack(account.quotaExhausted)
    ? { until: new Date(probeAfter(account.quotaExhausted)).toISOString() }
    : null;
  const usage = account.usage && 'windows' in account.usage
    ? { fetchedAt: account.usage.fetchedAt, windows: account.usage.windows.map(({ key, label, usedPercent, resetsAt }) => ({ key, label, usedPercent, resetsAt })) }
    : account.usage;
  const needsReauth = Boolean(account.reauthRequiredAt);
  return {
    id: account.id, agent: account.agent, kind: account.kind, label: account.label,
    priority: account.priority, needsReauth, held, usage,
    over: needsReauth || Boolean(held) || Boolean(account.usage && 'windows' in account.usage && isOverThreshold(account.usage.windows, threshold)),
  };
}

const usageRefreshAt = new Map<string, number>();

interface CloudProviderInfo {
  type: CloudProviderType;
  displayName: string;
  capabilities?: { model?: boolean; runtimeAdapter?: boolean };
  connected: boolean;
  /**
   * Which agent vendors are connected behind this provider.
   *
   * Only Talyn Fleet has more than one — it runs the workspace's own Claude
   * subscription or its own Codex subscription, and `connected` alone cannot
   * say which. The per-task picker needs to know: offering "Talyn Fleet · Codex"
   * to a workspace that never connected Codex produces a task that is refused at
   * dispatch, which is a worse answer than not offering it.
   *
   * Presence only, never values.
   */
  connectedAgents?: FleetAgent[];
  /**
   * Agents whose stored sign-in was REJECTED and cannot be refreshed — the user
   * has to reconnect. Still listed in `connectedAgents`, deliberately: the card
   * has to render the agent to offer "Reconnect", and hiding it would read as
   * "you never set this up".
   */
  reauthAgents?: FleetAgent[];
}

/**
 * Generic, provider-agnostic surface for cloud task providers. Lists the
 * registered providers + their per-workspace connection status, and proxies
 * credential CRUD to each provider's own methods. Adding a provider needs
 * no change here — it registers in index.ts and shows up automatically.
 */
export function cloudProviderRoutes(): Router {
  const router = Router();

  router.get('/selfhosted/accounts', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) return res.status(400).json({ success: false, error: 'workspaceId is required' });
    try { await requireWorkspaceAccess(req, workspaceId); }
    catch (err) { return handleAccessError(err, res); }
    if (!(await workspaceMayUseFleet(workspaceId))) {
      return res.status(403).json({ success: false, error: fleetRefusalReason() });
    }
    const [row] = await getDbClient().select({ threshold: sql<number | null>`(${workspacesTable.settings} ->> 'fleetSwitchAtPercent')::int` })
      .from(workspacesTable).where(eq(workspacesTable.id, workspaceId)).limit(1);
    const threshold = row?.threshold ?? DEFAULT_FLEET_SWITCH_AT_PERCENT;
    const accounts = await listFleetAccounts(workspaceId);
    const refreshed = await Promise.all(accounts.map(async (account) => ({
      ...account,
      usage: await refreshFleetAccountUsage(account).catch(() => account.usage),
    })));
    const views = refreshed.map((account) => toFleetAccountView(account, threshold));
    const active: FleetAccountsResponse['active'] = { claude: null, codex: null };
    for (const account of views) {
      if (!account.over && !active[account.agent]) active[account.agent] = account.id;
    }
    res.json({ success: true, data: { accounts: views, switchAtPercent: threshold, active } satisfies FleetAccountsResponse });
  });

  router.post('/selfhosted/accounts', async (req, res) => {
    const { workspaceId, agent, kind, key, label } = req.body as {
      workspaceId?: string; agent?: FleetAgent; kind?: 'anthropic_key' | 'openai_key'; key?: string; label?: string;
    };
    if (!workspaceId || (agent !== 'claude' && agent !== 'codex') ||
        (kind !== 'anthropic_key' && kind !== 'openai_key') ||
        (agent === 'claude' ? kind !== 'anthropic_key' : kind !== 'openai_key') ||
        typeof key !== 'string' || (label !== undefined && typeof label !== 'string')) {
      return res.status(400).json({ success: false, error: 'Invalid account' });
    }
    try { await requireWorkspaceAccess(req, workspaceId); }
    catch (err) { return handleAccessError(err, res); }
    if (!(await workspaceMayUseFleet(workspaceId))) {
      return res.status(403).json({ success: false, error: fleetRefusalReason() });
    }
    const keyError = fleetApiKeyError(kind, key);
    if (keyError) return res.status(400).json({ success: false, error: keyError });
    if (!(await mayAddAccount(workspaceId, agent))) {
      return res.status(403).json({ success: false, code: 'multi_account_disabled', error: 'Multiple accounts are disabled' });
    }
    const account = await addFleetAccount(workspaceId, { kind, credential: { keyEnc: encryptString(key) }, label });
    await ensureCloudEnvironment(assertUser(req).id, 'selfhosted');
    res.status(201).json({ success: true, data: toFleetAccountView(account, DEFAULT_FLEET_SWITCH_AT_PERCENT) });
  });

  router.put('/selfhosted/accounts/order', async (req, res) => {
    const { workspaceId, agent, ids } = req.body as { workspaceId?: string; agent?: FleetAgent; ids?: string[] };
    if (!workspaceId || (agent !== 'claude' && agent !== 'codex') || !Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      return res.status(400).json({ success: false, error: 'Invalid account order' });
    }
    try { await requireWorkspaceAccess(req, workspaceId); }
    catch (err) { return handleAccessError(err, res); }
    if (!(await workspaceMayUseFleet(workspaceId))) return res.status(403).json({ success: false, error: fleetRefusalReason() });
    try {
      const ordered = await reorderFleetAccounts(workspaceId, agent, ids);
      res.json({ success: true, data: ordered.map((account) => toFleetAccountView(account, DEFAULT_FLEET_SWITCH_AT_PERCENT)) });
    } catch (err) {
      if (err instanceof FleetAccountError) return res.status(400).json({ success: false, error: err.message });
      throw err;
    }
  });

  router.patch('/selfhosted/accounts/:id', async (req, res) => {
    const account = await accountForCaller(req, res);
    if (!account) return;
    if (!(await workspaceMayUseFleet(account.workspaceId))) return res.status(403).json({ success: false, error: fleetRefusalReason() });
    const { label } = req.body as { label?: string };
    if (typeof label !== 'string') return res.status(400).json({ success: false, error: 'label is required' });
    try {
      await updateFleetAccountLabel(account.workspaceId, account.id, label);
      res.json({ success: true });
    } catch (err) {
      if (err instanceof FleetAccountError) return res.status(400).json({ success: false, error: err.message });
      throw err;
    }
  });

  router.delete('/selfhosted/accounts/:id', async (req, res) => {
    const account = await accountForCaller(req, res);
    if (!account) return;
    if (!(await workspaceMayUseFleet(account.workspaceId))) return res.status(403).json({ success: false, error: fleetRefusalReason() });
    await removeFleetAccount(account.workspaceId, account.id);
    res.json({ success: true });
  });

  router.post('/selfhosted/accounts/:id/usage/refresh', async (req, res) => {
    const account = await accountForCaller(req, res);
    if (!account) return;
    if (!(await workspaceMayUseFleet(account.workspaceId))) return res.status(403).json({ success: false, error: fleetRefusalReason() });
    const now = Date.now();
    if (now - (usageRefreshAt.get(account.id) ?? 0) < 30_000) {
      return res.status(429).json({ success: false, error: 'Try again in 30 seconds' });
    }
    usageRefreshAt.set(account.id, now);
    const usage = await refreshFleetAccountUsage(account, 60_000, true);
    res.json({ success: true, data: usage });
  });

  // List providers + connected status for a workspace.
  router.get('/', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    // Hiding a provider this workspace may not use is COSMETIC — it keeps the
    // settings screen honest, and nothing more. The gate that matters is at
    // dispatch and at credential-write below, because a filtered list is not a
    // permission check: the CLI, the MCP server and curl never render it.
    const mayUseFleet = await workspaceMayUseFleet(workspaceId);
    // Sorted by Talyn's own preference, NOT by the order the providers happened
    // to register at boot. This list is what the Settings cards, the "Default
    // for new tasks" menu and the per-task agent picker all render from, so
    // boot order was quietly deciding what the app recommends — and it
    // recommended PostHog Code while the resolver picked the fleet.
    const providers: CloudProviderInfo[] = await Promise.all(
      listCloudProviders()
        .filter((p) => p.type !== 'selfhosted' || mayUseFleet)
        .sort((a, b) => cloudProviderRank(a.type) - cloudProviderRank(b.type))
        .map(async (p) => ({
          type: p.type,
          displayName: p.displayName,
          capabilities: p.capabilities,
          connected: await p.hasCredentials(workspaceId),
          ...(p.type === 'selfhosted' ? await fleetAgentStatus(workspaceId) : {}),
        })),
    );
    res.json({ success: true, data: providers } as ApiResponse<CloudProviderInfo[]>);
  });

  // Validate + store credentials, then auto-provision the env marker.
  router.put('/:type/config', async (req, res) => {
    const provider = getCloudProvider(req.params.type);
    if (!provider) {
      return res.status(404).json({ success: false, error: 'Unknown cloud provider' });
    }
    const { workspaceId } = req.body as { workspaceId?: string };
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }

    // Refuse before any credential is validated or stored. A workspace that
    // cannot dispatch to the fleet has no business holding a fleet token: it
    // would sit encrypted in the integrations row forever, and the first thing
    // anyone would try after being told "not allowed" is to configure it again.
    if (provider.type === 'selfhosted' && !(await workspaceMayUseFleet(workspaceId))) {
      return res.status(403).json({ success: false, error: fleetRefusalReason() });
    }

    let providerBody = req.body;
    if (provider.type === 'selfhosted') {
      const body = req.body as { claudeToken?: string; codexAccessToken?: string; openaiKey?: string; codexAccountId?: string; codexLabel?: string };
      if ((body.codexAccountId !== undefined && typeof body.codexAccountId !== 'string') ||
          (body.codexLabel !== undefined && (typeof body.codexLabel !== 'string' || !body.codexLabel.trim()))) {
        return res.status(400).json({ success: false, error: 'Invalid Codex account target' });
      }
      if (body.codexAccessToken && body.codexAccountId) {
        const target = await getFleetAccount(body.codexAccountId);
        if (target) {
          if (target.workspaceId !== workspaceId || target.agent !== 'codex' || target.kind !== 'codex_oauth') {
            return res.status(404).json({ success: false, error: 'Account not found' });
          }
          providerBody = { ...body, codexAccountId: undefined, codexFleetAccountId: target.id };
        }
      }
      if (body.codexAccessToken && body.codexLabel && !(providerBody as { codexFleetAccountId?: string }).codexFleetAccountId &&
          !(await mayAddAccount(workspaceId, 'codex'))) {
        return res.status(403).json({ success: false, code: 'multi_account_disabled', error: 'Multiple accounts are disabled' });
      }
      for (const [agent, kind, supplied] of [
        ['claude', 'anthropic_key', body.claudeToken],
        ['codex', 'codex_oauth', body.codexAccessToken && !body.codexLabel && !(providerBody as { codexFleetAccountId?: string }).codexFleetAccountId],
        ['codex', 'openai_key', body.openaiKey],
      ] as const) {
        if (!supplied) continue;
        const existing = await listFleetAccounts(workspaceId, agent);
        if (existing.length > 0 && !existing.some((account) => account.kind === kind) &&
            !(await workspaceHasFeature('fleetMultiAccount', workspaceId)).enabled) {
          return res.status(403).json({ success: false, code: 'multi_account_disabled', error: 'Multiple accounts are disabled' });
        }
      }
    }
    const result = await provider.validateCredentials(workspaceId, providerBody);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.error });
    }
    await ensureCloudEnvironment(assertUser(req).id, provider.type);
    // This route is the Settings card's save button, so it is also how a
    // credential is REMOVED — a clear still validates, still provisions the
    // marker, and still returns connected:true. Announcing a disconnect as a
    // setup is the one wrong thing this hook could do, so a credential has to
    // have actually arrived before it counts as one.
    const body = req.body as {
      claudeToken?: string;
      codexAccessToken?: string;
      openaiKey?: string;
      clearClaude?: boolean;
      clearCodex?: boolean;
    };
    // Which agent arrived decides what the notification says, so it is read off
    // the credential that was actually supplied rather than off the provider.
    // The fleet is one provider running two vendors on the workspace's own
    // subscription, and "Talyn Fleet connected" left out the first thing anyone
    // asks of a fleet signup. A save carrying both announces both — they are
    // two separate facts, and the dedupe key is per agent.
    const agents: Array<{ agent: FleetAgent; detail: string }> = [];
    if (body.claudeToken) {
      agents.push({ agent: 'claude', detail: 'Claude connected with an Anthropic API key.' });
    }
    if (body.codexAccessToken) {
      agents.push({ agent: 'codex', detail: 'Codex signed in with a ChatGPT subscription.' });
    } else if (body.openaiKey) {
      // Not a subscription — a metered platform key, which is a different thing
      // to be told about even though it runs the same agent.
      agents.push({ agent: 'codex', detail: 'Codex connected with an OpenAI API key.' });
    }
    // No provider-type branch needed: the three fields above are the fleet's
    // own, so `agents` is empty for anything else — and everything else
    // announces itself from its own connect route (PostHog Code in
    // routes/posthog.ts), which is also why an empty list stays silent here.
    if (!body.clearClaude && !body.clearCodex) {
      for (const { agent, detail } of agents) {
        notifyProviderConnected({ workspaceId, type: provider.type, agent, detail });
      }
    }
    res.json({ success: true, data: { connected: true } });
  });

  /**
   * Start a Claude sign-in: mint PKCE, park the verifier, hand back the URL.
   *
   * Its own pair of routes rather than the generic `/:type/config`, because the
   * flow is two requests with a browser trip between them and the second one
   * carries a code rather than a credential.
   *
   * The same two routes serve the desktop and the web. Anthropic's client
   * redirects to a page Anthropic hosts, so — unlike Codex, whose loopback
   * redirect forces its authorize leg into the desktop main process — there is
   * nothing here that a browser cannot do.
   */
  router.post('/selfhosted/claude/authorize', async (req, res) => {
    const { workspaceId, accountId, label } = req.body as { workspaceId?: string; accountId?: string; label?: string };
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    if (!(await workspaceMayUseFleet(workspaceId))) {
      return res.status(403).json({ success: false, error: fleetRefusalReason() });
    }
    if ((accountId !== undefined && typeof accountId !== 'string') || (label !== undefined && typeof label !== 'string')) {
      return res.status(400).json({ success: false, error: 'Invalid account target' });
    }
    if (accountId && label) return res.status(400).json({ success: false, error: 'Choose an account or a new label' });
    if (accountId) {
      const target = await getFleetAccount(accountId);
      if (!target || target.workspaceId !== workspaceId || target.kind !== 'claude_oauth') {
        return res.status(404).json({ success: false, error: 'Account not found' });
      }
    }
    if (label !== undefined) {
      if (typeof label !== 'string' || !label.trim()) return res.status(400).json({ success: false, error: 'label is required' });
      if (!(await mayAddAccount(workspaceId, 'claude'))) {
        return res.status(403).json({ success: false, code: 'multi_account_disabled', error: 'Multiple accounts are disabled' });
      }
    }

    const { verifier, challenge } = createPkcePair();
    const state = randomState();
    // The verifier never leaves the server: the pasted code is worthless
    // without it, which is the whole point of PKCE.
    await patchSelfHostedConfig(workspaceId, {
      claudePendingAuth: {
        state,
        codeVerifierEnc: encryptString(verifier),
        expiresAt: new Date(Date.now() + PENDING_AUTH_TTL_MS).toISOString(),
        ...(accountId ? { accountId } : {}),
        ...(label ? { label: label.trim() } : {}),
      },
    } as Parameters<typeof patchSelfHostedConfig>[1]);

    res.json({
      success: true,
      data: { url: buildAuthorizeUrl({ codeChallenge: challenge, state }) },
    });
  });

  /** Finish it: exchange the pasted code, store the pair, clear the pending row. */
  router.post('/selfhosted/claude/complete', async (req, res) => {
    const { workspaceId, code, accountId, label } = req.body as { workspaceId?: string; code?: string; accountId?: string; label?: string };
    if (!workspaceId || !code?.trim()) {
      return res.status(400).json({ success: false, error: 'workspaceId and code are required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }

    const pending = (await readSelfHostedConfig(workspaceId))?.claudePendingAuth as
      | ({ state: string; codeVerifierEnc: Parameters<typeof decryptString>[0]; expiresAt: string; accountId?: string; label?: string })
      | undefined;
    if (!pending) {
      return res.status(400).json({
        success: false,
        error: 'Start the Claude sign-in again — this one was not found.',
      });
    }
    if ((accountId !== undefined && typeof accountId !== 'string') || (label !== undefined && typeof label !== 'string')) {
      return res.status(400).json({ success: false, error: 'Invalid account target' });
    }
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      await patchSelfHostedConfig(workspaceId, { claudePendingAuth: undefined });
      return res.status(400).json({
        success: false,
        error: 'That sign-in expired. Start it again.',
      });
    }
    if ((accountId && accountId !== pending.accountId) || (label && label !== pending.label)) {
      return res.status(400).json({ success: false, error: 'This sign-in targets a different account' });
    }
    if (pending.accountId) {
      const target = await getFleetAccount(pending.accountId);
      if (!target || target.workspaceId !== workspaceId || target.kind !== 'claude_oauth') {
        return res.status(404).json({ success: false, error: 'Account not found' });
      }
    }
    if (pending.label && !(await mayAddAccount(workspaceId, 'claude'))) {
      return res.status(403).json({ success: false, code: 'multi_account_disabled', error: 'Multiple accounts are disabled' });
    }

    const { code: authCode, state } = splitPastedCode(code);
    // The state Anthropic echoes back must be the one we minted. A mismatch
    // means the code came from a different sign-in — most likely an older tab.
    if (state && state !== pending.state) {
      return res.status(400).json({
        success: false,
        error: 'That code is from a different sign-in. Start again and use the newest one.',
      });
    }

    try {
      const credential = await exchangeCode({
        code: authCode,
        codeVerifier: decryptString(pending.codeVerifierEnc),
        ...(state ? { state } : {}),
      });
      if (pending.accountId) {
        await updateFleetAccountCredential(pending.accountId, credential);
        await clearExhaustedAccount(pending.accountId);
        await patchSelfHostedConfig(workspaceId, { claudePendingAuth: undefined });
      } else if (pending.label) {
        await addFleetAccount(workspaceId, { kind: 'claude_oauth', credential, label: pending.label });
        await patchSelfHostedConfig(workspaceId, { claudePendingAuth: undefined });
      } else {
        await patchSelfHostedConfig(workspaceId, { claudeOAuth: credential, claudePendingAuth: undefined });
        await clearExhaustedAgent(workspaceId, 'claude');
      }
      // A fresh sign-in is the one moment we can infer a topped-up quota. The
      // vendor never tells us somebody bought more usage, and the hold would
      // otherwise keep work off the agent they just came back to reconnect.
      // Cheap to be wrong: if it is still spent, the next run re-arms the hold.
      await ensureCloudEnvironment(assertUser(req).id, 'selfhosted');
      notifyProviderConnected({
        workspaceId,
        type: 'selfhosted',
        agent: 'claude',
        detail: 'Claude signed in with a Claude Pro/Max subscription.',
      });
      res.json({ success: true, data: { connected: true } });
    } catch (err) {
      // The pending sign-in is KEPT, and the reasoning that cleared it was a
      // confusion between two different things. The code is single-use; the
      // pending row is the PKCE verifier and the state, and neither is spent by
      // a failed exchange. Dropping it meant the real reason was shown exactly
      // once and every retry after that answered "this one was not found" — an
      // error that blames the user for not starting a flow they did start, and
      // sends them to do the one thing that cannot help.
      //
      // Keeping it is at worst neutral and usually better: the authorize URL is
      // still valid, so going back for a fresh code works, and starting over
      // overwrites the row anyway. The TTL is what ends it.
      res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : 'Could not complete the Claude sign-in.',
      });
    }
  });

  router.post('/:type/test', async (req, res) => {
    const provider = getCloudProvider(req.params.type);
    if (!provider) {
      return res.status(404).json({ success: false, error: 'Unknown cloud provider' });
    }
    const { workspaceId } = req.body as { workspaceId?: string };
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const data = provider.testConnection
      ? await provider.testConnection(workspaceId)
      : { connected: await provider.hasCredentials(workspaceId) };
    res.json({ success: true, data });
  });

  router.delete('/:type/config', async (req, res) => {
    const provider = getCloudProvider(req.params.type);
    if (!provider) {
      return res.status(404).json({ success: false, error: 'Unknown cloud provider' });
    }
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    await provider.removeCredentials(workspaceId);
    res.json({ success: true } as ApiResponse<void>);
  });

  return router;
}
