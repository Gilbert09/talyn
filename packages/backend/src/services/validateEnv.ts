/**
 * Boot-time environment validation. The backend used to discover missing
 * config lazily — a missing SUPABASE_URL threw on the first auth request, a
 * missing TALYN_TOKEN_KEY on the first credential write — which turns a bad
 * deploy into a half-alive process that fails on real traffic. Fail fast at
 * boot instead, with every problem reported at once.
 */

/** True when the base64 decoding of `raw` is canonical and >= 32 bytes. */
export function isStrongBase64Key(raw: string): boolean {
  const buf = Buffer.from(raw, 'base64');
  if (buf.length < 32) return false;
  // Buffer.from(_, 'base64') silently ignores invalid characters, so a plain
  // passphrase can "decode" to garbage bytes. Round-trip to prove the input
  // really was base64 (modulo padding).
  return buf.toString('base64').replace(/=+$/, '') === raw.trim().replace(/=+$/, '');
}

/**
 * Validate the process env; returns a list of human-readable problems
 * (empty when the env is sound). Pure — pass a custom `env` in tests.
 */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const errors: string[] = [];
  const production = env.NODE_ENV === 'production';

  const required = ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TALYN_TOKEN_KEY'];
  for (const name of required) {
    if (!env[name]) errors.push(`${name} is not set`);
  }

  // TALYN_TOKEN_KEY encrypts stored integration credentials (AES-256-GCM).
  // tokenCrypto has a SHA-256 fallback that stretches ANY string into a key —
  // fine for dev ergonomics, but in production it silently accepts a
  // low-entropy passphrase as the master key. Refuse that at boot.
  const tokenKey = env.TALYN_TOKEN_KEY;
  if (production && tokenKey && !isStrongBase64Key(tokenKey)) {
    errors.push(
      'TALYN_TOKEN_KEY must be >= 32 random bytes, base64-encoded, in production ' +
        '(generate with `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"`)'
    );
  }

  // GitHub App config is optional as a whole, but a PARTIAL config is always
  // a mistake: connect flows and token refresh throw at request time on
  // whichever half is missing.
  const appVars = [
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_APP_CLIENT_ID',
    'GITHUB_APP_CLIENT_SECRET',
    'GITHUB_APP_SLUG',
  ];
  const setAppVars = appVars.filter((name) => Boolean(env[name]));
  if (setAppVars.length > 0 && setAppVars.length < appVars.length) {
    const missing = appVars.filter((name) => !env[name]);
    errors.push(
      `GitHub App is partially configured (${setAppVars.join(', ')} set) — also set ${missing.join(', ')}`
    );
  }

  // Polar billing is optional as a whole (absent → task limits are simply
  // not enforced), but a PARTIAL config is always a mistake: checkout or
  // webhook verification would throw at request time on the missing half.
  const polarVars = [
    'POLAR_ACCESS_TOKEN',
    'POLAR_WEBHOOK_SECRET',
    'POLAR_ENVIRONMENT',
    'POLAR_PRODUCT_ID_MONTHLY',
    'POLAR_PRODUCT_ID_ANNUAL',
  ];
  const setPolarVars = polarVars.filter((name) => Boolean(env[name]));
  if (setPolarVars.length > 0 && setPolarVars.length < polarVars.length) {
    const missing = polarVars.filter((name) => !env[name]);
    errors.push(
      `Polar billing is partially configured (${setPolarVars.join(', ')} set) — also set ${missing.join(', ')}`
    );
  }
  if (env.POLAR_ENVIRONMENT && !['sandbox', 'production'].includes(env.POLAR_ENVIRONMENT)) {
    errors.push(`POLAR_ENVIRONMENT must be 'sandbox' or 'production', got '${env.POLAR_ENVIRONMENT}'`);
  }

  // Optional (unset = desktop-only deployment). When set it becomes a
  // redirect target for the GitHub App callback, so a malformed or non-https
  // value is a boot error rather than something we discover mid-OAuth — and
  // validating it here means services/webApp.ts can never silently ignore a
  // typo'd production value.
  const webAppUrl = env.WEB_APP_URL?.trim();
  if (webAppUrl) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(webAppUrl);
    } catch {
      errors.push(`WEB_APP_URL is not a valid URL: '${webAppUrl}'`);
    }
    if (parsed && parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
      errors.push(`WEB_APP_URL must be https (or localhost), got '${webAppUrl}'`);
    }
  }

  // PostHog is optional as a whole (absent → every feature flag answers its
  // built-in fallback), but a personal API key with no project key is always a
  // mistake: local evaluation is configured and nothing will ever use it.
  if (env.TALYN_POSTHOG_PERSONAL_API_KEY && !env.TALYN_POSTHOG_KEY) {
    errors.push(
      'TALYN_POSTHOG_PERSONAL_API_KEY is set without TALYN_POSTHOG_KEY — feature flags need the project key too'
    );
  }

  return errors;
}

/**
 * Environment variables that used to do something and no longer do.
 *
 * Warnings, not errors: a retired var must not refuse a boot, because the
 * deployment that still has it set is by definition the one mid-migration. But
 * it must not be silent either. The failure this exists to stop is an operator
 * reading `FLEET_ALLOWED_EMAILS=someone@example.com` in the Railway dashboard
 * and concluding the fleet is gated on it — when the answer has moved to a
 * PostHog flag and that line is now decoration.
 *
 * Each entry says where the setting went, because "this is ignored" without a
 * forwarding address is the half of the message that costs the time.
 */
const RETIRED_ENV: Record<string, string> = {
  FLEET_ALLOWED_EMAILS:
    'the fleet audience is now the "talyn-fleet" PostHog flag — move these addresses to a release condition on it, and use FLEET_ALLOWED only to switch the fleet off in a hurry',
  WORKFLOWS_ALLOWED_EMAILS:
    'workflows is released to everybody; its audience is the "workflows" PostHog flag',
};

/** Retired variables that are still set, with what to do about each. */
export function retiredEnvWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(RETIRED_ENV)
    .filter(([name]) => Boolean(env[name]))
    .map(([name, advice]) => `${name} is set but no longer does anything — ${advice}`);
}

/** Run {@link validateEnv} and throw a single aggregated error on problems. */
export function assertValidEnv(env: NodeJS.ProcessEnv = process.env): void {
  const errors = validateEnv(env);
  if (errors.length > 0) {
    throw new Error(
      `Invalid environment — refusing to start:\n  - ${errors.join('\n  - ')}\nSee docs/SETUP.md for the full list of required variables.`
    );
  }
}
