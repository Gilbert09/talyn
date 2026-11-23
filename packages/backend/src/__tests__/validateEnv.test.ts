import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  validateEnv,
  assertValidEnv,
  isStrongBase64Key,
  retiredEnvWarnings,
} from '../services/validateEnv.js';
import { encryptString } from '../services/tokenCrypto.js';

const STRONG_KEY = randomBytes(32).toString('base64');

/** A complete Polar core group (usage billing). */
const POLAR_CORE = {
  POLAR_ACCESS_TOKEN: 'polar_at',
  POLAR_WEBHOOK_SECRET: 'whsec_x',
  POLAR_ENVIRONMENT: 'sandbox',
  POLAR_PRODUCT_ID_PRO_MONTHLY: 'pro-m',
  POLAR_PRODUCT_ID_PRO_ANNUAL: 'pro-a',
  POLAR_PRODUCT_ID_CREDITS_25: 'c-25',
  POLAR_PRODUCT_ID_CREDITS_100: 'c-100',
  POLAR_PRODUCT_ID_CREDITS_500: 'c-500',
};

/** A fully valid env to mutate per-case. */
function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://localhost:5432/talyn',
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    TALYN_TOKEN_KEY: STRONG_KEY,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('validateEnv', () => {
  it('accepts a fully configured env', () => {
    expect(validateEnv(validEnv())).toEqual([]);
    expect(() => assertValidEnv(validEnv())).not.toThrow();
  });

  it.each(['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TALYN_TOKEN_KEY'])(
    'reports missing %s',
    (name) => {
      const errors = validateEnv(validEnv({ [name]: undefined }));
      expect(errors).toEqual([`${name} is not set`]);
    }
  );

  it('reports every missing variable at once', () => {
    const errors = validateEnv({} as NodeJS.ProcessEnv);
    expect(errors).toHaveLength(4);
  });

  it('accepts a low-entropy TALYN_TOKEN_KEY outside production', () => {
    expect(validateEnv(validEnv({ TALYN_TOKEN_KEY: 'dev-passphrase' }))).toEqual([]);
  });

  it('refuses a low-entropy TALYN_TOKEN_KEY in production', () => {
    const errors = validateEnv(
      validEnv({ NODE_ENV: 'production', TALYN_TOKEN_KEY: 'dev-passphrase' })
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/TALYN_TOKEN_KEY must be >= 32 random bytes/);
  });

  it('accepts a strong base64 TALYN_TOKEN_KEY in production', () => {
    expect(validateEnv(validEnv({ NODE_ENV: 'production' }))).toEqual([]);
  });

  it('flags a partially configured GitHub App with what is missing', () => {
    const errors = validateEnv(validEnv({ GITHUB_APP_ID: '12345' }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('GitHub App is partially configured');
    expect(errors[0]).toContain('GITHUB_APP_PRIVATE_KEY');
    expect(errors[0]).toContain('GITHUB_APP_SLUG');
  });

  it('accepts a fully configured GitHub App', () => {
    const errors = validateEnv(
      validEnv({
        GITHUB_APP_ID: '12345',
        GITHUB_APP_PRIVATE_KEY: 'cGVt',
        GITHUB_APP_CLIENT_ID: 'Iv1.abc',
        GITHUB_APP_CLIENT_SECRET: 'secret',
        GITHUB_APP_SLUG: 'talyn',
      })
    );
    expect(errors).toEqual([]);
  });

  it('flags a partially configured Polar billing group with what is missing', () => {
    const errors = validateEnv(validEnv({ POLAR_ACCESS_TOKEN: 'polar_at' }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Polar billing is partially configured');
    for (const name of [
      'POLAR_WEBHOOK_SECRET',
      'POLAR_PRODUCT_ID_PRO_MONTHLY',
      'POLAR_PRODUCT_ID_PRO_ANNUAL',
      'POLAR_PRODUCT_ID_CREDITS_25',
      'POLAR_PRODUCT_ID_CREDITS_100',
      'POLAR_PRODUCT_ID_CREDITS_500',
    ]) {
      expect(errors[0]).toContain(name);
    }
  });

  it('accepts a fully configured Polar billing group', () => {
    expect(validateEnv(validEnv(POLAR_CORE))).toEqual([]);
  });

  it.each([
    'POLAR_PRODUCT_ID_PRO_MONTHLY',
    'POLAR_PRODUCT_ID_PRO_ANNUAL',
    'POLAR_PRODUCT_ID_CREDITS_25',
    'POLAR_PRODUCT_ID_CREDITS_100',
    'POLAR_PRODUCT_ID_CREDITS_500',
  ])('the core group needs %s', (name) => {
    const errors = validateEnv(validEnv({ ...POLAR_CORE, [name]: undefined }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(new RegExp(`partially configured.*also set ${name}$`));
  });

  it('the old Unlimited-only group from before usage billing no longer boots', () => {
    const errors = validateEnv(
      validEnv({
        POLAR_ACCESS_TOKEN: 'polar_at',
        POLAR_WEBHOOK_SECRET: 'whsec_x',
        POLAR_ENVIRONMENT: 'sandbox',
        POLAR_PRODUCT_ID_MONTHLY: 'prod-m',
        POLAR_PRODUCT_ID_ANNUAL: 'prod-a',
      })
    );
    expect(errors.some((e) => e.includes('Polar billing is partially configured'))).toBe(true);
  });

  it.each<[string, Record<string, string>, RegExp | null]>([
    ['legacy pair, both', { POLAR_PRODUCT_ID_MONTHLY: 'l-m', POLAR_PRODUCT_ID_ANNUAL: 'l-a' }, null],
    ['legacy pair, one', { POLAR_PRODUCT_ID_MONTHLY: 'l-m' }, /old Unlimited products .*partially configured.*POLAR_PRODUCT_ID_ANNUAL/],
    ['old team pair, both', { POLAR_PRODUCT_ID_TEAM_MONTHLY: 't-m', POLAR_PRODUCT_ID_TEAM_ANNUAL: 't-a' }, null],
    ['old team pair, one', { POLAR_PRODUCT_ID_TEAM_ANNUAL: 't-a' }, /Polar team plan is partially configured/],
    ['Pro team pair, both', { POLAR_PRODUCT_ID_TEAM_PRO_MONTHLY: 'tp-m', POLAR_PRODUCT_ID_TEAM_PRO_ANNUAL: 'tp-a' }, null],
    ['Pro team pair, one', { POLAR_PRODUCT_ID_TEAM_PRO_MONTHLY: 'tp-m' }, /Pro team plan is partially configured/],
    ['the Max product alone (monthly only)', { POLAR_PRODUCT_ID_MAX_MONTHLY: 'max-m' }, null],
    ['one usage reset product alone', { POLAR_PRODUCT_ID_RESET_PRO: 'reset-pro' }, null],
    [
      'every usage reset product',
      { POLAR_PRODUCT_ID_RESET_PRO: 'r-p', POLAR_PRODUCT_ID_RESET_MAX: 'r-m', POLAR_PRODUCT_ID_RESET_LEGACY_PRO: 'r-l' },
      null,
    ],
  ])('optional pair on top of billing: %s', (_name, extra, expected) => {
    const errors = validateEnv(validEnv({ ...POLAR_CORE, ...extra }));
    if (expected) {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(expected);
    } else {
      expect(errors).toEqual([]);
    }
  });

  it.each([
    ['the legacy pair', { POLAR_PRODUCT_ID_MONTHLY: 'l-m', POLAR_PRODUCT_ID_ANNUAL: 'l-a' }, /old Unlimited products/],
    ['the Pro team pair', { POLAR_PRODUCT_ID_TEAM_PRO_MONTHLY: 'tp-m', POLAR_PRODUCT_ID_TEAM_PRO_ANNUAL: 'tp-a' }, /Pro team plan/],
    ['the Max product', { POLAR_PRODUCT_ID_MAX_MONTHLY: 'max-m' }, /Max product/],
    ['a usage reset product', { POLAR_PRODUCT_ID_RESET_MAX: 'reset-max' }, /Usage reset products/],
  ])('%s without billing is refused', (_name, extra, label) => {
    const errors = validateEnv(validEnv(extra));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(label);
    expect(errors[0]).toMatch(/but Polar billing is not/);
  });

  it.each([
    ['a credit pack equal to a Pro product', { POLAR_PRODUCT_ID_CREDITS_25: 'pro-m' }, ['POLAR_PRODUCT_ID_PRO_MONTHLY', 'POLAR_PRODUCT_ID_CREDITS_25']],
    ['the Max product equal to a Pro product', { POLAR_PRODUCT_ID_MAX_MONTHLY: 'pro-m' }, ['POLAR_PRODUCT_ID_PRO_MONTHLY', 'POLAR_PRODUCT_ID_MAX_MONTHLY']],
    ['a reset product equal to a Pro product', { POLAR_PRODUCT_ID_RESET_PRO: 'pro-m' }, ['POLAR_PRODUCT_ID_PRO_MONTHLY', 'POLAR_PRODUCT_ID_RESET_PRO']],
    [
      'a legacy product equal to a team product',
      { POLAR_PRODUCT_ID_MONTHLY: 'same', POLAR_PRODUCT_ID_ANNUAL: 'l-a', POLAR_PRODUCT_ID_TEAM_MONTHLY: 'same', POLAR_PRODUCT_ID_TEAM_ANNUAL: 't-a' },
      ['POLAR_PRODUCT_ID_MONTHLY', 'POLAR_PRODUCT_ID_TEAM_MONTHLY'],
    ],
  ])('product ids must be distinct: %s', (_name, extra, names) => {
    const errors = validateEnv(validEnv({ ...POLAR_CORE, ...extra }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/must be distinct/);
    for (const name of names) expect(errors[0]).toContain(name);
  });

  it('accepts an entirely absent Polar billing group (limits simply off)', () => {
    expect(validateEnv(validEnv())).toEqual([]);
  });

  it('rejects an invalid POLAR_ENVIRONMENT value', () => {
    const errors = validateEnv(validEnv({ ...POLAR_CORE, POLAR_ENVIRONMENT: 'staging' }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/POLAR_ENVIRONMENT must be 'sandbox' or 'production'/);
  });

  it('assertValidEnv aggregates all problems into one error', () => {
    expect(() =>
      assertValidEnv(validEnv({ DATABASE_URL: undefined, SUPABASE_URL: undefined }))
    ).toThrow(/DATABASE_URL is not set[\s\S]*SUPABASE_URL is not set/);
  });
});

describe('PostHog feature flags', () => {
  it('accepts no PostHog config at all — every flag answers its fallback', () => {
    expect(validateEnv(validEnv())).toEqual([]);
  });

  it('accepts the project key on its own (remote evaluation)', () => {
    expect(validateEnv(validEnv({ TALYN_POSTHOG_KEY: 'phc_x' }))).toEqual([]);
  });

  it('accepts both keys (local evaluation)', () => {
    expect(
      validateEnv(validEnv({ TALYN_POSTHOG_KEY: 'phc_x', TALYN_POSTHOG_PERSONAL_API_KEY: 'phx_x' }))
    ).toEqual([]);
  });

  it('refuses a personal key with no project key', () => {
    // Local evaluation configured and nothing will ever use it — the same
    // partial-config mistake the GitHub App and Polar checks exist for.
    const errors = validateEnv(validEnv({ TALYN_POSTHOG_PERSONAL_API_KEY: 'phx_x' }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('TALYN_POSTHOG_PERSONAL_API_KEY');
    expect(errors[0]).toContain('TALYN_POSTHOG_KEY');
  });
});

describe('retiredEnvWarnings', () => {
  it('says nothing for a clean env', () => {
    expect(retiredEnvWarnings(validEnv())).toEqual([]);
  });

  it.each(['FLEET_ALLOWED_EMAILS', 'WORKFLOWS_ALLOWED_EMAILS'])(
    'warns about %s and says where the setting went',
    (name) => {
      const warnings = retiredEnvWarnings(validEnv({ [name]: 'someone@example.com' }));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(name);
      // "This is ignored" without a forwarding address is the half of the
      // message that costs the time.
      expect(warnings[0]).toMatch(/PostHog flag/);
    }
  );

  it('reports every retired variable at once', () => {
    const warnings = retiredEnvWarnings(
      validEnv({ FLEET_ALLOWED_EMAILS: 'a@x.com', WORKFLOWS_ALLOWED_EMAILS: 'b@x.com' })
    );
    expect(warnings).toHaveLength(2);
  });

  it('is a warning, not a boot error', () => {
    // The deployment that still has these set is by definition the one
    // mid-migration; refusing to start would be the worse failure.
    const env = validEnv({ FLEET_ALLOWED_EMAILS: 'a@x.com' });
    expect(validateEnv(env)).toEqual([]);
    expect(() => assertValidEnv(env)).not.toThrow();
  });
});

describe('isStrongBase64Key', () => {
  it('accepts canonical base64 of >= 32 bytes', () => {
    expect(isStrongBase64Key(randomBytes(32).toString('base64'))).toBe(true);
    expect(isStrongBase64Key(randomBytes(48).toString('base64'))).toBe(true);
  });

  it('rejects short keys', () => {
    expect(isStrongBase64Key(randomBytes(16).toString('base64'))).toBe(false);
    expect(isStrongBase64Key('')).toBe(false);
  });

  it('rejects non-base64 passphrases even when long', () => {
    expect(isStrongBase64Key('correct horse battery staple correct horse!')).toBe(false);
  });
});

describe('WEB_APP_URL', () => {
  it('is optional — a desktop-only deployment sets nothing', () => {
    expect(validateEnv(validEnv())).toEqual([]);
    expect(validateEnv(validEnv({ WEB_APP_URL: '' }))).toEqual([]);
    expect(validateEnv(validEnv({ WEB_APP_URL: '   ' }))).toEqual([]);
  });

  it.each([
    'https://app.talyn.dev',
    'https://app.talyn.dev/',
    'http://localhost:5173',
  ])('accepts %s', (url) => {
    expect(validateEnv(validEnv({ WEB_APP_URL: url }))).toEqual([]);
  });

  it('rejects a malformed URL', () => {
    expect(validateEnv(validEnv({ WEB_APP_URL: 'app.talyn.dev' }))).toEqual([
      "WEB_APP_URL is not a valid URL: 'app.talyn.dev'",
    ]);
  });

  it('rejects plain http on a non-localhost host', () => {
    // It becomes a redirect target for the GitHub App callback — downgrading
    // that hop to http would leak the flow to any network observer.
    expect(validateEnv(validEnv({ WEB_APP_URL: 'http://app.talyn.dev' }))).toEqual([
      "WEB_APP_URL must be https (or localhost), got 'http://app.talyn.dev'",
    ]);
  });
});

describe('tokenCrypto production fallback guard', () => {
  const savedKey = process.env.TALYN_TOKEN_KEY;
  const savedNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (savedKey === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = savedKey;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  });

  it('refuses the SHA-256 passphrase fallback in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.TALYN_TOKEN_KEY = 'dev-passphrase';
    expect(() => encryptString('secret')).toThrow(/dev-only/);
  });

  it('still accepts a strong base64 key in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.TALYN_TOKEN_KEY = STRONG_KEY;
    expect(() => encryptString('secret')).not.toThrow();
  });
});
