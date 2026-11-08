import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import {
  privateRoutesOffered,
  type PrivateConnector,
  type PrivateConnectorStatus,
  type PrivatePeer,
  type PrivateRoute,
} from '@talyn/shared';
import { ApiError, api } from '../../../lib/api';
import { prepareSignInWindow } from '../../../lib/openExternal';
import { useWorkspaceStore } from '../../../stores/workspace';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { SettingRow, SettingsPage, SettingsSection } from '../../ui/settings';

const POLL_MS = 2_000;
const POLLING_STATES = new Set<PrivateConnectorStatus>([
  'needs_login',
  'connecting',
]);

const STATUS_COPY: Record<PrivateConnectorStatus, { label: string; detail: string }> = {
  needs_login: {
    label: 'Sign-in needed',
    detail: 'Open Tailscale sign-in to connect this workspace.',
  },
  awaiting_approval: {
    label: 'Waiting for approval',
    detail: 'A tailnet administrator must approve the connector in Tailscale.',
  },
  connecting: {
    label: 'Connecting',
    detail: 'Talyn is waiting for the private connector to become ready.',
  },
  connected: {
    label: 'Connected',
    detail: 'New sandboxes can use the exact destinations listed below.',
  },
  unavailable: {
    label: 'Unavailable',
    detail: 'The private connector is unavailable. Refresh its state or disconnect it.',
  },
};

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'The private-routes request failed.';
}

function routeProblem(host: string, port: string): string | null {
  if (!host.trim()) return 'Enter one hostname or IP address.';
  if (/[/\s*]/.test(host) || host.includes('://')) return 'Enter one exact hostname or IP address.';
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    return 'Enter a port from 1 to 65535.';
  }
  return null;
}

/** The values a user can copy into the host field, best first. */
function peerHosts(peer: PrivatePeer): string[] {
  return [...new Set([peer.dnsName, ...peer.addresses].filter(Boolean))];
}

