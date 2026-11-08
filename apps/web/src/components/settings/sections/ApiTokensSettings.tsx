import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, AlertTriangle, Copy, ExternalLink, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
import {
  API_SCOPES,
  API_SCOPE_LABELS,
  API_TOKEN_DEFAULT_EXPIRY_DAYS,
  API_TOKEN_NAME_MAX,
  type ApiScope,
  type ApiToken,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { captureAnalyticsException, trackEvent } from '../../../lib/analytics';
import { openExternal } from '../../../lib/openExternal';
import { spacesOffered } from '../../../lib/spaces';
import { cn } from '../../../lib/utils';
import { useWorkspaceStore } from '../../../stores/workspace';
import { toast } from '../../../stores/toast';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Input } from '../../ui/input';
import { SettingsPage, SettingsSection, SettingsSelect } from '../../ui/settings';

const API_BASE_URL = 'https://api.talyn.dev/v1';
const OPENAPI_URL = `${API_BASE_URL}/openapi.json`;
const DAY_MS = 86_400_000;
const EXPIRING_SOON_MS = 7 * DAY_MS;
const ALL_WORKSPACES = 'all';
const NO_EXPIRY = 'none';
const EXPIRY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: NO_EXPIRY, label: 'No expiry' },
];

type Resource = 'workspaces' | 'teams' | 'spaces' | 'repositories' | 'sessions';
type Level = 'none' | 'read' | 'write';
type Levels = Record<Resource, Level>;

const RESOURCES: Array<{ key: Resource; label: string }> = [
  { key: 'workspaces', label: 'Workspaces' },
  { key: 'teams', label: 'Teams' },
  { key: 'spaces', label: 'Spaces' },
  { key: 'repositories', label: 'Repositories' },
  { key: 'sessions', label: 'Sessions' },
];
const resourcesFor = (offered: boolean) =>
  RESOURCES.filter(({ key }) => offered || (key !== 'teams' && key !== 'spaces'));
const LEVEL_LABELS: Record<Level, string> = { none: 'None', read: 'Read', write: 'Read & write' };
const levelsFor = (resource: Resource): Level[] =>
  (API_SCOPES as readonly string[]).includes(`${resource}:write`) ? ['none', 'read', 'write'] : ['none', 'read'];

const READ_ONLY: Levels = { workspaces: 'read', teams: 'none', spaces: 'none', repositories: 'read', sessions: 'read' };
const FULL_ACCESS: Levels = { workspaces: 'read', teams: 'none', spaces: 'none', repositories: 'read', sessions: 'write' };
const READ_ONLY_WITH_SPACES: Levels = { ...READ_ONLY, teams: 'read', spaces: 'read' };
const FULL_ACCESS_WITH_SPACES: Levels = { ...FULL_ACCESS, teams: 'read', spaces: 'write' };

/** The scopes a set of levels grants. Write sends its read scope too. */
function scopesFor(levels: Levels, offered: boolean): ApiScope[] {
  return API_SCOPES.filter((scope) => {
    const [resource, action] = scope.split(':') as [Resource, 'read' | 'write'];
    if (!offered && (resource === 'teams' || resource === 'spaces')) return false;
    const level = levels[resource];
    return level === 'write' || (level === 'read' && action === 'read');
  });
}

/** One chip per resource. A write scope includes read, so it shows once. */
function scopeChips(scopes: readonly string[], offered: boolean): string[] {
  return resourcesFor(offered).flatMap(({ key, label }) => {
    if (scopes.includes(`${key}:write`)) return [`${label}: read & write`];
    if (scopes.includes(`${key}:read`)) return [`${label}: read`];
    return [];
  });
}

function accessHint(resource: Resource, level: Level): string {
  if (level === 'none') return 'No access';
  const read = API_SCOPE_LABELS[`${resource}:read` as ApiScope];
  if (level === 'read') return read;
  return `${read}. ${API_SCOPE_LABELS[`${resource}:write` as ApiScope]}.`;
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * DAY_MS],
  ['month', 30 * DAY_MS],
  ['day', DAY_MS],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "3 days ago", "in 2 months". */
