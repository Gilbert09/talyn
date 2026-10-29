/**
 * Slack app configuration, read from the environment on every call (cheap,
 * and tests change it).
 *
 * The client pair is read from `SLACK_APP_CLIENT_ID` / `SLACK_APP_CLIENT_SECRET`
 * first and falls back to the MCP connector's `SLACK_MCP_CLIENT_ID` /
 * `SLACK_MCP_CLIENT_SECRET`. Today one internal app serves both; a separate,
 * distributed app later is then an env change and nothing else.
 */

export interface SlackAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** The bot scopes the install asks for. No `chat:write`: Talyn never posts. */
export const SLACK_BOT_SCOPES = [
  'app_mentions:read',
  'reactions:read',
  'reactions:write',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'channels:read',
  'groups:read',
  'users:read',
  'emoji:read',
] as const;

/** "Sign in with Slack" (OpenID Connect) scopes for linking an account. */
export const SLACK_LINK_SCOPES = ['openid', 'profile'] as const;

export class SlackNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackNotConfiguredError';
  }
}

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

/**
 * The callback both flows return to. A dedicated env var holding the full URL,
 * the same as `POSTHOG_OAUTH_REDIRECT_URI`: the backend has no general
 * public-URL setting, and Slack compares this string with the one registered
 * on the app, so it must be stated, not guessed from a request.
 */
export function slackRedirectUri(): string | null {
  const raw = env('SLACK_OAUTH_REDIRECT_URI');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      return null;
    }
  } catch {
    return null;
  }
  return raw;
}

/** The OAuth client config, or null when this deployment has no Slack app. */
export function getSlackAppConfig(): SlackAppConfig | null {
  const clientId = env('SLACK_APP_CLIENT_ID') || env('SLACK_MCP_CLIENT_ID');
  const clientSecret = env('SLACK_APP_CLIENT_SECRET') || env('SLACK_MCP_CLIENT_SECRET');
  const redirectUri = slackRedirectUri();
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

/** Like {@link getSlackAppConfig}, but throws a sentence an operator can act on. */
export function requireSlackAppConfig(): SlackAppConfig {
  const config = getSlackAppConfig();
  if (config) return config;
  throw new SlackNotConfiguredError(
    'Slack is not configured on this deployment. Set SLACK_APP_CLIENT_ID, ' +
      'SLACK_APP_CLIENT_SECRET (or the SLACK_MCP_* pair) and SLACK_OAUTH_REDIRECT_URI.'
  );
}

/** The Events API signing secret, or null when unset. */
export function slackSigningSecret(): string | null {
  return env('SLACK_SIGNING_SECRET') || null;
}
