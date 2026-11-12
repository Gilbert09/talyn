/**
 * Linear OAuth app configuration, read from the environment on every call
 * (cheap, and tests change it).
 *
 * Talyn owns one Linear OAuth app. It installs as an app user (`actor=app`),
 * so its comments and changes show as "Talyn", not as the person who
 * connected it. The app's webhook is configured once in Linear's app settings,
 * with one signing secret, and Linear creates it for each organization that
 * authorizes the app.
 */

export interface LinearAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export const LINEAR_AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
export const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';
export const LINEAR_REVOKE_URL = 'https://api.linear.app/oauth/revoke';
export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

/**
 * The scopes the connection asks for. `read` and `write` cover reading issues
 * and changing their state; `issues:create` and `comments:create` let Talyn
 * comment. `app:assignable` lets a person assign (delegate) an issue to Talyn,
 * which is what a rule's "Assigned to Talyn" condition reads.
 */
export const LINEAR_SCOPES = ['read', 'write', 'issues:create', 'comments:create', 'app:assignable'] as const;

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

/** The app config, or null when this deployment has no Linear app. */
export function getLinearAppConfig(): LinearAppConfig | null {
  const clientId = env('LINEAR_CLIENT_ID');
  const clientSecret = env('LINEAR_CLIENT_SECRET');
  const redirectUri = env('LINEAR_OAUTH_REDIRECT_URI');
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function requireLinearAppConfig(): LinearAppConfig {
  const config = getLinearAppConfig();
  if (!config) {
    throw new Error('Linear is not configured: set LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET and LINEAR_OAUTH_REDIRECT_URI.');
  }
  return config;
}

/** The app-level webhook's signing secret, or null when it is not set. */
export function linearWebhookSecret(): string | null {
  return env('LINEAR_WEBHOOK_SECRET') || null;
}
