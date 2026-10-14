import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, Copy, KeyRound, Loader2, Plug, Plus, Trash2 } from 'lucide-react';
import type { McpToken } from '@talyn/shared';
import { api, getMcpEndpoint } from '../../../lib/api';
import { cn } from '../../../lib/utils';
import { toast } from '../../../stores/toast';
import { Button } from '../../ui/button';
import { Card } from '../../ui/card';
import { Input } from '../../ui/input';
import { SettingsPage } from '../../ui/settings';

/**
 * MCP server settings — mint a long-lived personal token and copy the one-line
 * `claude mcp add` command that points a Claude client at the hosted endpoint.
 * The token authenticates the backend's `/api/v1/mcp` endpoint; it's shown in
 * full exactly once at creation, then only its prefix is ever displayed.
 */
export function MCPServerSettings() {
  const endpoint = getMcpEndpoint();
  const [tokens, setTokens] = useState<McpToken[] | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The full plaintext token + command, held only until the user dismisses it
  // (we can never retrieve the secret again).
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setTokens(await api.mcpTokens.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load tokens');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const installCommand = (token: string) =>
    `claude mcp add --transport http talyn ${endpoint} --header "Authorization: Bearer ${token}"`;

  // The secret never renders in full — head + tail is enough to recognise it;
  // the Copy buttons carry the real value.
  const maskToken = (token: string) =>
    `${token.slice(0, 14)}${'•'.repeat(12)}${token.slice(-4)}`;

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await api.mcpTokens.create(name.trim() ? { name: name.trim() } : {});
      setFreshToken(res.token);
      setName('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create token');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await api.mcpTokens.revoke(id);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to revoke token');
    }
  };

  return (
    <SettingsPage
      title="Talyn MCP server"
      description="Drive Talyn from a Claude client (Claude Code or Claude Desktop). Generate a personal token, then run the command below to connect."
    >
      <Card className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Plug className="w-3.5 h-3.5" />
          <span className="text-[13px] font-medium">Endpoint</span>
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs bg-muted rounded px-2 py-1.5 truncate">{endpoint}</code>
          <Button size="sm" variant="outline" onClick={() => void copy(endpoint, 'Endpoint')}>
            <Copy className="w-3.5 h-3.5" />
          </Button>
        </div>
      </Card>

      {/* Generate */}
      <Card className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <KeyRound className="w-3.5 h-3.5" />
          <span className="text-[13px] font-medium">Generate a token</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Tokens are long-lived (90 days) and tied to your account. The full token is shown
          once — copy it now. You can revoke it any time below.
        </p>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Optional label (e.g. Laptop)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1"
          />
          <Button size="sm" onClick={() => void handleCreate()} disabled={creating}>
            {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Generate
          </Button>
        </div>
        {error && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="w-3.5 h-3.5" /> {error}
          </p>
        )}

        {freshToken && (
          <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
            <p className="text-xs font-medium flex items-center gap-1">
              <Check className="w-3.5 h-3.5 text-green-600" /> Token created — copy it now, it
              won&apos;t be shown again.
            </p>
            <div>
              <label className="text-xs text-muted-foreground">Token</label>
              <div className="flex items-center gap-2 mt-1">
                {/* Displayed masked (head + tail only) so the secret never sits
                    readable on screen; the Copy button carries the real value. */}
                <code className="flex-1 text-xs bg-muted rounded px-2 py-1.5 truncate">
                  {maskToken(freshToken)}
                </code>
                <Button size="sm" variant="outline" onClick={() => void copy(freshToken, 'Token')}>
                  <Copy className="w-3.5 h-3.5" />
                  Copy token
                </Button>
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                Install command (includes the token)
              </label>
              <div className="flex items-start gap-2 mt-1">
                <code className="flex-1 text-xs bg-muted rounded px-2 py-1.5 break-all whitespace-pre-wrap">
                  {installCommand(maskToken(freshToken))}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void copy(installCommand(freshToken), 'Command')}
                >
                  <Copy className="w-3.5 h-3.5" />
                  Copy command
                </Button>
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setFreshToken(null)}>
              Done
            </Button>
          </div>
        )}
      </Card>

      {/* Existing tokens */}
      <Card className="p-3 space-y-2">
        <span className="text-[13px] font-medium">Your tokens</span>
        {tokens === null ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
          </p>
        ) : tokens.length === 0 ? (
          <p className="text-xs text-muted-foreground">No tokens yet.</p>
        ) : (
          <div className="divide-y">
            {tokens.map((t) => {
              const fmt = (iso: string) =>
                new Date(iso).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                });
              const expiringSoon =
                t.expiresAt &&
                new Date(t.expiresAt).getTime() - Date.now() < 14 * 86_400_000;
              return (
                <div key={t.id} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium text-[13px] truncate">{t.name}</span>
                      <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {t.tokenPrefix}…
                      </code>
                    </div>
                    <div className="grid grid-cols-3 gap-x-6 text-xs">
                      <div>
                        <div className="text-muted-foreground/70">Created</div>
                        <div className="text-muted-foreground">{fmt(t.createdAt)}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground/70">Last used</div>
                        <div className="text-muted-foreground">
                          {t.lastUsedAt ? fmt(t.lastUsedAt) : 'Never'}
                        </div>
                      </div>
                      <div>
                        <div className="text-muted-foreground/70">Expires</div>
                        <div
                          className={cn(
                            'text-muted-foreground',
                            expiringSoon && 'text-amber-600 dark:text-amber-400'
                          )}
                        >
                          {t.expiresAt ? fmt(t.expiresAt) : 'Never'}
                        </div>
                      </div>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    title="Revoke this token"
                    onClick={() => void handleRevoke(t.id)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </SettingsPage>
  );
}
