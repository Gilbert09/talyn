// Integrations → Linear → Connection: connect Linear organizations for issue
// rules, and offer the separate Linear MCP server. The desktop opens Linear in
// the system browser and reads the status again when the window gets focus.

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ExternalLink, Loader2 } from 'lucide-react';
import {
  ISSUE_RULES_UNAVAILABLE_CODE,
  LINEAR_NOT_CONFIGURED_CODE,
  mcpCatalogEntry,
  mcpServerFromCatalog,
  mcpServersOffered,
  type LinearConnection,
  type LinearStatus,
  type McpServerDefinition,
} from '@talyn/shared';
import { api } from '../../lib/api';
import { captureAnalyticsException, trackEvent } from '../../lib/analytics';
import { openExternal, prepareSignInWindow } from '../../lib/openExternal';
import { toast } from '../../stores/toast';
import { useNavigationStore } from '../../stores/navigation';
import { useWorkspaceStore } from '../../stores/workspace';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { ConfirmDialog } from '../ui/confirm-dialog';

function errorCode(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Linear's own sign-in. Opens the authorize page in the system browser. */
async function startLinearConnect(workspaceId: string): Promise<void> {
  const { authorizeUrl } = await api.linear.connect({ workspaceId });
  await openExternal(authorizeUrl);
}

function ConnectionCard({
  connection,
  busy,
  onReconnect,
  onDisconnect,
}: {
  connection: LinearConnection;
  busy: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const name = connection.organizationName ?? connection.urlKey ?? connection.organizationId;
  const broken = connection.reauthRequiredAt !== null;
  return (
    <Card className="space-y-3 p-4" data-attr="linear-connection" data-connection-id={connection.id}>
      <div className="flex items-center gap-2">
        <span className="font-medium">{name}</span>
        {broken ? <Badge variant="warning">Needs reconnect</Badge> : <Badge variant="success">Connected</Badge>}
        {connection.urlKey && (
          <a
            href={`https://linear.app/${encodeURIComponent(connection.urlKey)}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            linear.app/{connection.urlKey}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          data-attr="linear-disconnect"
          disabled={busy}
          onClick={onDisconnect}
        >
          Disconnect
        </Button>
      </div>
      {broken && (
        <div className="space-y-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3">
          <p className="flex items-center gap-2 text-sm">
            <AlertCircle className="h-4 w-4 text-yellow-500" />
            {connection.reauthReason ?? 'Linear stopped accepting Talyn\'s access.'} Reconnect to start work from Linear again.
          </p>
          <Button size="sm" data-attr="linear-reconnect" disabled={busy} onClick={onReconnect}>
            Reconnect
          </Button>
        </div>
      )}
      {!broken && !connection.canAssign && (
        <p className="text-xs text-muted-foreground">
          Issues cannot be assigned to Talyn on this connection. To allow it, reconnect.
        </p>
      )}
    </Card>
  );
}

/**
 * The Linear MCP server, which gives the agent Linear tools in a session. It is
 * a separate sign-in from the connection above.
 */
export function LinearMcpOffer() {
  const offered = useWorkspaceStore((s) => mcpServersOffered(s.features));
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const navigate = useNavigationStore((s) => s.navigate);
  const [servers, setServers] = useState<McpServerDefinition[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entry = mcpCatalogEntry('linear');

  const load = useCallback(() => {
    if (!offered || !workspaceId) return;
    api.mcpServers
      .list(workspaceId)
      .then(setServers)
      .catch(() => setServers([]));
  }, [offered, workspaceId]);

  useEffect(() => {
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  if (!offered || !entry || !workspaceId) return null;
  const existing = servers?.find((s) => s.catalogHandle === 'linear' || s.url === entry.url) ?? null;

  const connect = async () => {
    // Reserve the tab while the click still allows a popup.
    const browser = prepareSignInWindow();
    let opened = false;
    setBusy(true);
    setError(null);
    try {
      const made = await api.mcpServers.create(workspaceId, mcpServerFromCatalog(entry));
      trackEvent('linear_mcp_connect_started');
      const flow = await api.mcpServers.startSignIn(made.id);
      opened = await browser.open(flow.authorizeUrl);
      setStarted(true);
      load();
    } catch (err) {
      captureAnalyticsException(err, { flow: 'linear_mcp_connect' });
      setError(errorMessage(err, 'Could not start the MCP sign-in.'));
    } finally {
      if (!opened) browser.close();
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-2 p-4" data-attr="linear-mcp-offer">
      <div className="text-sm font-medium">Linear MCP server</div>
      <p className="text-xs text-muted-foreground">
        The MCP server gives the agent Linear tools in its sessions. It uses its own sign-in, separate
        from the connection above.
      </p>
      {existing ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{started ? 'Finish the sign-in in your browser.' : 'A Linear MCP server is already set up.'}</span>
          <Button size="sm" variant="outline" data-attr="linear-mcp-open" onClick={() => navigate({ view: 'settings', section: 'mcp' })}>
            Open MCP servers
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" data-attr="linear-mcp-connect" disabled={busy || servers === null} onClick={() => void connect()}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Also connect as an MCP server
        </Button>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
    </Card>
  );
}

export function LinearSettings() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const [status, setStatus] = useState<LinearStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDisconnect, setPendingDisconnect] = useState<LinearConnection | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    try {
      setStatus(await api.linear.getStatus(workspaceId));
      setLoadError(null);
    } catch (e) {
      if (errorCode(e) === ISSUE_RULES_UNAVAILABLE_CODE) {
        setLoadError('Linear automations are not available for this account.');
      } else {
        setLoadError(errorMessage(e, 'Could not load Linear.'));
      }
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The browser flow ends on a "close this tab" page, so read again on return.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const connect = async () => {
    if (!workspaceId) return;
    setBusy(true);
    try {
      await startLinearConnect(workspaceId);
    } catch (e) {
      captureAnalyticsException(e, { flow: 'linear_connect' });
      if (errorCode(e) === LINEAR_NOT_CONFIGURED_CODE) {
        setNotConfigured(errorMessage(e, 'Linear is not set up on this deployment.'));
      } else {
        toast.error('Could not start the Linear sign-in', errorMessage(e, 'Try again.'));
      }
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!workspaceId || !pendingDisconnect) return;
    setDisconnecting(true);
    try {
      await api.linear.disconnect(workspaceId, pendingDisconnect.id);
      trackEvent('linear_disconnected');
      toast.success('Linear disconnected');
      setPendingDisconnect(null);
      await refresh();
    } catch (e) {
      captureAnalyticsException(e, { flow: 'linear_disconnect' });
      toast.error('Could not disconnect', errorMessage(e, 'Try again.'));
    } finally {
      setDisconnecting(false);
    }
  };

  const configured = status?.configured !== false && !notConfigured;
  const connections = status?.connections ?? [];

  return (
    <div className="space-y-4" data-attr="linear-settings">
      <div>
        <h3 className="text-lg font-medium">Linear</h3>
        <p className="text-sm text-muted-foreground">
          Connect a Linear workspace. Automations then start work from its issues, comment on them and
          move them to done when the fix merges.
        </p>
      </div>

      {loadError && !status ? (
        <Card className="space-y-3 p-4">
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {loadError}
          </p>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            Try again
          </Button>
        </Card>
      ) : !status ? (
        <Card className="p-4">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </Card>
      ) : (
        <>
          {connections.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              busy={busy}
              onReconnect={() => void connect()}
              onDisconnect={() => setPendingDisconnect(connection)}
            />
          ))}
          <Card className="space-y-3 p-4">
            {connections.length === 0 && (
              <p className="text-sm text-muted-foreground">No Linear workspace is connected yet.</p>
            )}
            <Button size="sm" data-attr="linear-connect" disabled={busy || !configured} onClick={() => void connect()}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {connections.length === 0 ? 'Connect Linear' : 'Connect another Linear workspace'}
            </Button>
            {!configured && (
              <p className="text-xs text-muted-foreground" data-attr="linear-not-configured">
                {notConfigured ?? 'Linear is not set up on this deployment.'}
              </p>
            )}
          </Card>
          <LinearMcpOffer />
        </>
      )}

      <ConfirmDialog
        open={pendingDisconnect !== null}
        title="Disconnect Linear?"
        description="Talyn removes its access to this Linear workspace. Its automations stop matching until you connect it again."
        confirmLabel="Disconnect"
        busy={disconnecting}
        onConfirm={() => void disconnect()}
        onCancel={() => setPendingDisconnect(null)}
      />
    </div>
  );
}
