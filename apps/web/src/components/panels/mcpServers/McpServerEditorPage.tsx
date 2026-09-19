import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Loader2, X } from 'lucide-react';
import {
  MCP_AUTH_KINDS,
  emptyMcpServerInput,
  mcpCatalogEntry,
  mcpServerInputProblem,
  mcpServerToInput,
  mcpServerFromAddress,
  type McpAuthMethod,
  type McpAuthDiscovery,
  type McpProbeResult,
  type McpServerDefinition,
  type McpServerInput,
} from '@talyn/shared';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Section, TextField } from '../workflows/workflowFields';
import { api } from '../../../lib/api';
import { openExternal } from '../../../lib/openExternal';
import { useWorkspaceStore } from '../../../stores/workspace';

/**
 * The tool-server editor.
 *
 * A full-screen page swapped in by the list's local view state, not a route —
 * the same choice `LoopEditorPage` makes and for the same reason: `activePanel`
 * is the app's whole routing vocabulary and `PANEL_PATHS` is a flat record of
 * static paths, so a parameterised `/tool-servers/:id` would mean changing that
 * contract on both forks.
 */

const AUTH_LABELS: Record<McpAuthMethod, string> = {
  oauth: 'Sign in with OAuth',
  none: 'No key needed',
  bearer: 'API key (Bearer)',
  header: 'API key in a header',
  basic: 'Username and password',
  query: 'API key in the URL',
};

