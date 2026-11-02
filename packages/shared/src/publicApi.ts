/**
 * The public API (`/v1`) vocabulary that both the backend and the apps use:
 * token scopes, the token shapes of the Settings → Developer card, and the
 * limits on what a token can be minted with.
 *
 * The public API itself is snake_case and has its own shapes. These types are
 * for the INTERNAL management routes (`/api/v1/api-tokens`), which follow the
 * app conventions (camelCase, `{ success, data }`).
 */

/** The prefix of every personal access token. Secret scanners match it. */
export const API_TOKEN_PREFIX = 'talyn_pat_';

/**
 * What a token may do. A write scope includes its read scope.
 *
 * Later phases add scopes for pull requests and the rest. An old token never
 * gets a new scope by itself.
 */
export const API_SCOPES = [
  'workspaces:read',
  'repositories:read',
  'repositories:write',
  'sessions:read',
  'sessions:write',
  'memory:read',
  'memory:write',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** What each scope allows, in words for the token form. */
export const API_SCOPE_LABELS: Record<ApiScope, string> = {
  'workspaces:read': 'Read workspaces',
  'repositories:read': 'Read repositories and their settings',
  'repositories:write': 'Change repository settings and instructions',
  'sessions:read': 'Read sessions, chats and transcripts',
  'sessions:write': 'Start sessions and send messages',
  'memory:read': 'Read workspace memory',
  'memory:write': 'Write and forget workspace memory',
};

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === 'string' && (API_SCOPES as readonly string[]).includes(value);
}

/** Whether `granted` allows `required`. A `:write` scope allows its `:read` scope. */
export function scopeAllows(granted: readonly string[], required: ApiScope): boolean {
  if (granted.includes(required)) return true;
  if (required.endsWith(':read')) return granted.includes(required.replace(/:read$/, ':write'));
  return false;
}

/** The expiry a new token gets when the form does not say. */
export const API_TOKEN_DEFAULT_EXPIRY_DAYS = 90;
/** The longest expiry a token can have, other than "never". */
export const API_TOKEN_MAX_EXPIRY_DAYS = 365;
/** The longest token name. The list shows it on one line. */
export const API_TOKEN_NAME_MAX = 100;

/** A personal access token as the Settings list shows it. Never the secret or its hash. */
export interface ApiToken {
  id: string;
  name: string;
  /** The start of the token, e.g. `talyn_pat_ab12cd`. For telling tokens apart only. */
  tokenPrefix: string;
  scopes: ApiScope[];
  /** The workspaces the token can reach. Null means every workspace of the owner. */
  workspaceIds: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** Null means the token never expires. */
  expiresAt: string | null;
}

export interface CreateApiTokenRequest {
  name: string;
  scopes: ApiScope[];
  /** Absent or null: every workspace of the owner. */
  workspaceIds?: string[] | null;
  /** Days until expiry. Absent: 90. Null: never. At most 365. */
  expiresInDays?: number | null;
}

/** Returned once, when the token is created. `token` cannot be read again. */
export interface CreateApiTokenResponse {
  token: string;
  apiToken: ApiToken;
}
