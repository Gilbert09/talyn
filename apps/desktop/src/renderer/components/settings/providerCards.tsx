import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, BarChart3, Check, Loader2, Pencil, RefreshCw, Server, Unlink } from 'lucide-react';
import { DEFAULT_POSTHOG_CODE_MODEL_ID, POSTHOG_CODE_MODELS, type FleetAccountsResponse } from '@talyn/shared';
import { api } from '../../lib/api';
import { trackEvent } from '../../lib/analytics';
import { openExternal } from '../../lib/openExternal';
import { FleetAgentMark } from '../../lib/providerMeta';
import { cn } from '../../lib/utils';
import { useWorkspaceStore } from '../../stores/workspace';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import {
  GetKeyLink,
  POSTHOG_API_KEYS_URL,
  CLAUDE_SETUP_TOKEN_URL,
  POSTHOG_KEY_SCOPE_NOTE,
} from '../widgets/GetKeyLink';
import { WorkspaceModelSelector } from './WorkspaceModelSelector';
import { FleetAccountsList } from './FleetAccountsList';

/**
 * The two provider connect cards (PostHog Code + Claude Code), shared by the
 * Settings → Agents section and the "connect an agent" modal so both
 * render the identical connect/verify flow from a single definition.
 */
export function ProviderConnectCards() {
  return (
    <>
      {/* Talyn Fleet FIRST, and the order is the recommendation.
          
          It runs on the user's own Claude or Codex subscription, which is what
          most people arriving here already pay for; PostHog Code needs a
          PostHog account and bills metered credits, so it is the right default
          for roughly one company. Leading with it was a hangover from the days
          when it was the only provider.

          Rendered ONLY when the backend listed the fleet for this workspace:
          /cloud-providers filters it out for anyone outside the "talyn-fleet"
          flag audience, so showing the card unconditionally would offer a form
          whose save 403s. Since the fleet's release that audience is everyone,
          but the gate stays — it is the kill switch. */}
      <SelfHostedFleetCard />

      {/* PostHog Code (cloud tasks) */}
      <PostHogCodeCard />
    </>
  );
}

/**
 * The Talyn Fleet card — one provider, TWO independently connectable agents.
 *
 * Bespoke, like `PostHogCodeCard`. There used to be a generic descriptor-driven
 * `CloudProviderCard` and both of these outgrew it — one field list behind one
 * Connect/Disconnect pair cannot express two credentials that are connected,
 * rotated and dropped independently, and squeezing the fleet into it would mean
 * disconnecting Claude to reconnect Codex. With no descriptor-driven card left,
 * the generic one was deleted rather than kept as a template for a provider
 * that may never need it.
 *
 * Gated on the provider appearing in the workspace's provider list rather than
 * rendered unconditionally. The fleet runs on hardware we own and the backend
 * only offers it to allow-listed workspaces; a card that appeared for everyone
 * would be a form that always 403s on save, which reads as a broken integration
 * rather than one you do not have.
 *
 * Absence is not "still loading" — `cloudProviders === null` is. Both mean
 * "render nothing", but conflating them is how a card flashes in and out on
 * every settings visit.
 */
