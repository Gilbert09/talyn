import { useState } from 'react';
import { Check, Pencil, Plug, Plus, Trash2, X } from 'lucide-react';
import {
  MCP_CATALOG,
  mcpServerFromCatalog,
  type McpCatalogEntry,
  type McpServerDefinition,
  type McpServerInput,
} from '@talyn/shared';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { toast } from '../../../stores/toast';
import { maybeHandleBillingLimit, useBillingStore } from '../../../stores/billing';
import { trackEvent } from '../../../lib/analytics';
import { cn } from '../../../lib/utils';
import { FeedbackButton } from '../workflows/FeedbackButton';
import { useMcpServers } from './useMcpServers';
import { McpServerEditorPage } from './McpServerEditorPage';
import { LocalImport } from './LocalImport';

/**
 * MCP servers — the ones a workspace connects to its Talyn Fleet runs.
 *
 * Not built on `GitHubPageShell`, for the reason Loops is not: that shell is
 * PR-shaped and an MCP server is not a PR.
 *
 * Each row leads with whether the server ANSWERED, because the question
 * somebody has about a connected server is "is this working?" — and one whose
 * key was rotated looks exactly like one nobody has used, unless the last probe
 * is on screen.
 */
export function McpServersPanel() {
  const { servers, error, create, update, remove, setEnabled, test } = useMcpServers();
  const [view, setView] = useState<
    | { mode: 'list' }
    | { mode: 'edit'; server: McpServerDefinition | null; initial?: McpServerInput }
  >({ mode: 'list' });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  /**
   * The one event the server cannot see: somebody who opens the editor and
   * never saves makes no request at all.
   */
  const openEditor = (server: McpServerDefinition | null, initial?: McpServerInput) => {
    trackEvent('mcp_editor_opened', {
      mode: server ? 'edit' : 'create',
      from_catalog: initial?.catalogHandle ?? null,
    });
    setView({ mode: 'edit', server, initial });
  };

  /**
   * Start a new server — unless the free plan has no slot left, in which case
   * pitch the upgrade instead of opening the editor.
   *
   * The server gate is the real one; this only moves the refusal to before the
   * form. Pasting a URL and a key and THEN being told you may not keep it is
   * the worst order to learn it in. The snapshot is owner-wide, so it counts
   * servers in workspaces this page cannot see.
   */
  const openNew = (initial?: McpServerInput) => {
    const status = useBillingStore.getState().status;
    if (status && status.mcpServerLimit != null && status.mcpServers >= status.mcpServerLimit) {
      trackEvent('paywall_shown', {
        reason: 'mcp_server_limit',
        trigger: 'mcp_new',
        mcp_servers: status.mcpServers,
        mcp_server_limit: status.mcpServerLimit,
        plan: status.plan,
      });
      useBillingStore.getState().setUpgradeModalOpen(true, 'mcp_server_limit');
      return;
    }
    openEditor(null, initial);
  };

  const save = async (input: McpServerInput): Promise<McpServerDefinition> => {
    if (view.mode === 'edit' && view.server) {
      const next = await update(view.server.id, input);
      setView({ mode: 'edit', server: next });
      toast.success('MCP server saved');
      return next;
    }
    let made: McpServerDefinition;
    try {
      made = await create(input);
    } catch (err) {
      // A free plan that filled its last slot elsewhere (another window,
      // another workspace) only finds out here. The modal explains it, so let
      // the editor keep the user's work rather than closing it.
      if (maybeHandleBillingLimit(err, 'mcp_server_create')) {
        throw err;
      }
      throw err;
    }
    toast.success('MCP server saved');
    void useBillingStore.getState().refresh();
    // Stay on the editor and switch it into edit mode, because connecting is
    // rarely the last step: the tool list needs a probe, and that needs a saved
    // server to probe.
    setView({ mode: 'edit', server: made });
    return made;
  };

  if (view.mode === 'edit') {
    return (
      <McpServerEditorPage
        existingNames={(servers ?? []).filter((server) => server.id !== view.server?.id).map((server) => server.name)}
        editing={view.server}
        initial={view.initial}
        onCancel={() => setView({ mode: 'list' })}
        onSave={save}
        onTest={test}
      />
    );
  }

  const doDelete = async (server: McpServerDefinition) => {
    // Two clicks rather than a modal. Nothing a run already did with this
    // server is undone, and a box already holding it is untouched.
    if (confirmDelete !== server.id) {
      setConfirmDelete(server.id);
      window.setTimeout(() => setConfirmDelete((id) => (id === server.id ? null : id)), 4000);
      toast.info('Click delete again to confirm', 'This also removes its stored key.');
      return;
    }
    setConfirmDelete(null);
    try {
      await remove(server.id);
      toast.success('MCP server removed');
      void useBillingStore.getState().refresh();
    } catch (err) {
      toast.error('Could not remove', err instanceof Error ? err.message : undefined);
    }
  };

  const connected = new Set((servers ?? []).map((s) => s.catalogHandle).filter(Boolean));

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <Plug className="h-5 w-5" />
        <div className="flex-1">
          <h1 className="text-lg font-semibold">MCP servers</h1>
          <p className="text-sm text-muted-foreground">
            Give your agents tools — Linear, Sentry, your own — with the key held here rather than
            inside the sandbox. Every Talyn Fleet run picks up whatever is switched on.
          </p>
        </div>
        <FeedbackButton surface="mcp_servers" />
        <Button onClick={() => openNew()} data-attr="mcp-new">
          <Plus className="mr-1 h-4 w-4" />
          Add a server
        </Button>
      </header>

      <div className="flex-1 overflow-auto p-6">
        {error && <p className="mb-4 text-sm text-red-500">{error}</p>}

        {/* `null` is loading, `[]` is genuinely none. Rendering the empty state
            for both would flash "nothing connected" at somebody who has six. */}
        {servers === null ? (
          <p className="text-sm text-muted-foreground">Loading MCP servers...</p>
        ) : (
          <div className="space-y-8">
            {servers.length > 0 && (
              <div className="space-y-3">
                {servers.map((server) => (
                  <McpServerRow
                    key={server.id}
                    server={server}
                    confirmingDelete={confirmDelete === server.id}
                    onEdit={() => openEditor(server)}
                    onDelete={() => void doDelete(server)}
                    onSetEnabled={(enabled) => {
                      void setEnabled(server, enabled).catch((err: unknown) =>
                        toast.error(
                          'Could not change that',
                          err instanceof Error ? err.message : undefined
                        )
                      );
                    }}
                  />
                ))}
              </div>
            )}

            {/* Above the catalog on purpose: a server somebody already uses
                is a better first suggestion than one we picked for them. */}
            <LocalImport
              connectedUrls={new Set(servers.map((s) => s.url))}
              onImport={(input) => openNew(input)}
            />

            <Catalog
              connected={connected as Set<string>}
              onPick={(entry) => openNew(mcpServerFromCatalog(entry))}
              empty={servers.length === 0}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function McpServerRow({
  server,
  confirmingDelete,
  onEdit,
  onDelete,
  onSetEnabled,
}: {
  server: McpServerDefinition;
  confirmingDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onSetEnabled: (enabled: boolean) => void;
}) {
  const probe = server.lastProbe;
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border px-4 py-3',
        !server.enabled && 'opacity-60'
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{server.displayName || server.name}</span>
          <code className="truncate text-xs text-muted-foreground">{server.name}</code>
          {/* Absent is "all tools", which is a different statement from a list
              that happens to be long — so it is labelled rather than counted. */}
          {/* Absent is "all tools", which is a different statement from a
              list that happens to be long — so it is labelled, not counted.
              `Array.isArray` rather than `!== null` because the field is
              optional as well as nullable, and both absences mean the same. */}
          <Badge variant="secondary">
            {Array.isArray(server.tools)
              ? `${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}`
              : 'All tools'}
          </Badge>
          {!server.hasSecret && server.authKind !== 'none' && (
            <Badge variant="outline">No key</Badge>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{server.url}</p>
        {probe && (
          <p
            className={cn(
              'mt-1 flex items-center gap-1 text-xs',
              probe.ok ? 'text-emerald-600' : 'text-red-500'
            )}
          >
            {probe.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            {probe.ok
              ? `Answered as ${probe.serverName ?? 'the server'}`
              : (probe.detail ?? 'Could not connect')}
          </p>
        )}
      </div>

      <Button
        variant={server.enabled ? 'secondary' : 'outline'}
        size="sm"
        onClick={() => onSetEnabled(!server.enabled)}
      >
        {server.enabled ? 'On' : 'Off'}
      </Button>
      <Button variant="ghost" size="sm" onClick={onEdit} aria-label="Edit">
        <Pencil className="h-4 w-4" />
      </Button>
      <Button
        variant={confirmingDelete ? 'destructive' : 'ghost'}
        size="sm"
        onClick={onDelete}
        aria-label="Delete"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

/**
 * The one-click catalog.
 *
 * OAuth-only vendors are listed and disabled rather than hidden: somebody
 * looking for Notion should find out that signing in is not wired up yet, not
 * conclude Talyn has never heard of it.
 */
function Catalog({
  connected,
  onPick,
  empty,
}: {
  connected: Set<string>;
  onPick: (entry: McpCatalogEntry) => void;
  empty: boolean;
}) {
  return (
    <div>
      <h2 className="mb-1 font-medium">{empty ? 'Connect your first MCP server' : 'Add another'}</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Pick one to fill in its address, or add any server by hand.
      </p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {MCP_CATALOG.map((entry) => {
          const already = connected.has(entry.handle);
          // Marked rather than refused: these connect fine, they just need a
          // trip to the vendor's consent screen instead of a pasted key.
          const signInOnly = entry.oauth === true && !entry.credentialLabel;
          return (
            <button
              key={entry.handle}
              type="button"
              disabled={already}
              onClick={() => onPick(entry)}
              className={cn(
                'rounded-lg border px-3 py-2 text-left transition',
                already ? 'cursor-default opacity-50' : 'hover:bg-accent'
              )}
            >
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white p-1">
                  <img src={entry.logo} alt="" width={24} height={24} className="object-contain" />
                </span>
                <span className="min-w-0 truncate text-sm font-medium">{entry.title}</span>
                {already && <Badge variant="secondary">Connected</Badge>}
                {!already && signInOnly && <Badge variant="outline">Sign in</Badge>}
                {!already && !signInOnly && entry.authKind === 'none' && (
                  <Badge variant="outline">No key</Badge>
                )}
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{entry.summary}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
