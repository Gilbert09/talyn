import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, Loader2, Timer, Trash2 } from 'lucide-react';
import type { TrunkIntegrationStatus } from '@talyn/shared';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useWorkspaceStore } from '../../stores/workspace';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';

/**
 * Settings → Integrations: the workspace's Trunk org API token, which lets PR
 * rows show when Trunk's merge queue will merge them. The backend never
 * returns the token; this card sees only whether one is set and whether Trunk
 * refused it.
 *
 * Drawn only when the `trunkMergeEta` feature is on. Duplicated in apps/web on
 * purpose: the renderer is a deliberate fork.
 */
export function TrunkSettingsCard() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const flag = useWorkspaceStore((s) => s.features?.trunkMergeEta);
  const enabled = flag === true;
  const [status, setStatus] = useState<TrunkIntegrationStatus | null>(null);
  const [token, setToken] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    try {
      setStatus(await api.trunk.getStatus(workspaceId));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not read the Trunk connection');
    }
  }, [workspaceId]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  if (!enabled) return null;

  const connected = status?.connected === true;
  const needsReauth = status?.needsReauth === true;
  const showForm = !connected || editing;

  async function save() {
    if (!workspaceId || !token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.trunk.saveToken(workspaceId, token.trim()));
      setToken('');
      setEditing(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save the Trunk token');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.trunk.removeToken(workspaceId));
      setEditing(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not remove the Trunk token');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-start gap-4">
        <div
          className={cn(
            'w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0',
            connected && !needsReauth ? 'bg-green-500/10' : 'bg-secondary'
          )}
        >
          <Timer className={cn('w-5 h-5', connected && !needsReauth && 'text-green-500')} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-medium">Trunk merge queue</h4>
            {connected && !needsReauth && (
              <Badge variant="default" className="bg-green-600">
                <Check className="w-3 h-3 mr-1" />
                Connected
              </Badge>
            )}
            {needsReauth && <Badge variant="warning">Reconnect needed</Badge>}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {needsReauth
              ? 'Trunk refused the saved token. Paste a new organization API token to see merge ETAs again.'
              : 'Show when pull requests in Trunk’s merge queue will merge. Paste your Trunk organization API token. Talyn stores it encrypted and never shows it again.'}
          </p>
          {error && (
            <p className="mt-2 flex items-center gap-1 text-sm text-red-500">
              <AlertCircle className="w-4 h-4" />
              {error}
            </p>
          )}
          {showForm && (
            <form
              className="mt-3 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <Input
                type="password"
                autoComplete="off"
                placeholder="Trunk organization API token"
                aria-label="Trunk organization API token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={busy}
              />
              <Button type="submit" disabled={busy || !token.trim()}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
              </Button>
              {editing && (
                <Button type="button" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
                  Cancel
                </Button>
              )}
            </form>
          )}
        </div>
        {connected && !editing && (
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setEditing(true)} disabled={busy}>
              {needsReauth ? 'Reconnect' : 'Replace token'}
            </Button>
            <Button variant="outline" onClick={() => void remove()} disabled={busy} title="Remove the Trunk token">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
