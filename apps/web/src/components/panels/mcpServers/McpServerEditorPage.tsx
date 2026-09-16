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