function relativeTime(iso: string, now: number): string {
  const diff = new Date(iso).getTime() - now;
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return RELATIVE.format(Math.round(diff / ms), unit);
  }
  return 'just now';
}

const fullDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function expiry(token: ApiToken, now: number): { text: string; tone: 'normal' | 'soon' | 'expired' } {
  if (!token.expiresAt) return { text: 'No expiry', tone: 'normal' };
  const at = new Date(token.expiresAt).getTime();
  const when = relativeTime(token.expiresAt, now);
  if (at <= now) return { text: `Expired ${when}`, tone: 'expired' };
  return { text: `Expires ${when}`, tone: at - now <= EXPIRING_SOON_MS ? 'soon' : 'normal' };
}

const curlExample = (token: string) => `curl ${API_BASE_URL}/me -H "Authorization: Bearer ${token}"`;

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error('Could not copy to clipboard');
  }
}

/**
 * API tokens: personal tokens for the public API at /v1. The full token shows
 * once, in the create dialog. After that, only its prefix shows.
 *
 * Only minting needs the `publicApi` flag. Listing and revoking always work,
 * so a person can take a token away whatever the flag says.
 */
export function ApiTokensSettings() {
  const publicApi = useWorkspaceStore((s) => s.features?.publicApi === true);
  const offered = useWorkspaceStore((s) => spacesOffered(s.features));
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setTokens(await api.apiTokens.list());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your tokens');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRevoke = async () => {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      await api.apiTokens.revoke(revoking.id);
      trackEvent('api_token_revoked');
      setTokens((prev) => prev?.filter((t) => t.id !== revoking.id) ?? prev);
      toast.success('Token revoked');
      setRevoking(null);
    } catch (e) {
      captureAnalyticsException(e, { flow: 'api_token_revoke' });
      toast.error(e instanceof Error ? e.message : 'Could not revoke the token');
    } finally {
      setRevokeBusy(false);
    }
  };

  if (!publicApi && !loadError && (tokens === null || tokens.length === 0)) return null;

  const workspaceLabel = (ids: string[] | null) =>
    ids === null
      ? 'All workspaces'
      : ids.map((id) => workspaces.find((w) => w.id === id)?.name ?? 'Unknown workspace').join(', ');

  const createButton = publicApi ? (
    <Button size="sm" onClick={() => setCreateOpen(true)}>
      <Plus className="h-3.5 w-3.5" />
      Create token
    </Button>
  ) : null;

  const now = Date.now();

  return (
    <SettingsPage
      title="API tokens"
      description={
        <>
          Call the Talyn API from your own scripts and tools. A token acts as you, with only the access you
          give it.{' '}
          <button
            type="button"
            className="inline-flex items-center gap-0.5 text-foreground underline-offset-2 hover:underline"
            onClick={() => void openExternal(OPENAPI_URL)}
          >
            API reference
            <ExternalLink className="h-3 w-3" />
          </button>
        </>
      }
    >
      <SettingsSection
        title="Tokens"
        actions={tokens !== null && tokens.length > 0 ? createButton : null}
        description={
          publicApi ? null : 'You cannot create new tokens right now. You can still revoke the tokens you have.'
        }
      >
        {tokens === null && loadError ? (
          <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs">
            <span className="flex items-center gap-1.5 text-destructive">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {loadError}
            </span>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : tokens === null ? (
          <div className="flex items-center gap-1.5 px-3 py-2.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading tokens
          </div>
        ) : tokens.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
            <p className="text-[13px] font-medium">No API tokens yet</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Create a token to use Talyn from a script, a CI job or another tool.
            </p>
            {createButton && <div className="mt-1">{createButton}</div>}
          </div>
        ) : (
          tokens.map((t) => {
            const exp = expiry(t, now);
            const expired = exp.tone === 'expired';
            return (
              <div key={t.id} data-testid="api-token-row" className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={cn('truncate text-[13px] font-medium', expired && 'text-muted-foreground')}>
                      {t.name}
                    </span>
                    <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {t.tokenPrefix}…
                    </code>
                    {expired && <Badge variant="error">Expired</Badge>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {scopeChips(t.scopes, offered).map((chip) => (
                      <Badge key={chip} variant="secondary" className="font-normal">
                        {chip}
                      </Badge>
                    ))}
                    <span className="ml-1 truncate text-xs text-muted-foreground">
                      {workspaceLabel(t.workspaceIds)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-1.5 text-[11px] text-muted-foreground">
                    <span title={fullDate(t.createdAt)}>Created {relativeTime(t.createdAt, now)}</span>
                    <span aria-hidden>·</span>
                    <span title={t.lastUsedAt ? fullDate(t.lastUsedAt) : undefined}>
                      {t.lastUsedAt ? `Last used ${relativeTime(t.lastUsedAt, now)}` : 'Never used'}
                    </span>
                    <span aria-hidden>·</span>
                    <span
                      title={t.expiresAt ? fullDate(t.expiresAt) : undefined}
                      className={cn(
                        exp.tone === 'soon' && 'font-medium text-amber-600 dark:text-amber-400',
                        expired && 'text-destructive',
                      )}
                    >
                      {exp.text}
                    </span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Revoke ${t.name}`}
                  onClick={() => setRevoking(t)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Revoke
                </Button>
              </div>
            );
          })
        )}
      </SettingsSection>

      {createOpen && (
        <CreateTokenDialog
          workspaces={workspaces}
          offered={offered}
          onCreated={(token) => setTokens((prev) => [token, ...(prev ?? [])])}
          onClose={() => setCreateOpen(false)}
        />
      )}

      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke "${revoking?.name ?? ''}"?`}
        description="Anything that uses this token stops working at once. You cannot undo this."
        confirmLabel="Revoke token"
        busy={revokeBusy}
        onConfirm={() => void handleRevoke()}
        onCancel={() => setRevoking(null)}
      />
    </SettingsPage>
  );
}

/**
 * The create flow: a form, then the new token once. It mounts only while it is
 * open, so closing it drops the plaintext with the rest of its state.
 */
function CreateTokenDialog({
  workspaces,
  offered,
  onCreated,
  onClose,
}: {
  workspaces: Array<{ id: string; name: string }>;
  offered: boolean;
  onCreated: (token: ApiToken) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [expiryDays, setExpiryDays] = useState(String(API_TOKEN_DEFAULT_EXPIRY_DAYS));
  const [workspaceId, setWorkspaceId] = useState(ALL_WORKSPACES);
  const [levels, setLevels] = useState<Levels>(offered ? READ_ONLY_WITH_SPACES : READ_ONLY);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const trimmed = name.trim();
  const scopes = scopesFor(levels, offered);
  const canCreate = trimmed.length > 0 && scopes.length > 0 && !creating;

  // Escape closes the form, but never the token step: one stray key would lose the token.
  useEffect(() => {
    if (secret) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !creating) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [secret, creating, onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const res = await api.apiTokens.create({
        name: trimmed,
        scopes,
        workspaceIds: workspaceId === ALL_WORKSPACES ? null : [workspaceId],
        expiresInDays: expiryDays === NO_EXPIRY ? null : Number(expiryDays),
      });
      trackEvent('api_token_created', { scopes_count: scopes.length, expiry_set: expiryDays !== NO_EXPIRY });
      setSecret(res.token);
      onCreated(res.apiToken);
    } catch (err) {
      captureAnalyticsException(err, { flow: 'api_token_create' });
      setError(err instanceof Error ? err.message : 'Could not create the token');
    } finally {
      setCreating(false);
    }
  };

  if (secret) {
    // No backdrop or X close here: only Done, so a stray click cannot lose the token.
    return (
      <Dialog open onOpenChange={() => undefined}>
        <DialogContent className="max-w-lg" role="dialog" aria-modal="true" aria-label="Copy your new token">
          <DialogHeader>
            <DialogTitle>Copy your new token</DialogTitle>
            <DialogDescription className="text-xs">&ldquo;{trimmed}&rdquo; is ready to use.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              You won&apos;t see this token again. Copy it now and keep it somewhere safe.
            </p>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Token</div>
              <div className="flex items-start gap-2">
                <code
                  data-testid="api-token-plaintext"
                  className="flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-xs"
                >
                  {secret}
                </code>
                <Button size="sm" variant="outline" aria-label="Copy token" onClick={() => void copy(secret, 'Token')}>
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </Button>
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Try it</div>
              <div className="flex items-start gap-2">
                <code className="flex-1 whitespace-pre-wrap break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
                  {curlExample(secret)}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Copy curl command"
                  onClick={() => void copy(curlExample(secret), 'Command')}
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(next) => !next && !creating && onClose()}>
      <DialogContent
        className="max-w-lg"
        role="dialog"
        aria-modal="true"
        aria-label="Create API token"
        onClose={creating ? undefined : onClose}
      >
        <DialogHeader>
          <DialogTitle>Create API token</DialogTitle>
          <DialogDescription className="text-xs">Give the token only the access your script needs.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="api-token-name" className="text-xs text-muted-foreground">
              Name
            </label>
            <Input
              id="api-token-name"
              autoFocus
              placeholder="For example, CI script"
              value={name}
              maxLength={API_TOKEN_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="api-token-expiry" className="text-xs text-muted-foreground">
                  Expires after
                </label>
                <SettingsSelect
                  id="api-token-expiry"
                  value={expiryDays}
                  onChange={(e) => setExpiryDays(e.target.value)}
                >
                  {EXPIRY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </SettingsSelect>
              </div>
              <div className="space-y-1">
                <label htmlFor="api-token-workspace" className="text-xs text-muted-foreground">
                  Workspace
                </label>
                <SettingsSelect
                  id="api-token-workspace"
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                >
                  <option value={ALL_WORKSPACES}>All workspaces</option>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </SettingsSelect>
              </div>
            </div>
            {expiryDays === NO_EXPIRY && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                A token with no expiry stays valid until you revoke it.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Access</span>
              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setLevels(offered ? READ_ONLY_WITH_SPACES : READ_ONLY)}
                >
                  Read only
                </button>
                <span aria-hidden className="text-muted-foreground/50">
                  |
                </span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setLevels(offered ? FULL_ACCESS_WITH_SPACES : FULL_ACCESS)}
                >
                  Full access
                </button>
              </div>
            </div>
            <div className="divide-y divide-border/60 rounded-lg border border-border">
              {resourcesFor(offered).map(({ key, label }) => (
                <div key={key} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-[13px]">{label}</div>
                    <div className="text-xs text-muted-foreground">{accessHint(key, levels[key])}</div>
                  </div>
                  <div
                    role="radiogroup"
                    aria-label={`${label} access`}
                    className="inline-flex shrink-0 rounded-md border border-input p-0.5"
                  >
                    {levelsFor(key).map((option) => (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={levels[key] === option}
                        onClick={() => setLevels((prev) => ({ ...prev, [key]: option }))}
                        className={cn(
                          'h-6 rounded px-2 text-xs transition-colors',
                          levels[key] === option
                            ? 'bg-accent font-medium text-foreground'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {LEVEL_LABELS[option]}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {scopes.length === 0 && (
              <p className="text-xs text-muted-foreground">Give the token access to at least one thing.</p>
            )}
          </div>

          {error && (
            <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}

          <DialogFooter className="mt-0">
            <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={creating}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!canCreate}>
              {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Create token
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