function SelfHostedFleetCard() {
  const cloudProviders = useWorkspaceStore((s) => s.cloudProviders);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const setCloudProviders = useWorkspaceStore((s) => s.setCloudProviders);
  const [fleetAccounts, setFleetAccounts] = useState<FleetAccountsResponse | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const workspaceIdRef = useRef(currentWorkspaceId);
  workspaceIdRef.current = currentWorkspaceId;
  const entry = (cloudProviders ?? []).find((p) => p.type === 'selfhosted');
  const offered = cloudProviderOffered(cloudProviders, 'selfhosted');

  const refreshAccounts = useCallback(async () => {
    if (!currentWorkspaceId) return;
    try {
      const result = await api.cloudProviders.fleetAccounts.list(currentWorkspaceId);
      if (workspaceIdRef.current === currentWorkspaceId) {
        setFleetAccounts(result);
        setAccountsError(null);
      }
    } catch (e) {
      if (workspaceIdRef.current === currentWorkspaceId) {
        setAccountsError(e instanceof Error ? e.message : 'Could not load accounts');
      }
    }
  }, [currentWorkspaceId]);

  useEffect(() => {
    setFleetAccounts(null);
    if (!offered || !currentWorkspaceId) return;
    void refreshAccounts();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshAccounts();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [offered, currentWorkspaceId, refreshAccounts]);

  if (!offered) return null;

  const agents = entry?.connectedAgents ?? [];
  const reauth = entry?.reauthAgents ?? [];
  const connected = agents.length > 0;

  return (
    <Card className="p-3">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0',
            connected ? 'bg-green-500/10' : 'bg-secondary'
          )}
        >
          <Server className={cn('w-4 h-4', connected && 'text-green-500')} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-[13px] font-semibold">Talyn Fleet</h4>
            {connected ? (
              <Badge variant="default" className="bg-green-600">
                <Check className="w-3 h-3 mr-0.5" />
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary">Not Connected</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {connected
              ? 'Cloud tasks run in microVMs on Talyn’s hardware, on your own agent subscription, and open PRs via this workspace’s GitHub connection.'
              : 'Run tasks on Talyn’s own Firecracker fleet, on your own Claude or Codex subscription. Each task gets its own microVM; your credentials are injected host-side and never enter the VM.'}
          </p>
        </div>
      </div>

      <div className="mt-3 space-y-2 border-t pt-3">
        {(['claude', 'codex'] as const).map((agent) => {
          const accounts = fleetAccounts?.accounts.filter((account) => account.agent === agent) ?? [];
          return accounts.length > 0 && currentWorkspaceId && fleetAccounts ? (
            <FleetAccountsList
              key={agent}
              agent={agent}
              workspaceId={currentWorkspaceId}
              accounts={accounts}
              activeId={fleetAccounts.active[agent]}
              switchAtPercent={fleetAccounts.switchAtPercent}
              onChanged={async () => {
                await refreshAccounts();
                try {
                  setCloudProviders(await api.cloudProviders.list(currentWorkspaceId));
                } catch {
                  // The account list still refreshes if provider status is unavailable.
                }
              }}
            />
          ) : (
            <FleetAgentRow
              key={agent}
              agent={agent}
              connected={agents.includes(agent)}
              needsReauth={reauth.includes(agent)}
              onChanged={refreshAccounts}
            />
          );
        })}
        {accountsError && <p role="alert" className="text-xs text-destructive">{accountsError}</p>}
      </div>
    </Card>
  );
}

/**
 * One agent inside the fleet card: connect it, reconnect it, or drop it.
 *
 * Every save goes through the SAME provider route as before
 * (`PUT /cloud-providers/selfhosted/config`) — the backend merges the one
 * vendor named in the body and leaves the other alone, which is what makes
 * these two rows independent without a second endpoint.
 */