export function McpServerEditorPage({
  editing,
  initial,
  onCancel,
  onSave,
  onTest,
  existingNames = [],
}: {
  editing: McpServerDefinition | null;
  existingNames?: string[];
  /** Prefill for a new server — what the catalog hands over on a one-click. */
  initial?: McpServerInput;
  onCancel: () => void;
  onSave: (input: McpServerInput) => Promise<McpServerDefinition>;
  /** Saves first, then probes: a server has to exist before it can be asked. */
  onTest: (id: string) => Promise<McpProbeResult>;
}) {
  const [input, setInput] = useState<McpServerInput>(() => {
    if (editing) return mcpServerToInput(editing);
    const next = initial ?? emptyMcpServerInput();
    return next.url && existingNames.includes(next.name)
      ? { ...next, name: mcpServerFromAddress(next.url, existingNames).name }
      : next;
  });
  const existingNamesRef = useRef(existingNames);
  existingNamesRef.current = existingNames;
  const savedId = useRef(editing?.id);
  const connectionVersion = useRef(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /**
   * Captured at submit and cleared by the next edit.
   *
   * Deliberately NOT a "has tried" latch: a message that stays up while
   * somebody is fixing the thing it describes reads as the fix not working.
   */
  const [submitProblem, setSubmitProblem] = useState<string | null>(null);
  const [probe, setProbe] = useState<McpProbeResult | null>(editing?.lastProbe ?? null);
  const [probing, setProbing] = useState(false);

  const workspaceId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const [method, setMethod] = useState<McpAuthMethod>(editing?.oauth ? 'oauth' : input.authKind);
  const [discovery, setDiscovery] = useState<McpAuthDiscovery | null>(null);
  const [oauthConnected, setOauthConnected] = useState(editing?.oauth?.status === 'connected');
  const [checking, setChecking] = useState(false);
  const [manual, setManual] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  useEffect(() => {
    let cancelled = false;
    setDiscovery(null);
    setChecking(false);
    if (
      manual ||
      !workspaceId ||
      mcpServerInputProblem({ name: 'discovery', url: input.url, authKind: 'none', enabled: true })
    )
      return;
    setChecking(true);
    const timer = setTimeout(() => {
      api.mcpServers
        .discoverAuth(workspaceId, input.url)
        .then((result) => {
          if (cancelled) return;
          setDiscovery(result);
          const existing = editingRef.current;
          const keep = existing?.url === input.url && (existing.hasSecret || existing.oauth);
          const next = keep ? (existing.oauth ? 'oauth' : existing.authKind) : result.methods[0];
          if (next) {
            setMethod(next);
            if (!keep)
              setInput((prev) => ({
                ...prev,
                authKind: next === 'oauth' ? 'bearer' : next,
                inject: next === 'header' ? result.inject : undefined,
              }));
          }
        })
        .catch(() => {
          if (!cancelled)
            setDiscovery({
              methods: [],
              source: 'unknown',
              detail: 'Authentication could not be checked. Use manual setup.',
            });
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [input.url, workspaceId, manual]);

  const credentialStored =
    editing?.url === input.url &&
    editing.authKind === input.authKind &&
    editing.hasSecret &&
    input.secret !== '';
  const manualFields = manual || discovery?.methods.length === 0;
  const availableMethods = Array.from(new Set([method, ...(discovery?.methods ?? [])]));
  const authReady = manual || (!checking && discovery !== null);
  const chooseMethod = (next: McpAuthMethod) => {
    setProbe(null);
    setMethod(next);
    setOauthConnected(false);
    edit({
      authKind: next === 'oauth' ? 'bearer' : next,
      secret: '',
      inject: next === 'header' ? discovery?.inject : undefined,
    });
  };

  const problem = useMemo(() => mcpServerInputProblem(input), [input]);
  const catalog = input.catalogHandle ? mcpCatalogEntry(input.catalogHandle) : undefined;

  const connected = probe?.ok === true || oauthConnected;
  const validAddress = !mcpServerInputProblem({
    name: 'discovery',
    url: input.url,
    authKind: 'none',
    enabled: true,
  });

  const edit = useCallback((patch: Partial<McpServerInput>) => {
    if ('secret' in patch || 'inject' in patch || 'url' in patch || 'authKind' in patch) {
      connectionVersion.current += 1;
      setProbe(null);
      setOauthConnected(false);
    }
    setSubmitProblem(null);
    setSaveError(null);
    setInput((p) => ({ ...p, ...patch }));
  }, []);

  const save = useCallback(async () => {
    if (problem) {
      setSubmitProblem(problem);
      return;
    }
    const version = connectionVersion.current;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await onSave(input);
      savedId.current = saved.id;
      setInput((prev) =>
        prev.url === input.url && prev.secret === input.secret
          ? { ...prev, secret: undefined }
          : prev
      );
      if (!connected && method !== 'oauth') {
        const result = await onTest(saved.id);
        if (version === connectionVersion.current) setProbe(result);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save this MCP server');
    } finally {
      setSaving(false);
    }
  }, [problem, input, onSave, connected, method, onTest]);

  /**
   * Save, then probe.
   *
   * The credential lives server-side, so there is nothing to test until the
   * server exists — and testing what is on screen rather than what is stored
   * would give a green tick to a configuration nobody saved.
   */
  const testNow = useCallback(async () => {
    if (problem) {
      setSubmitProblem(problem);
      return;
    }
    const version = connectionVersion.current;
    setProbing(true);
    setSaveError(null);
    try {
      const saved = await onSave(input);
      savedId.current = saved.id;
      setInput((prev) =>
        prev.url === input.url && prev.secret === input.secret
          ? { ...prev, secret: undefined }
          : prev
      );
      const result = await onTest(saved.id);
      if (version === connectionVersion.current) setProbe(result);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not reach this MCP server');
    } finally {
      setProbing(false);
    }
  }, [problem, input, onSave, onTest]);

  useEffect(() => {
    if (editing?.oauth?.status !== 'connected' || probe || !oauthConnected) return;
    let cancelled = false;
    const version = connectionVersion.current;
    setProbing(true);
    void onTest(editing.id)
      .then((result) => {
        if (!cancelled && version === connectionVersion.current) setProbe(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setSaveError(err instanceof Error ? err.message : 'Could not load tools.');
      })
      .finally(() => {
        if (version === connectionVersion.current) setProbing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editing?.id, editing?.oauth?.status, oauthConnected, onTest, probe]);

  const allowed = input.tools;
  const offered = probe?.toolNames ?? [];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <Button variant="ghost" size="sm" onClick={onCancel} data-attr="mcp-editor-back">
          <ArrowLeft className="mr-1 h-4 w-4" />
          MCP servers
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">
            {input.displayName?.trim() ||
              input.name.trim() ||
              (editing ? 'MCP server' : 'New MCP server')}
          </h1>
        </div>
        {/* Only when editing. One you are creating is on — nobody fills in a
            URL and a key in order to leave it switched off. */}
        {editing && (
          <Button
            variant={input.enabled === false ? 'outline' : 'secondary'}
            size="sm"
            onClick={() => edit({ enabled: input.enabled === false })}
          >
            {input.enabled === false ? 'Off' : 'On'}
          </Button>
        )}
        {connected && (
          <Button
            variant="outline"
            onClick={testNow}
            disabled={probing || saving || !authReady || (method === 'oauth' && !oauthConnected)}
            data-attr="mcp-test"
          >
            {probing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            {probing ? 'Testing...' : 'Test'}
          </Button>
        )}
        {validAddress && (method !== 'oauth' || connected) && (
          <Button onClick={save} disabled={saving || !authReady} data-attr="mcp-save">
            {saving ? 'Connecting…' : connected ? 'Save' : 'Connect'}
          </Button>
        )}
      </header>

      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-6">
          {(saveError ?? submitProblem) && (
            <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-500">
              {saveError ?? submitProblem}
            </p>
          )}

          {probe && <ProbeBanner probe={probe} />}

          {!catalog && (
            <Section
              title="MCP server address"
              description="Paste the address. Talyn fills in the connection settings."
            >
              <TextField
                value={input.url}
                onChange={(url) => {
                  setManual(false);
                  setDiscovery(null);
                  setMethod('bearer');
                  setOauthConnected(false);
                  setProbe(null);
                  let defaults: Partial<McpServerInput> = {
                    name: '',
                    displayName: undefined,
                    description: undefined,
                    catalogHandle: undefined,
                  };
                  try {
                    defaults = mcpServerFromAddress(url, existingNamesRef.current);
                  } catch {
                    /* Keep incomplete addresses editable. */
                  }
                  edit({
                    ...defaults,
                    url,
                    secret: '',
                    inject: defaults.inject,
                    authKind: defaults.authKind ?? 'bearer',
                  });
                }}
                placeholder="https://mcp.linear.app/mcp"
              />
            </Section>
          )}

          {connected && (
            <details className="rounded-lg border p-4">
              <summary className="cursor-pointer text-sm">Connection settings</summary>
              <div className="mt-3 space-y-2">
                <TextField
                  value={input.name}
                  onChange={(name) => edit({ name })}
                  placeholder="Server name"
                />
                <p className="break-all text-xs text-muted-foreground">{input.url}</p>
              </div>
            </details>
          )}

          {validAddress && (
            <>
              <Section
                title="Authentication"
                description="Talyn checks the server address to find its authentication options."
              >
                {checking && (
                  <p role="status" className="text-sm text-muted-foreground">
                    Checking authentication…
                  </p>
                )}
                {discovery?.detail && (
                  <p className="text-sm text-muted-foreground">{discovery.detail}</p>
                )}
                {!checking && !authReady && (
                  <p className="text-sm text-muted-foreground">Enter a valid server address.</p>
                )}
                {authReady &&
                  !manualFields &&
                  (availableMethods.length > 1 ? (
                    <select
                      aria-label="Authentication method"
                      className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
                      value={method}
                      onChange={(event) => chooseMethod(event.target.value as McpAuthMethod)}
                    >
                      {availableMethods.map((value) => (
                        <option key={value} value={value}>
                          {AUTH_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-sm">{AUTH_LABELS[method]}</p>
                  ))}
                <button
                  type="button"
                  className="mt-2 text-xs text-muted-foreground underline"
                  onClick={() => setManual(!manual)}
                >
                  {manual ? 'Detect authentication' : 'Set up manually'}
                </button>
              </Section>

              {authReady && method === 'oauth' && (
                <SignIn
                  server={editing?.url === input.url && input.secret === undefined ? editing : null}
                  onStatusChange={(isConnected) => {
                    setOauthConnected(isConnected);
                    if (!isConnected) {
                      setProbe(null);
                      return;
                    }
                    if (savedId.current) {
                      setProbing(true);
                      const version = connectionVersion.current;
                      void onTest(savedId.current)
                        .then((result) => {
                          if (version === connectionVersion.current) setProbe(result);
                        })
                        .catch((err: unknown) => {
                          setSaveError(
                            err instanceof Error ? err.message : 'Could not load tools.'
                          );
                        })
                        .finally(() => setProbing(false));
                    }
                  }}
                  prepare={async () => {
                    if (problem) {
                      setSubmitProblem(problem);
                      throw new Error(problem);
                    }
                    const saved = await onSave({ ...input, authKind: 'bearer', inject: undefined });
                    savedId.current = saved.id;
                    setInput((prev) =>
                      prev.url === input.url && prev.secret === input.secret
                        ? { ...prev, secret: undefined }
                        : prev
                    );
                    return saved;
                  }}
                />
              )}

              {authReady && (method !== 'oauth' || manualFields) && (
                <Section
                  title="Credential"
                  description={
                    credentialStored
                      ? 'A key is stored. Leave this blank to keep it, or type a new one to replace it.'
                      : (discovery?.credentialLabel ??
                        catalog?.credentialLabel ??
                        'Enter the credential required by this server.')
                  }
                >
                  <div className="space-y-2">
                    {manualFields && (
                      <select
                        aria-label="Authentication method"
                        className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
                        value={method}
                        onChange={(e) => chooseMethod(e.target.value as McpAuthMethod)}
                      >
                        {(['oauth', ...MCP_AUTH_KINDS] as McpAuthMethod[]).map((k) => (
                          <option key={k} value={k}>
                            {AUTH_LABELS[k]}
                          </option>
                        ))}
                      </select>
                    )}

                    {input.authKind === 'header' &&
                      (manualFields || !discovery?.inject?.header) && (
                        <TextField
                          value={input.inject?.header ?? ''}
                          onChange={(header) => edit({ inject: { ...input.inject, header } })}
                          placeholder="X-Api-Key"
                        />
                      )}
                    {input.authKind === 'basic' && (
                      <TextField
                        value={input.inject?.user ?? ''}
                        onChange={(user) => edit({ inject: { ...input.inject, user } })}
                        placeholder="Username"
                      />
                    )}
                    {input.authKind === 'query' && (
                      <TextField
                        value={input.inject?.param ?? ''}
                        onChange={(param) => edit({ inject: { ...input.inject, param } })}
                        placeholder="api_key"
                      />
                    )}

                    {method !== 'none' && method !== 'oauth' && (
                      <Input
                        type="password"
                        autoComplete="off"
                        value={input.secret ?? ''}
                        onChange={(e) => edit({ secret: e.target.value })}
                        placeholder={credentialStored ? '••••••••  (unchanged)' : 'Paste the key'}
                      />
                    )}

                    <p className="text-xs text-muted-foreground">
                      {method === 'none'
                        ? 'No credential is needed for this connection.'
                        : 'Credentials are stored encrypted. The sandbox does not receive them.'}
                    </p>
                  </div>
                </Section>
              )}
            </>
          )}

          {connected && (
            <Section
              title="Tools"
              description="Every tool costs space in the agent's prompt on every request. Pick the ones you want, or leave it on all."
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={testNow}
                  disabled={probing || !authReady || (method === 'oauth' && !oauthConnected)}
                >
                  {offered.length > 0 ? 'Refresh' : 'Load tools'}
                </Button>
              }
            >
              <ToolPicker
                offered={offered}
                allowed={allowed ?? null}
                probed={probe !== null}
                onChange={(tools) => edit({ tools })}
              />
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The allow-list, with its three states kept visible.
 *
 * "All tools" is not the same as every box ticked, and the difference is not
 * cosmetic: null means whatever the server offers TODAY, so a tool the vendor
 * adds next month is included. A full tick-list means those exact names, and
 * the new one is not. Somebody choosing between them should be able to see
 * which they have.
 */
function ToolPicker({
  offered,
  allowed,
  probed,
  onChange,
}: {
  offered: string[];
  allowed: string[] | null;
  probed: boolean;
  onChange: (next: string[] | null) => void;
}) {
  // The names to draw. A stored allow-list can name tools the last probe did
  // not return — a vendor removed one, or nobody has probed yet — and dropping
  // those would silently widen the list the moment somebody pressed Save.
  const names = useMemo(
    () => Array.from(new Set([...offered, ...(allowed ?? [])])).sort(),
    [offered, allowed]
  );

  if (names.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {probed
          ? 'This server offered no tools.'
          : 'Test the connection to see which tools this server offers.'}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={allowed === null}
          onChange={(e) => onChange(e.target.checked ? null : [...offered])}
        />
        <span>
          All tools
          <span className="ml-1 text-xs text-muted-foreground">
            (including any this server adds later)
          </span>
        </span>
      </label>

      {allowed !== null && (
        <div className="grid gap-1 sm:grid-cols-2">
          {names.map((name) => {
            const on = allowed.includes(name);
            return (
              <label key={name} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    onChange(on ? allowed.filter((t) => t !== name) : [...allowed, name])
                  }
                />
                <code className="truncate text-xs">{name}</code>
                {!offered.includes(name) && (
                  <span className="text-xs text-muted-foreground">(not offered now)</span>
                )}
              </label>
            );
          })}
        </div>
      )}

      {allowed !== null && allowed.length === 0 && (
        <p className="text-xs text-amber-600">
          Nothing is ticked, so this server will be connected with no tools at all.
        </p>
      )}
    </div>
  );
}

function SignIn({
  server,
  prepare,
  onStatusChange,
}: {
  server: McpServerDefinition | null;
  prepare: () => Promise<McpServerDefinition>;
  onStatusChange: (connected: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState(server?.oauth ?? null);
  const [error, setError] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const attempt = useRef(0);
  useEffect(() => {
    setGrant(server?.oauth ?? null);
  }, [server?.oauth]);
  useEffect(
    () => () => {
      attempt.current += 1;
    },
    []
  );

  const start = async () => {
    const current = ++attempt.current;
    setBusy(true);
    setError(null);
    setAuthorizeUrl(null);
    try {
      const saved = await prepare();
      if (current !== attempt.current) return;
      const flow = await api.mcpServers.startSignIn(saved.id);
      if (current !== attempt.current) return;
      // A direct click on this link keeps browser popup rules satisfied.
      setAuthorizeUrl(flow.authorizeUrl);
      const until = Math.min(Date.parse(flow.expiresAt), Date.now() + 10 * 60 * 1000);
      while (Date.now() < until && current === attempt.current) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (current !== attempt.current) return;
        const status = await api.mcpServers.signInStatus(saved.id, flow.flowId);
        if (current !== attempt.current) return;
        if (status.status === 'connected' && !status.pending) {
          setGrant({ status: 'connected' });
          onStatusChange(true);
          setAuthorizeUrl(null);
          return;
        }
        if (!status.pending || status.status === 'needs_reauth') {
          throw new Error(status.detail ?? 'Sign-in did not finish. Try again.');
        }
      }
      if (current === attempt.current) setError('Sign-in took too long. Try again.');
    } catch (err) {
      if (current === attempt.current)
        setError(err instanceof Error ? err.message : 'Could not start sign-in.');
    } finally {
      if (current === attempt.current) {
        setBusy(false);
        setAuthorizeUrl(null);
      }
    }
  };

  const disconnect = async () => {
    if (!server) return;
    setError(null);
    setBusy(true);
    try {
      const next = await api.mcpServers.disconnect(server.id);
      setGrant(next.oauth ?? null);
      onStatusChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Sign in"
      description="Connect your account in your browser. Talyn stores and refreshes the token securely."
    >
      <div className="space-y-2">
        {grant?.status === 'connected' ? (
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-emerald-600" />
            <span className="text-sm">Signed in.</span>
            <Button variant="ghost" size="sm" onClick={() => void disconnect()} disabled={busy}>
              Disconnect
            </Button>
          </div>
        ) : (
          <Button variant="outline" onClick={() => void start()} disabled={busy}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {busy ? 'Waiting for sign-in…' : 'Connect account'}
          </Button>
        )}
        {authorizeUrl && (
          <Button onClick={() => void openExternal(authorizeUrl)}>Continue in browser</Button>
        )}
        {grant?.status === 'needs_reauth' && grant.detail && (
          <p className="text-xs text-amber-600">{grant.detail}</p>
        )}
        {error && (
          <p role="alert" className="text-xs text-red-500">
            {error}
          </p>
        )}
      </div>
    </Section>
  );
}

function ProbeBanner({ probe }: { probe: McpProbeResult }) {
  const tone = probe.ok
    ? 'border-emerald-500/40 bg-emerald-500/10'
    : 'border-red-500/40 bg-red-500/10';
  return (
    <p className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${tone}`}>
      {probe.ok ? (
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
      ) : (
        <X className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
      )}
      <span>
        {probe.ok
          ? `Connected to ${probe.serverName ?? 'the server'}${
              probe.toolNames
                ? `, which offers ${probe.toolNames.length} tool${probe.toolNames.length === 1 ? '' : 's'}`
                : ''
            }.`
          : 'Could not connect.'}
        {probe.detail ? ` ${probe.detail}` : ''}
      </span>
    </p>
  );
}