/** True when every word of the query occurs in the name, OS, an address or a subnet of the peer. */
function peerMatches(peer: PrivatePeer, query: string): boolean {
  const haystack = [peer.name, peer.os, ...peerHosts(peer), ...peer.subnetRoutes].join(' ').toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

export function PrivateRoutesSettings() {
  const workspaceId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const features = useWorkspaceStore((state) => state.features);
  const offered = privateRoutesOffered(features);
  const [connector, setConnector] = useState<PrivateConnector | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [peers, setPeers] = useState<PrivatePeer[] | null>(null);
  const [peersLoading, setPeersLoading] = useState(false);
  const [peersError, setPeersError] = useState<string | null>(null);
  const [peerQuery, setPeerQuery] = useState('');
  const portInput = useRef<HTMLInputElement>(null);
  const peersRequest = useRef(0);
  const connected = connector?.status === 'connected';
  const visiblePeers = useMemo(
    () => peers?.filter((peer) => peerMatches(peer, peerQuery)) ?? null,
    [peerQuery, peers],
  );

  const readConnector = useCallback(async (showLoading = false) => {
    if (!workspaceId || !offered) return;
    if (showLoading) setLoading(true);
    try {
      const next = await api.workspaces.privateConnector.get(workspaceId);
      setConnector(next);
      if (showLoading && next.status === 'connecting') setPolling(true);
      if (!next.status || !POLLING_STATES.has(next.status)) setPolling(false);
      setError(null);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 404) {
        setConnector(null);
        setPolling(false);
        setError(null);
      } else {
        setError(messageFor(requestError));
        throw requestError;
      }
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [offered, workspaceId]);

  useEffect(() => {
    setConnector(null);
    setError(null);
    if (!workspaceId || !offered) {
      setLoading(false);
      return;
    }
    void readConnector(true).catch(() => undefined);
  }, [offered, readConnector, workspaceId]);

  const readPeers = useCallback(async () => {
    if (!workspaceId || !offered) return;
    // A late answer for an earlier workspace or connector must not replace newer state.
    const request = ++peersRequest.current;
    setPeersLoading(true);
    try {
      const result = await api.workspaces.privateConnector.peers(workspaceId);
      if (request !== peersRequest.current) return;
      setPeers(result.peers);
      setPeersError(null);
    } catch (requestError) {
      if (request !== peersRequest.current) return;
      setPeersError(messageFor(requestError));
    } finally {
      if (request === peersRequest.current) setPeersLoading(false);
    }
  }, [offered, workspaceId]);

  useEffect(() => {
    peersRequest.current += 1;
    setPeers(null);
    setPeersError(null);
    setPeersLoading(false);
    setPeerQuery('');
    if (connected) void readPeers();
  }, [connected, connector?.id, readPeers]);

  useEffect(() => {
    if (!polling || !connector?.status || !POLLING_STATES.has(connector.status) || error) return;
    const timer = window.setInterval(() => {
      void readConnector().catch(() => window.clearInterval(timer));
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [connector?.status, error, polling, readConnector]);

  if (!offered) return null;

  async function connect() {
    if (!workspaceId || busy) return;
    const browser = prepareSignInWindow();
    setBusy(true);
    setError(null);
    try {
      const started = await api.workspaces.privateConnector.start(workspaceId);
      const { loginUrl, ...safeConnector } = started;
      setConnector(safeConnector);
      if (!loginUrl && safeConnector.status !== 'connected') {
        throw new Error('Tailscale did not return a sign-in URL. Try again.');
      }
      if (loginUrl && !(await browser.open(loginUrl))) {
        throw new Error('Your browser blocked the Tailscale sign-in tab. Allow pop-ups and try again.');
      }
      if (!loginUrl) browser.close();
      setPolling(Boolean(safeConnector.status && POLLING_STATES.has(safeConnector.status)));
    } catch (requestError) {
      browser.close();
      setError(messageFor(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function replaceRoutes(routes: PrivateRoute[]): Promise<boolean> {
    if (!workspaceId || busy) return false;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.workspaces.privateConnector.replaceRoutes(workspaceId, { routes });
      setConnector((current) => current
        ? { ...current, ...updated, status: updated.status ?? current.status }
        : updated);
      return true;
    } catch (requestError) {
      setError(messageFor(requestError));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addRoute() {
    const problem = routeProblem(host, port);
    if (problem) {
      setError(problem);
      return;
    }
    const route = { host: host.trim(), port: Number(port) };
    if (connector?.routes.some((item) => item.host.toLowerCase() === route.host.toLowerCase() && item.port === route.port)) {
      setError('That destination is already allowed.');
      return;
    }
    if (await replaceRoutes([...(connector?.routes ?? []), route])) {
      setHost('');
      setPort('');
    }
  }

  async function disconnect() {
    if (!workspaceId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.workspaces.privateConnector.disconnect(workspaceId);
      setConnector(null);
      setPolling(false);
    } catch (requestError) {
      setError(messageFor(requestError));
    } finally {
      setBusy(false);
    }
  }

  const status = connector?.status ? STATUS_COPY[connector.status] : null;

  return (
    <SettingsPage
      title="Private routes"
      description="Add exact private TCP destinations without changing sandbox internet access."
    >
      <SettingsSection title="Tailscale connector">
        <SettingRow
          label={status?.label ?? (loading ? 'Checking connection' : 'Not connected')}
          description={status?.detail ?? 'Connect this workspace to a tailnet before you add destinations.'}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {!loading && (!connector || connector.status === 'needs_login') ? (
            <Button size="sm" onClick={() => void connect()} disabled={busy}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Connect Tailscale
            </Button>
          ) : null}
          {!loading && connector ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void readConnector().catch(() => undefined);
                if (connected) void readPeers();
              }}
              disabled={busy}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          ) : null}
        </SettingRow>
        {connector ? (
          <SettingRow
            label="Disconnect"
            description="Talyn reports success only after YAS removes the connector."
          >
            <Button size="sm" variant="destructive" onClick={() => void disconnect()} disabled={busy}>
              Disconnect
            </Button>
          </SettingRow>
        ) : null}
      </SettingsSection>

      {connector ? (
        <p className="text-xs text-muted-foreground">
          Tailscale does not redirect to Talyn. Complete sign-in in the new tab. This page updates automatically.
        </p>
      ) : null}

      {connector?.status === 'connected' ? (
        <SettingsSection
          title="Allowed destinations"
          description="Each route allows one hostname or IP address and one TCP port."
        >
          {connector.routes.map((route) => (
            <SettingRow key={`${route.host}:${route.port}`} label={<span className="font-mono">{route.host}:{route.port}</span>}>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Remove ${route.host}:${route.port}`}
                disabled={busy}
                onClick={() => void replaceRoutes(connector.routes.filter((item) => item !== route))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </SettingRow>
          ))}
          {connector.routes.length === 0 ? (
            <SettingRow label="No destinations" description="Add the first exact TCP destination below." />
          ) : null}
          <div className="space-y-2 px-3 py-3">
            <div className="flex gap-2">
              <Input aria-label="Hostname or IP" placeholder="db.corp or 10.0.0.8" value={host} onChange={(event) => setHost(event.target.value)} />
              <Input ref={portInput} aria-label="TCP port" className="w-28" inputMode="numeric" placeholder="5432" value={port} onChange={(event) => setPort(event.target.value)} />
              <Button size="sm" className="h-10" disabled={busy} onClick={() => void addRoute()}>
                <Plus className="mr-2 h-4 w-4" />
                Add
              </Button>
            </div>
          </div>
        </SettingsSection>
      ) : null}

      {connected ? (
        <SettingsSection
          title="Tailnet devices"
          description="Devices that the connector can see. Select an address to put it in the hostname field."
          actions={(
            <Button
              size="icon"
              variant="ghost"
              aria-label="Refresh tailnet devices"
              disabled={peersLoading}
              onClick={() => void readPeers()}
            >
              <RefreshCw className={`h-4 w-4${peersLoading ? ' animate-spin' : ''}`} />
            </Button>
          )}
        >
          {peers === null && peersLoading ? (
            <SettingRow label="Loading devices" description="Talyn is reading the tailnet." />
          ) : null}
          {peersError ? (
            <SettingRow label="Devices unavailable" description={peersError} />
          ) : null}
          {peers?.length === 0 && !peersError ? (
            <SettingRow label="No devices" description="The connector cannot see other devices on this tailnet." />
          ) : null}
          {peers && peers.length > 0 ? (
            <div className="px-3 py-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Filter tailnet devices"
                  placeholder="Filter by name, address or OS"
                  className="pl-8 pr-8"
                  value={peerQuery}
                  onChange={(event) => setPeerQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && peerQuery) {
                      event.preventDefault();
                      setPeerQuery('');
                    }
                  }}
                />
                {peerQuery ? (
                  <button
                    type="button"
                    aria-label="Clear device filter"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setPeerQuery('')}
                  >
                    <X className="h-4 w-4" />
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {peers && peers.length > 0 && visiblePeers?.length === 0 ? (
            <SettingRow label="No matching devices" description={`No device matches "${peerQuery.trim()}".`} />
          ) : null}
          {visiblePeers?.map((peer) => (
            <SettingRow
              key={`${peer.name}|${peer.dnsName}|${peer.addresses.join(',')}`}
              label={(
                <span className="flex items-center gap-2">
                  <span
                    aria-label={peer.online ? 'Online' : 'Offline'}
                    className={`h-2 w-2 shrink-0 rounded-full ${peer.online ? 'bg-success' : 'bg-muted-foreground/40'}`}
                  />
                  <span className="font-medium">{peer.name}</span>
                  {peer.os ? <span className="text-xs text-muted-foreground">{peer.os}</span> : null}
                </span>
              )}
              description={(
                <span className="mt-1 flex flex-wrap items-center gap-1.5">
                  {peerHosts(peer).map((address) => (
                    <button
                      key={address}
                      type="button"
                      title={`Use ${address} as the hostname`}
                      className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-foreground hover:bg-muted"
                      onClick={() => {
                        setHost(address);
                        setError(null);
                        portInput.current?.focus();
                      }}
                    >
                      {address}
                    </button>
                  ))}
                  {peer.subnetRoutes.length > 0 ? (
                    <span className="font-mono text-[11px]">
                      Subnets: {peer.subnetRoutes.join(', ')}
                    </span>
                  ) : null}
                </span>
              )}
            />
          ))}
        </SettingsSection>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Added routes apply to new sandboxes. Removed routes revoke access immediately. Existing public internet access stays unchanged.
      </p>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </SettingsPage>
  );
}
