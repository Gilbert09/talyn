import {
  API_SCOPES, API_SCOPE_LABELS, API_TOKEN_DEFAULT_EXPIRY_DAYS,
  type ApiScope, type ApiToken, type CreateApiTokenRequest,
} from '@talyn/shared';

// Pure parts of the API tokens screens. Each one ports a rule from web
// `ApiTokensSettings.tsx`, so both clients mint the same tokens.

export const API_BASE_URL = 'https://api.talyn.dev/v1';
export const OPENAPI_URL = `${API_BASE_URL}/openapi.json`;
const DAY_MS = 86_400_000;
const EXPIRING_SOON_MS = 7 * DAY_MS;
export const ALL_WORKSPACES = 'all';
export const NO_EXPIRY = 'none';
export const EXPIRY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: NO_EXPIRY, label: 'No expiry' },
];
export const DEFAULT_EXPIRY = String(API_TOKEN_DEFAULT_EXPIRY_DAYS);

export type Resource = 'workspaces' | 'teams' | 'spaces' | 'repositories' | 'sessions';
export type Level = 'none' | 'read' | 'write';
export type Levels = Record<Resource, Level>;

const RESOURCES: ReadonlyArray<{ key: Resource; label: string }> = [
  { key: 'workspaces', label: 'Workspaces' },
  { key: 'teams', label: 'Teams' },
  { key: 'spaces', label: 'Spaces' },
  { key: 'repositories', label: 'Repositories' },
  { key: 'sessions', label: 'Sessions' },
];
export const LEVEL_LABELS: Record<Level, string> = { none: 'None', read: 'Read', write: 'Read & write' };

/** The resources the form offers. Teams and spaces only when spaces are offered. */
export const resourcesFor = (offered: boolean) =>
  RESOURCES.filter(({ key }) => offered || (key !== 'teams' && key !== 'spaces'));

/** The levels a resource can have: write only where a write scope exists. */
export const levelsFor = (resource: Resource): Level[] =>
  (API_SCOPES as readonly string[]).includes(`${resource}:write`) ? ['none', 'read', 'write'] : ['none', 'read'];

const READ_ONLY: Levels = { workspaces: 'read', teams: 'none', spaces: 'none', repositories: 'read', sessions: 'read' };
const FULL_ACCESS: Levels = { workspaces: 'read', teams: 'none', spaces: 'none', repositories: 'read', sessions: 'write' };

export const readOnlyLevels = (offered: boolean): Levels => offered ? { ...READ_ONLY, teams: 'read', spaces: 'read' } : { ...READ_ONLY };
export const fullAccessLevels = (offered: boolean): Levels => offered ? { ...FULL_ACCESS, teams: 'read', spaces: 'write' } : { ...FULL_ACCESS };

/** The scopes a set of levels grants. Write sends its read scope too. */
export function scopesFor(levels: Levels, offered: boolean): ApiScope[] {
  return API_SCOPES.filter((scope) => {
    const [resource, action] = scope.split(':') as [string, 'read' | 'write'];
    if (!offered && (resource === 'teams' || resource === 'spaces')) return false;
    const level = (levels as Record<string, Level | undefined>)[resource];
    return level === 'write' || (level === 'read' && action === 'read');
  });
}

/** One chip per resource. A write scope includes read, so it shows once. */
export function scopeChips(scopes: readonly string[], offered: boolean): string[] {
  return resourcesFor(offered).flatMap(({ key, label }) => {
    if (scopes.includes(`${key}:write`)) return [`${label}: read & write`];
    if (scopes.includes(`${key}:read`)) return [`${label}: read`];
    return [];
  });
}

/** What a level lets the token do, in the form's words. */
export function accessHint(resource: Resource, level: Level): string {
  if (level === 'none') return 'No access';
  const read = API_SCOPE_LABELS[`${resource}:read` as ApiScope];
  if (level === 'read') return read;
  return `${read}. ${API_SCOPE_LABELS[`${resource}:write` as ApiScope]}.`;
}

const UNITS: ReadonlyArray<[string, number]> = [
  ['year', 365 * DAY_MS], ['month', 30 * DAY_MS], ['day', DAY_MS], ['hour', 3_600_000], ['minute', 60_000],
];

/**
 * "3 days ago", "in 2 months", the words of web's `Intl.RelativeTimeFormat`.
 * Written out because Hermes does not ship that formatter.
 */
export function relativeTime(iso: string, now: number): string {
  const diff = new Date(iso).getTime() - now;
  if (!Number.isFinite(diff)) return '';
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) < ms) continue;
    const count = Math.abs(Math.round(diff / ms));
    const words = `${count} ${unit}${count === 1 ? '' : 's'}`;
    return diff < 0 ? `${words} ago` : `in ${words}`;
  }
  return 'just now';
}

export type ExpiryTone = 'normal' | 'soon' | 'expired';

export function expiry(token: Pick<ApiToken, 'expiresAt'>, now: number): { text: string; tone: ExpiryTone } {
  if (!token.expiresAt) return { text: 'No expiry', tone: 'normal' };
  const at = new Date(token.expiresAt).getTime();
  const when = relativeTime(token.expiresAt, now);
  if (at <= now) return { text: `Expired ${when}`, tone: 'expired' };
  return { text: `Expires ${when}`, tone: at - now <= EXPIRING_SOON_MS ? 'soon' : 'normal' };
}

/** The token's "Created … · Last used …" line. */
export function usageLine(token: Pick<ApiToken, 'createdAt' | 'lastUsedAt'>, now: number): string {
  return `Created ${relativeTime(token.createdAt, now)} · ${token.lastUsedAt ? `Last used ${relativeTime(token.lastUsedAt, now)}` : 'Never used'}`;
}

/** The workspaces a token reaches. Null is every workspace. */
export function workspaceLabel(ids: readonly string[] | null, workspaces: ReadonlyArray<{ id: string; name: string }>): string {
  if (ids === null) return 'All workspaces';
  return ids.map((id) => workspaces.find((workspace) => workspace.id === id)?.name ?? 'Unknown workspace').join(', ');
}

export const curlExample = (token: string) => `curl ${API_BASE_URL}/me -H "Authorization: Bearer ${token}"`;

export interface TokenDraft { name: string; expiry: string; workspaceId: string; levels: Levels }

export function canCreate(draft: TokenDraft, offered: boolean, creating: boolean): boolean {
  return draft.name.trim().length > 0 && scopesFor(draft.levels, offered).length > 0 && !creating;
}

/** The create body, exactly as web sends it. */
export function createRequest(draft: TokenDraft, offered: boolean): CreateApiTokenRequest {
  return {
    name: draft.name.trim(),
    scopes: scopesFor(draft.levels, offered),
    workspaceIds: draft.workspaceId === ALL_WORKSPACES ? null : [draft.workspaceId],
    expiresInDays: draft.expiry === NO_EXPIRY ? null : Number(draft.expiry),
  };
}

export type TokensView = 'loading' | 'unavailable' | 'error' | 'list';

/**
 * What the list screen draws. Like web, minting needs the `publicApi` flag
 * but listing and revoking do not, so tokens made earlier can still be
 * revoked. With the flag off and no tokens, web hides the section; here the
 * screen says it is not available.
 */
export function tokensView(input: { features: 'loading' | boolean; tokens: readonly unknown[] | undefined; failed: boolean }): TokensView {
  if (input.tokens === undefined) {
    if (input.failed) return 'error';
    return 'loading';
  }
  if (input.features === 'loading' && input.tokens.length === 0) return 'loading';
  if (input.features === false && input.tokens.length === 0) return 'unavailable';
  return 'list';
}
