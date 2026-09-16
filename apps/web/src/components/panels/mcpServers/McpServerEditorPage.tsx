import { useCallback, useMemo, useState } from 'react';
import { ArrowLeft, Check, Loader2, X } from 'lucide-react';
import {
  MCP_AUTH_KINDS,
  emptyMcpServerInput,
  mcpCatalogEntry,
  mcpServerInputProblem,
  mcpServerToInput,
  type McpAuthKind,
  type McpProbeResult,
  type McpServerDefinition,
  type McpServerInput,
} from '@talyn/shared';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Section, TextField } from '../workflows/workflowFields';
import { api } from '../../../lib/api';
import { openExternal } from '../../../lib/openExternal';

/**
 * The tool-server editor.
 *
 * A full-screen page swapped in by the list's local view state, not a route —
 * the same choice `LoopEditorPage` makes and for the same reason: `activePanel`
 * is the app's whole routing vocabulary and `PANEL_PATHS` is a flat record of
 * static paths, so a parameterised `/tool-servers/:id` would mean changing that
 * contract on both forks.
 */

const AUTH_LABELS: Record<McpAuthKind, string> = {
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
}: {
  editing: McpServerDefinition | null;
  /** Prefill for a new server — what the catalog hands over on a one-click. */
  initial?: McpServerInput;
  onCancel: () => void;
  onSave: (input: McpServerInput) => Promise<McpServerDefinition>;
  /** Saves first, then probes: a server has to exist before it can be asked. */
  onTest: (id: string) => Promise<McpProbeResult>;
}) {
  const [input, setInput] = useState<McpServerInput>(
    () => (editing ? mcpServerToInput(editing) : (initial ?? emptyMcpServerInput()))
  );
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

  const problem = useMemo(() => mcpServerInputProblem(input), [input]);
  const catalog = input.catalogHandle ? mcpCatalogEntry(input.catalogHandle) : undefined;

  const edit = useCallback((patch: Partial<McpServerInput>) => {
    setSubmitProblem(null);
    setSaveError(null);
    setInput((p) => ({ ...p, ...patch }));
  }, []);

  const save = useCallback(async () => {
    if (problem) {
      setSubmitProblem(problem);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(input);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save this tool server');
    } finally {
      setSaving(false);
    }
  }, [problem, input, onSave]);

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
    setProbing(true);
    setSaveError(null);
    try {
      const saved = await onSave(input);
      setProbe(await onTest(saved.id));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not reach this tool server');
    } finally {
      setProbing(false);
    }
  }, [problem, input, onSave, onTest]);

  const allowed = input.tools;
  const offered = probe?.toolNames ?? [];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <Button variant="ghost" size="sm" onClick={onCancel} data-attr="mcp-editor-back">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Tool servers
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">
            {input.displayName?.trim() || input.name.trim() || (editing ? 'Tool server' : 'New tool server')}
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
        <Button variant="outline" onClick={testNow} disabled={probing || saving} data-attr="mcp-test">
          {probing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
          {probing ? 'Testing...' : 'Test'}
        </Button>
        <Button onClick={save} disabled={saving} data-attr="mcp-save">
          {saving ? 'Saving...' : editing ? 'Save' : 'Connect'}
        </Button>
      </header>

      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-6">
          {(saveError ?? submitProblem) && (
            <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-500">
              {saveError ?? submitProblem}
            </p>
          )}

          {probe && <ProbeBanner probe={probe} />}

          {catalog?.notes && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
              {catalog.notes}
            </p>
          )}

          <Section
            title="Name"
            description="Becomes a hostname inside the sandbox and the prefix on every tool it offers. Lowercase letters, digits and hyphens."
          >
            <TextField
              value={input.name}
              onChange={(name) => edit({ name })}
              placeholder="linear"
            />
          </Section>

          <Section title="Address" description="The MCP endpoint, path and all.">
            <TextField
              value={input.url}
              onChange={(url) => edit({ url })}
              placeholder="https://mcp.linear.app/mcp"
            />
          </Section>

          <Section
            title="What it is for"
            description="The agent reads this when it decides whether to reach for these tools, so it is worth a sentence."
          >
            <TextField
              value={input.description ?? ''}
              onChange={(description) => edit({ description })}
              placeholder="Issue tracker"
            />
          </Section>

          <SignIn server={editing} />

          <Section
            title="Credential"
            description={
              editing?.hasSecret
                ? 'A key is stored. Leave this blank to keep it, or type a new one to replace it.'
                : catalog?.credentialLabel ?? 'The key this server authenticates with.'
            }
          >
            <div className="space-y-2">
              <select
                className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
                value={input.authKind}
                onChange={(e) => edit({ authKind: e.target.value as McpAuthKind })}
              >
                {MCP_AUTH_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {AUTH_LABELS[k]}
                  </option>
                ))}
              </select>

              {input.authKind === 'header' && (
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

              {input.authKind !== 'none' && (
                <Input
                  type="password"
                  autoComplete="off"
                  value={input.secret ?? ''}
                  onChange={(e) => edit({ secret: e.target.value })}
                  placeholder={editing?.hasSecret ? '••••••••  (unchanged)' : 'Paste the key'}
                />
              )}

              <p className="text-xs text-muted-foreground">
                The key is stored encrypted and never reaches the sandbox. The agent is given a
                plain address on its own gateway and the key is attached on the way out, so an
                agent that reads a hostile repository has nothing to find.
              </p>
            </div>
          </Section>

          <Section
            title="Tools"
            description="Every tool costs space in the agent's prompt on every request. Pick the ones you want, or leave it on all."
            action={
              <Button variant="ghost" size="sm" onClick={testNow} disabled={probing}>
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

/**
 * Sign in to a server that wants OAuth rather than a pasted key.
 *
 * Only offered once the server EXISTS: the flow writes a grant against a row,
 * and there is no row until it is saved. Save first, then sign in — which is
 * also the order the Test button follows, and for the same reason.
 *
 * The consent screen opens in a new tab and this polls. It does not wait on the
 * tab closing: somebody who finishes in a background tab, or on their phone,
 * should still see it connect.
 */
function SignIn({ server }: { server: McpServerDefinition | null }) {
  const [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState(server?.oauth ?? null);
  const [error, setError] = useState<string | null>(null);

  if (!server) {
    return (
      <Section
        title="Sign in"
        description="Some servers are connected by signing in rather than by pasting a key. Save this one first and the option appears here."
      >
        <p className="text-sm text-muted-foreground">Nothing to sign in to yet.</p>
      </Section>
    );
  }

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const { authorizeUrl, flowId } = await api.mcpServers.startSignIn(server.id);
      // Opened BEFORE any further await, so the click's user activation is
      // still live — the mistake the desktop's OAuth flow already paid for.
      openExternal(authorizeUrl);
      // Poll rather than wait on the tab: somebody may finish in a background
      // tab or on another device, and a closed tab is not the signal anyway.
      const until = Date.now() + 10 * 60 * 1000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2000));
        const status = await api.mcpServers.signInStatus(server.id, flowId);
        if (status.status === 'connected' && !status.pending) {
          setGrant({ status: 'connected' });
          return;
        }
        if (status.status === 'needs_reauth') {
          setError(status.detail ?? 'The server refused that sign-in.');
          return;
        }
      }
      setError('That sign-in took too long. Try again.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start sign-in.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const next = await api.mcpServers.disconnect(server.id);
    setGrant(next.oauth ?? null);
  };

  return (
    <Section
      title="Sign in"
      description="Some servers are connected by signing in rather than by pasting a key. The token is held here and refreshed automatically; the sandbox never sees it."
    >
      <div className="space-y-2">
        {grant?.status === 'connected' ? (
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-emerald-600" />
            <span className="text-sm">Signed in{grant.issuer ? ` to ${grant.issuer}` : ''}.</span>
            <Button variant="ghost" size="sm" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </div>
        ) : (
          <Button variant="outline" onClick={() => void start()} disabled={busy}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            {busy ? 'Waiting for the sign-in...' : 'Sign in to this server'}
          </Button>
        )}
        {/* The vendor's own words. "the refresh token has been revoked" and
            "this client is no longer registered" are the same status and very
            different problems. */}
        {grant?.status === 'needs_reauth' && grant.detail && (
          <p className="text-xs text-amber-600">{grant.detail}</p>
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
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
              probe.toolNames ? `, which offers ${probe.toolNames.length} tool${probe.toolNames.length === 1 ? '' : 's'}` : ''
            }.`
          : 'Could not connect.'}
        {probe.detail ? ` ${probe.detail}` : ''}
      </span>
    </p>
  );
}
