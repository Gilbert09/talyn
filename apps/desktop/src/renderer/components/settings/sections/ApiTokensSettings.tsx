import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, Copy, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
import {
  API_SCOPES,
  API_SCOPE_LABELS,
  API_TOKEN_DEFAULT_EXPIRY_DAYS,
  API_TOKEN_NAME_MAX,
  type ApiScope,
  type ApiToken,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { cn } from '../../../lib/utils';
import { useWorkspaceStore } from '../../../stores/workspace';
import { toast } from '../../../stores/toast';
import { Button } from '../../ui/button';
import { Card } from '../../ui/card';
import { Input } from '../../ui/input';
import { SettingsPage } from '../../ui/settings';

const DEFAULT_SCOPES: ApiScope[] = ['workspaces:read', 'repositories:read', 'sessions:read'];
const NO_EXPIRY = 'none';
const EXPIRY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '180', label: '180 days' },
  { value: '365', label: '365 days' },
  { value: NO_EXPIRY, label: 'No expiry' },
];

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * API tokens: mint a personal token for the public API at /v1. The full token
 * shows once at creation. After that, only its prefix shows.
 */
export function ApiTokensSettings() {
  const publicApi = useWorkspaceStore((s) => s.features?.publicApi === true);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(DEFAULT_SCOPES);
  const [allWorkspaces, setAllWorkspaces] = useState(true);
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([]);
  const [expiry, setExpiry] = useState(String(API_TOKEN_DEFAULT_EXPIRY_DAYS));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The plaintext lives only in this state, until the user dismisses it.
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setTokens(await api.apiTokens.list());
    } catch (e) {
      setTokens((prev) => prev ?? []);
      setError(e instanceof Error ? e.message : 'Failed to load tokens');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const workspaceName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? 'Unknown workspace';

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  const toggleScope = (scope: ApiScope) =>
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));

  const toggleWorkspace = (id: string) =>
    setWorkspaceIds((prev) => (prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id]));

  const trimmed = name.trim();
  const canCreate =
    trimmed.length > 0 && scopes.length > 0 && (allWorkspaces || workspaceIds.length > 0) && !creating;

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await api.apiTokens.create({
        name: trimmed,
        scopes: API_SCOPES.filter((s) => scopes.includes(s)),
        workspaceIds: allWorkspaces ? null : workspaceIds,
        expiresInDays: expiry === NO_EXPIRY ? null : Number(expiry),
      });
      setFreshToken(res.token);
      setName('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create token');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (token: ApiToken) => {
    if (!window.confirm(`Revoke "${token.name}"? Apps that use it stop working.`)) return;
    try {
      await api.apiTokens.revoke(token.id);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to revoke token');
    }
  };

  if (!publicApi && (tokens === null || tokens.length === 0)) return null;

  return (
    <SettingsPage
      title="API tokens"
      description="Use a personal token to call the Talyn API from your own scripts and tools."
    >
      {publicApi && (
        <Card className="p-3 space-y-3">
          <div className="flex items-center gap-2">
            <KeyRound className="w-3.5 h-3.5" />
            <span className="text-[13px] font-medium">Create a token</span>
          </div>
          <div className="space-y-1">
            <label htmlFor="api-token-name" className="text-xs text-muted-foreground">
              Name
            </label>
            <Input
              id="api-token-name"
              placeholder="For example, CI script"
              value={name}
              maxLength={API_TOKEN_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <fieldset className="space-y-1">
            <legend className="text-xs text-muted-foreground">Scopes</legend>
            {API_SCOPES.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                />
                {API_SCOPE_LABELS[scope]}
              </label>
            ))}
            <p className="text-xs text-muted-foreground">Write includes read.</p>
          </fieldset>

          <fieldset className="space-y-1">
            <legend className="text-xs text-muted-foreground">Workspace access</legend>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="radio"
                name="api-token-workspaces"
                checked={allWorkspaces}
                onChange={() => setAllWorkspaces(true)}
              />
              All workspaces
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="radio"
                name="api-token-workspaces"
                checked={!allWorkspaces}
                onChange={() => setAllWorkspaces(false)}
              />
              Only these workspaces
            </label>
            {!allWorkspaces && (
              <div className="ml-5 space-y-1">
                {workspaces.map((w) => (
                  <label key={w.id} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={workspaceIds.includes(w.id)}
                      onChange={() => toggleWorkspace(w.id)}
                    />
                    {w.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <div className="space-y-1">
            <label htmlFor="api-token-expiry" className="text-xs text-muted-foreground">
              Expires after
            </label>
            <select
              id="api-token-expiry"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              className="block h-8 rounded-md border bg-background px-2 text-xs"
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {expiry === NO_EXPIRY && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                A token with no expiry stays valid until you revoke it.
              </p>
            )}
          </div>

          <Button size="sm" onClick={() => void handleCreate()} disabled={!canCreate}>
            {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Create token
          </Button>
          {error && (
            <p className="text-xs text-destructive flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" /> {error}
            </p>
          )}

          {freshToken && (
            <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
              <p className="text-xs font-medium flex items-center gap-1">
                <Check className="w-3.5 h-3.5 text-green-600" /> Copy this token now. You cannot see
                it again.
              </p>
              <div className="flex items-center gap-2">
                <code
                  data-testid="api-token-plaintext"
                  className="flex-1 text-xs bg-muted rounded px-2 py-1.5 break-all"
                >
                  {freshToken}
                </code>
                <Button size="sm" variant="outline" onClick={() => void copy(freshToken, 'Token')}>
                  <Copy className="w-3.5 h-3.5" />
                  Copy token
                </Button>
              </div>
              <code className="block text-xs bg-muted rounded px-2 py-1.5 break-all">
                {`curl https://api.talyn.dev/v1/me -H "Authorization: Bearer ${freshToken}"`}
              </code>
              <Button size="sm" variant="ghost" onClick={() => setFreshToken(null)}>
                Done
              </Button>
            </div>
          )}
        </Card>
      )}

      <Card className="p-3 space-y-2">
        <span className="text-[13px] font-medium">Your API tokens</span>
        {tokens === null ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
          </p>
        ) : tokens.length === 0 ? (
          <p className="text-xs text-muted-foreground">No tokens yet.</p>
        ) : (
          <div className="divide-y">
            {tokens.map((t) => {
              const expired = t.expiresAt !== null && new Date(t.expiresAt).getTime() <= Date.now();
              return (
                <div key={t.id} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium text-[13px] truncate">{t.name}</span>
                      <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {t.tokenPrefix}…
                      </code>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t.scopes.map((s) => API_SCOPE_LABELS[s] ?? s).join(', ')}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Workspaces:{' '}
                      {t.workspaceIds === null ? 'All' : t.workspaceIds.map(workspaceName).join(', ')}
                    </div>
                    <div className="grid grid-cols-3 gap-x-6 text-xs">
                      <div>
                        <div className="text-muted-foreground/70">Created</div>
                        <div className="text-muted-foreground">{formatDate(t.createdAt)}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground/70">Last used</div>
                        <div className="text-muted-foreground">
                          {t.lastUsedAt ? formatDate(t.lastUsedAt) : 'Never'}
                        </div>
                      </div>
                      <div>
                        <div className="text-muted-foreground/70">Expires</div>
                        <div className={cn('text-muted-foreground', expired && 'text-destructive')}>
                          {t.expiresAt
                            ? expired
                              ? `Expired ${formatDate(t.expiresAt)}`
                              : formatDate(t.expiresAt)
                            : 'Never'}
                        </div>
                      </div>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    title="Revoke this token"
                    onClick={() => void handleRevoke(t)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Revoke
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