export function FleetAgentRow({
  agent,
  connected,
  needsReauth,
  onChanged,
}: {
  agent: 'claude' | 'codex';
  connected: boolean;
  needsReauth: boolean;
  onChanged?: () => Promise<void>;
}) {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const setCloudProviders = useWorkspaceStore((s) => s.setCloudProviders);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claudeToken, setClaudeToken] = useState('');

  const label = agent === 'claude' ? 'Claude subscription' : 'Codex (ChatGPT) subscription';

  /**
   * Refresh from the server rather than patching the store optimistically.
   *
   * The card renders off `connectedAgents`, which only the backend can compute
   * — it reads which credential fields the integration row actually holds. A
   * local guess would show "Connected" for a save that was refused.
   */
  const refresh = useCallback(async () => {
    if (!currentWorkspaceId) return;
    try {
      setCloudProviders(await api.cloudProviders.list(currentWorkspaceId));
    } catch {
      // Leave the last-known list in place; the next focus refresh retries.
    }
  }, [currentWorkspaceId, setCloudProviders]);

  const save = useCallback(
    async (config: Record<string, string>) => {
      if (!currentWorkspaceId) return;
      setBusy(true);
      setError(null);
      try {
        await api.cloudProviders.saveConfig('selfhosted', currentWorkspaceId, config);
        trackEvent('cloud_provider_connected', { provider: 'selfhosted', agent });
        setClaudeToken('');
        setEditing(false);
        await refresh();
        await onChanged?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save credentials');
      } finally {
        setBusy(false);
      }
    },
    [agent, currentWorkspaceId, refresh, onChanged]
  );

  const disconnect = useCallback(async () => {
    // A per-VENDOR disconnect, not the provider-level DELETE — that one drops
    // the whole integration row and would take the other agent with it.
    await save(agent === 'claude' ? { clearClaude: 'true' } : { clearCodex: 'true' });
  }, [agent, save]);

  const [awaitingClaudeCode, setAwaitingClaudeCode] = useState(false);
  const [claudeCode, setClaudeCode] = useState('');

  const signInToCodex = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electron.codex.signIn();
      await save({
        codexAccessToken: result.accessToken,
        codexRefreshToken: result.refreshToken,
        ...(result.accountId ? { codexAccountId: result.accountId } : {}),
        ...(result.expiresIn ? { codexExpiresIn: String(result.expiresIn) } : {}),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ChatGPT sign-in failed');
      setBusy(false);
    }
  }, [save]);

  /**
   * Claude sign-in: open Anthropic's page, take the code back.
   *
   * Two steps with a browser trip between them, and it is the SAME code on the
   * desktop and the web. Codex needs `window.electron` because OpenAI redirects
   * to a loopback only the desktop can listen on; Anthropic redirects to a page
   * it hosts that shows a code, so there is nothing to listen for.
   */
  const startClaudeSignIn = useCallback(async () => {
    if (!currentWorkspaceId) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.cloudProviders.startClaudeSignIn(currentWorkspaceId);
      void openExternal(url);
      setAwaitingClaudeCode(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the Claude sign-in');
    } finally {
      setBusy(false);
    }
  }, [currentWorkspaceId]);

  const finishClaudeSignIn = useCallback(async () => {
    if (!currentWorkspaceId) return;
    setBusy(true);
    setError(null);
    try {
      await api.cloudProviders.completeClaudeSignIn(currentWorkspaceId, claudeCode);
      setAwaitingClaudeCode(false);
      setClaudeCode('');
      trackEvent('cloud_provider_connected', { provider: 'selfhosted', agent: 'claude' });
      setEditing(false);
      // Re-read rather than guess: the card renders off `connectedAgents`,
      // which only the backend can compute.
      await refresh();
      await onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not finish the Claude sign-in');
    } finally {
      setBusy(false);
    }
  }, [currentWorkspaceId, claudeCode, refresh, onChanged]);

  const showForm = editing || !connected;

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {/* The vendor's own mark, because this row IS the vendor choice.
              "Claude subscription" and "Codex (ChatGPT) subscription" are two
              lines of text a reader has to parse; the marks are the thing they
              recognise without reading. Same logos the task badges use. */}
          <FleetAgentMark agent={agent} className="h-4 w-4 rounded-[3px]" />
          <span className="text-[13px] font-medium">{label}</span>
          {needsReauth ? (
            <Badge variant="destructive">Reconnect needed</Badge>
          ) : connected ? (
            <Badge variant="secondary">
              <Check className="w-3 h-3 mr-0.5" />
              Connected
            </Badge>
          ) : null}
        </div>
        {connected && !showForm && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={busy}>
              <Pencil className="w-3.5 h-3.5" />
              {needsReauth ? 'Reconnect' : 'Edit'}
            </Button>
            <Button variant="outline" size="sm" onClick={disconnect} disabled={busy}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Unlink className="w-3.5 h-3.5" />}
            </Button>
          </div>
        )}
      </div>

      {needsReauth && (
        <p className="mt-1 text-xs text-muted-foreground">
          {agent === 'claude'
            ? 'Anthropic no longer accepts the saved sign-in, so tasks on Claude cannot run. This happens when the sign-in is revoked or expires, or when the account has no Claude subscription. Sign in to Claude again.'
            : 'OpenAI no longer accepts the saved sign-in, so tasks on Codex cannot run. This happens when the sign-in is revoked or expires. Sign in to ChatGPT again.'}
        </p>
      )}

      {showForm && (
        <div className="mt-2 space-y-2">
          {agent === 'claude' ? (
            <>
              {!awaitingClaudeCode ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    Sign in with your Claude account. Talyn opens Anthropic’s own sign-in page in
                    your browser and never sees your password.
                  </p>
                  <Button size="sm" onClick={startClaudeSignIn} disabled={busy}>
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Sign in with Claude'}
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Approve the request in your browser, then paste the code Anthropic shows you.
                  </p>
                  <Input
                    label="Code from Anthropic"
                    value={claudeCode}
                    onChange={(e) => setClaudeCode(e.target.value)}
                    disabled={busy}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={finishClaudeSignIn}
                      disabled={busy || !claudeCode.trim()}
                    >
                      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Finish sign-in'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setAwaitingClaudeCode(false)}
                      disabled={busy}
                    >
                      Back
                    </Button>
                  </div>
                </>
              )}

              {/* The metered path stays. A workspace billing per token has no
                  subscription to sign in to, so removing this would strand it. */}
              <details className="pt-1">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Use a Console API key instead
                </summary>
                <div className="mt-2 space-y-2">
                  <Input
                    label="Anthropic Console API key"
                    type="password"
                    placeholder="sk-ant-api…"
                    value={claudeToken}
                    onChange={(e) => setClaudeToken(e.target.value)}
                    disabled={busy}
                  />
                  <GetKeyLink
                    url={CLAUDE_SETUP_TOKEN_URL}
                    label="Where to find it"
                    note={'billed per token, rather than against a Claude subscription.'}
                  />
                  <Button
                    size="sm"
                    onClick={() => save({ claudeToken })}
                    disabled={busy || !claudeToken.trim()}
                  >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save & verify'}
                  </Button>
                </div>
              </details>
            </>
          ) : (
            <><div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Sign in with your ChatGPT account. Talyn opens OpenAI’s own sign-in page in your
                browser and never sees your password.
              </p>
              <Button size="sm" onClick={signInToCodex} disabled={busy}>
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Sign in with ChatGPT'}
              </Button>
            </div></>
          )}
          {error && (
            <div className="text-xs text-destructive flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {connected && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Whether the backend offered this provider to the current workspace.
 *
 * `null` means the list has not loaded, which is NOT the same as "absent" even
 * though both render nothing — conflating them is how a card flashes in and out
 * on every settings visit.
 */
export function cloudProviderOffered(
  cloudProviders: { type: string }[] | null,
  type: string,
): boolean {
  return Boolean(cloudProviders?.some((p) => p.type === type));
}

/**
 * PostHog Code (cloud tasks) credentials, per workspace.
 *
 * Two ways to connect, both first-class:
 *
 * - **OAuth** — offered when the backend has `POSTHOG_OAUTH_*` configured. The
 *   user authorizes Talyn on PostHog and picks the project on PostHog's own
 *   consent screen, so no credential ever passes through this window and the
 *   grant is narrowed to one project + `task:read`/`task:write`. It's revocable
 *   from PostHog's Connected Apps screen.
 * - **Personal API key** — now offered ONLY where OAuth is not configured
 *   (self-hosted, local dev), which SETUP §6b documents as the fall-back. It
 *   used to sit one click behind the OAuth button on every deployment; that
 *   made a long-lived credential carrying the user's whole project a one-click
 *   default for anyone who did not know the difference.
 *
 *   An existing key connection is still never broken — the stored key keeps
 *   working, and nothing nags. What changed is that its button now offers the
 *   move to OAuth instead of a key edit, because re-consenting replaces the
 *   credential and re-picks the project, so it does everything Edit did and
 *   ends somewhere better.
 *
 * Either way the credential is write-only — the backend returns neither the key
 * nor a token, so this renders connection state and the project id, nothing more.
 */
export function PostHogCodeCard() {
  // Status is preloaded into the store at startup (useSystemStatus), so the
  // card shows the connection state instantly. Mutations below write the fresh
  // status straight back to the store; the OAuth flow finishes in the system
  // browser instead, which useSystemStatus picks up on window focus.
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const status = useWorkspaceStore((s) => s.posthogStatus);
  const setStatus = useWorkspaceStore((s) => s.setPostHogStatus);
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [projectId, setProjectId] = useState('');
  const [host, setHost] = useState('https://us.posthog.com');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the edit-form fields from the preloaded status. Deps are the scalar
  // values, so this won't clobber in-progress edits (status is stable while
  // editing) — it only fires when the preload lands or after a save.
  useEffect(() => {
    if (status?.projectId) setProjectId(status.projectId);
    if (status?.host) setHost(status.host);
  }, [status?.projectId, status?.host]);

  const connected = Boolean(status?.connected);
  const usingOAuth = status?.authMethod === 'oauth';
  const needsReauth = status?.needsReauth === true;
  // Strict `=== true`: a desktop build newer than its backend sees `undefined`
  // here, and offering a flow the backend can't start is worse than not offering
  // it at all.
  const oauthAvailable = status?.oauthAvailable === true;
  // The key form is the default landing state only where OAuth isn't an option.
  const keyFormOpen = editing || (!connected && !oauthAvailable);

  const handleConnectOAuth = async () => {
    if (!currentWorkspaceId) return;
    setIsSaving(true);
    setError(null);
    try {
      const { authorizeUrl } = await api.posthog.startOAuth(currentWorkspaceId, {
        host: host.trim() || undefined,
        // Only a pre-selection on PostHog's consent screen, and only honoured
        // there if the user actually has access to it — useful on a reconnect.
        projectId: status?.projectId,
      });
      trackEvent('cloud_provider_oauth_started', { provider: 'posthog_code' });
      // Must be the real browser: the user needs their PostHog session, and the
      // consent screen is theirs, not ours to render.
      await openExternal(authorizeUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start the PostHog connection');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = async () => {
    if (!currentWorkspaceId || !apiKey.trim() || !projectId.trim()) return;
    setIsSaving(true);
    setError(null);
    try {
      const s = await api.posthog.saveConfig(currentWorkspaceId, {
        apiKey: apiKey.trim(),
        projectId: projectId.trim(),
        host: host.trim() || undefined,
      });
      trackEvent('cloud_provider_connected', { provider: 'posthog_code' });
      setStatus(s);
      setApiKey('');
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save credentials');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDisconnect = async () => {
    if (!currentWorkspaceId) return;
    setIsSaving(true);
    try {
      await api.posthog.disconnect(currentWorkspaceId);
      setStatus({ connected: false, oauthAvailable });
      setProjectId('');
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect');
    } finally {
      setIsSaving(false);
    }
  };

  const description = () => {
    if (needsReauth) {
      return 'PostHog rejected the stored authorization — reconnect to keep cloud tasks running.';
    }
    if (connected) {
      return `Cloud tasks run under project ${status?.projectId} on ${status?.host}${
        usingOAuth ? ', authorized with your PostHog account.' : '.'
      }`;
    }
    return oauthAvailable
      ? 'Connect your PostHog account to run tasks on PostHog Code’s cloud sandbox. Talyn asks only for task access to the one project you pick.'
      : 'Add a personal API key + project id to run tasks on PostHog Code’s cloud sandbox.';
  };

  return (
    <Card className="p-3">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0',
            connected && !needsReauth ? 'bg-green-500/10' : 'bg-secondary'
          )}
        >
          <BarChart3 className={cn('w-4 h-4', connected && !needsReauth && 'text-green-500')} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-[13px] font-semibold">PostHog Code</h4>
            {needsReauth ? (
              <Badge variant="destructive">Reconnect needed</Badge>
            ) : connected ? (
              <Badge variant="default" className="bg-green-600">
                <Check className="w-3 h-3 mr-0.5" />
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary">Not Connected</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{description()}</p>

          {/* Not connected, OAuth on the table: it is the ONLY path offered.
              The key form used to sit one click away here. It is gone wherever
              OAuth works, because a personal API key is a long-lived credential
              with the user's whole project behind it, pasted through this
              window, while the OAuth grant is narrowed to one project and
              `task:read`/`task:write` and is revocable from PostHog's own
              Connected Apps screen. Offering both made the weaker one a
              one-click default for anyone who did not know the difference.
              A deployment with no POSTHOG_OAUTH_* configured still gets the key
              form below — see `keyFormOpen`. */}
          {!connected && oauthAvailable && !keyFormOpen && (
            <div className="mt-3 space-y-2">
              <Input
                label="PostHog host"
                placeholder="https://us.posthog.com"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                disabled={isSaving}
              />
              {error && (
                <div className="text-xs text-destructive flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleConnectOAuth} disabled={isSaving || !currentWorkspaceId}>
                  {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Connect with PostHog'}
                </Button>
              </div>
            </div>
          )}

          {keyFormOpen && (
            <div className="mt-3 space-y-2">
              <Input
                label="Personal API key"
                type="password"
                placeholder="phx_..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={isSaving}
              />
              <GetKeyLink url={POSTHOG_API_KEYS_URL} note={POSTHOG_KEY_SCOPE_NOTE} />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Project (team) id"
                  placeholder="e.g. 2"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  disabled={isSaving}
                />
                <Input
                  label="Host"
                  placeholder="https://us.posthog.com"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  disabled={isSaving}
                />
              </div>
              {error && (
                <div className="text-xs text-destructive flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={isSaving || !apiKey.trim() || !projectId.trim() || !currentWorkspaceId}
                >
                  {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save & verify'}
                </Button>
                {/* Offered, never pushed: an existing key install works fine and
                    nothing here suggests it's deprecated. */}
                {oauthAvailable && (
                  <Button size="sm" variant="ghost" onClick={handleConnectOAuth} disabled={isSaving}>
                    Connect with PostHog instead
                  </Button>
                )}
                {(connected || oauthAvailable) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(false);
                      setApiKey('');
                      setError(null);
                    }}
                    disabled={isSaving}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {connected && !keyFormOpen && (
          <div className="flex gap-2">
            {usingOAuth ? (
              // No key to rotate on an OAuth connection — re-consenting is the
              // equivalent, and it's also how you move the workspace to a
              // different PostHog project.
              <Button
                variant={needsReauth ? 'default' : 'outline'}
                size="sm"
                onClick={handleConnectOAuth}
                disabled={isSaving}
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Reconnect
              </Button>
            ) : oauthAvailable ? (
              // A working key connection, on a deployment where OAuth exists.
              // Offered the move rather than a key edit: re-consenting replaces
              // the credential AND re-picks the project, so this does everything
              // Edit did and ends with the narrower grant. Nothing is forced —
              // the stored key keeps working until this is pressed, because
              // breaking a connected workspace to tidy up its auth method is
              // not a trade anybody asked for.
              <Button variant="outline" size="sm" onClick={handleConnectOAuth} disabled={isSaving}>
                <RefreshCw className="w-3.5 h-3.5" />
                Switch to PostHog sign-in
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={isSaving}>
                <Pencil className="w-3.5 h-3.5" />
                Edit
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={isSaving}>
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Unlink className="w-3.5 h-3.5" />}
            </Button>
          </div>
        )}
      </div>

      {/* Per-provider model choice lives with its provider, mirroring the
          card's connected extras. */}
      {connected && (
        <div className="mt-3 border-t pt-1">
          <WorkspaceModelSelector
            className="px-0"
            providerType="posthog_code"
            title="Model"
            description="Which model PostHog Code runs use. Opus 5 is the most capable model; Fable 5 is the newest."
            models={POSTHOG_CODE_MODELS}
            defaultId={DEFAULT_POSTHOG_CODE_MODEL_ID}
            settingKey="posthogCodeModel"
          />
        </div>
      )}
    </Card>
  );
}
