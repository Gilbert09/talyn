import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOBILE_RETURN_SCHEMES } from '@talyn/shared';
import {
  mobileBillingBounceUrl,
  mobileBillingReturnUrl,
  mobileGitHubReturnUrl,
  mobileReturnSchemes,
  parseReturnTo,
  publicApiOrigin,
  validMobileReturn,
} from '../services/mobileReturn.js';

const ENV_KEYS = [
  'MOBILE_RETURN_SCHEMES',
  'TALYN_PUBLIC_API_URL',
  'POSTHOG_OAUTH_REDIRECT_URI',
  'SLACK_OAUTH_REDIRECT_URI',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('validMobileReturn — default allowlist', () => {
  it.each(DEFAULT_MOBILE_RETURN_SCHEMES.map((s) => [s]))('accepts %s', (value) => {
    expect(validMobileReturn(value)).toBe(value);
  });

  it.each<[string, unknown]>([
    ['uppercase scheme', 'TALYN-MOBILE://'],
    ['mixed case scheme', 'Talyn-Mobile://'],
    ['extra trailing slash', 'talyn-mobile:///'],
    ['a host after the scheme', 'talyn-mobile://evil'],
    ['a host with a dot', 'talyn-mobile://evil.example.com'],
    ['a path', 'talyn-mobile://github/callback'],
    ['a query', 'talyn-mobile://?x=1'],
    ['a fragment', 'talyn-mobile://#x'],
    ['userinfo', 'talyn-mobile://user@host'],
    ['no slashes', 'talyn-mobile-development:'],
    ['one slash', 'talyn-mobile:/'],
    ['no colon', 'talyn-mobile'],
    ['leading whitespace', ' talyn-mobile://'],
    ['trailing whitespace', 'talyn-mobile:// '],
    ['trailing newline', 'talyn-mobile://\n'],
    ['https', 'https://app.talyn.dev'],
    ['bare https scheme', 'https://'],
    ['http', 'http://localhost:3000'],
    ['javascript', 'javascript:alert(1)'],
    ['javascript scheme only', 'javascript://'],
    ['data', 'data:text/html,hi'],
    ['protocol-relative', '//evil.example.com'],
    ['unknown app scheme', 'other-app://'],
    ['prefix of an allowed scheme', 'talyn-mobile-prev://'],
    ['allowed scheme as a suffix', 'xtalyn-mobile://'],
    ['empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['number', 42],
    ['array', ['talyn-mobile://']],
    ['object', { toString: () => 'talyn-mobile://' }],
  ])('refuses %s', (_label, value) => {
    expect(validMobileReturn(value)).toBeNull();
  });
});

describe('MOBILE_RETURN_SCHEMES override', () => {
  it.each<[string, string | undefined, readonly string[]]>([
    ['unset: the defaults', undefined, DEFAULT_MOBILE_RETURN_SCHEMES],
    ['blank: the defaults', '   ', DEFAULT_MOBILE_RETURN_SCHEMES],
    ['one entry', 'myapp://', ['myapp://']],
    ['entries trimmed', ' myapp:// , other:// ', ['myapp://', 'other://']],
    ['entries lowercased', 'MyApp://', ['myapp://']],
    ['duplicates collapsed', 'myapp://,myapp://', ['myapp://']],
    ['empty parts skipped', 'myapp://,,', ['myapp://']],
    ['entry without slashes dropped', 'myapp:,ok://', ['ok://']],
    ['entry with a host dropped', 'myapp://host,ok://', ['ok://']],
    ['entry with a path dropped', 'myapp://a/b,ok://', ['ok://']],
    ['https dropped', 'https://,ok://', ['ok://']],
    ['http dropped', 'http://,ok://', ['ok://']],
    ['javascript dropped', 'javascript://,ok://', ['ok://']],
    ['file dropped', 'file://,ok://', ['ok://']],
    ['every entry bad: empty list', 'https://app.talyn.dev', []],
    ['scheme starting with a digit dropped', '1app://,ok://', ['ok://']],
    ['scheme with + . - kept', 'my.app+x-y://', ['my.app+x-y://']],
  ])('%s', (_label, env, expected) => {
    if (env !== undefined) process.env.MOBILE_RETURN_SCHEMES = env;
    expect(mobileReturnSchemes()).toEqual(expected);
  });

  it('an override REPLACES the defaults', () => {
    process.env.MOBILE_RETURN_SCHEMES = 'myapp://';
    expect(validMobileReturn('myapp://')).toBe('myapp://');
    expect(validMobileReturn('talyn-mobile://')).toBeNull();
  });

  it('an empty resulting list refuses everything', () => {
    process.env.MOBILE_RETURN_SCHEMES = 'https://';
    for (const s of DEFAULT_MOBILE_RETURN_SCHEMES) expect(validMobileReturn(s)).toBeNull();
  });

  it('warns about a dropped entry', () => {
    process.env.MOBILE_RETURN_SCHEMES = 'https://evil';
    mobileReturnSchemes();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('https://evil'));
  });
});

describe('parseReturnTo', () => {
  it.each<[string, unknown, ReturnType<typeof parseReturnTo>]>([
    ['absent', undefined, { ok: true, returnTo: null }],
    ['null', null, { ok: true, returnTo: null }],
    ['valid', 'talyn-mobile://', { ok: true, returnTo: 'talyn-mobile://' }],
    ['empty string', '', { ok: false }],
    ['invalid', 'https://evil.example.com', { ok: false }],
    ['wrong type', 1, { ok: false }],
  ])('%s', (_label, value, expected) => {
    expect(parseReturnTo(value)).toEqual(expected);
  });
});

describe('app return URLs', () => {
  it.each<[Parameters<typeof mobileGitHubReturnUrl>[1], string]>([
    [{ ok: true }, 'talyn-mobile://github/callback?github=connected'],
    [{ ok: false, reason: 'access_denied' }, 'talyn-mobile://github/callback?github=error&reason=access_denied'],
    [{ ok: false, reason: 'invalid_state' }, 'talyn-mobile://github/callback?github=error&reason=invalid_state'],
    [{ ok: false, reason: 'connect_failed' }, 'talyn-mobile://github/callback?github=error&reason=connect_failed'],
  ])('GitHub %o', (outcome, expected) => {
    expect(mobileGitHubReturnUrl('talyn-mobile://', outcome)).toBe(expected);
  });

  it.each([
    ['checkout', 'success'],
    ['checkout', 'cancel'],
    ['credits', 'success'],
    ['credits', 'cancel'],
    ['portal', 'success'],
  ] as const)('billing %s/%s', (kind, result) => {
    expect(mobileBillingReturnUrl('talyn-mobile-preview://', kind, result)).toBe(
      `talyn-mobile-preview://billing/return?kind=${kind}&result=${result}`
    );
  });
});

describe('publicApiOrigin', () => {
  it.each<[string, Partial<Record<(typeof ENV_KEYS)[number], string>>, string | null]>([
    ['nothing set', {}, null],
    ['explicit https', { TALYN_PUBLIC_API_URL: 'https://prod.talyn.dev' }, 'https://prod.talyn.dev'],
    ['explicit with a path: origin only', { TALYN_PUBLIC_API_URL: 'https://prod.talyn.dev/x/' }, 'https://prod.talyn.dev'],
    ['explicit http on a public host refused', { TALYN_PUBLIC_API_URL: 'http://prod.talyn.dev' }, null],
    ['explicit http localhost allowed', { TALYN_PUBLIC_API_URL: 'http://localhost:4747' }, 'http://localhost:4747'],
    ['explicit with userinfo refused', { TALYN_PUBLIC_API_URL: 'https://u:p@prod.talyn.dev' }, null],
    ['explicit garbage', { TALYN_PUBLIC_API_URL: 'not a url' }, null],
    [
      'explicit wins over a callback',
      { TALYN_PUBLIC_API_URL: 'https://a.talyn.dev', POSTHOG_OAUTH_REDIRECT_URI: 'https://b.talyn.dev/api/v1/posthog/cb' },
      'https://a.talyn.dev',
    ],
    ['PostHog callback origin', { POSTHOG_OAUTH_REDIRECT_URI: 'https://b.talyn.dev/api/v1/posthog/cb' }, 'https://b.talyn.dev'],
    ['Slack callback origin', { SLACK_OAUTH_REDIRECT_URI: 'https://c.talyn.dev/api/v1/slack/cb' }, 'https://c.talyn.dev'],
    ['callback outside /api/v1 ignored', { POSTHOG_OAUTH_REDIRECT_URI: 'https://b.talyn.dev/cb' }, null],
    [
      'bad PostHog callback falls through to Slack',
      { POSTHOG_OAUTH_REDIRECT_URI: 'https://b.talyn.dev/cb', SLACK_OAUTH_REDIRECT_URI: 'https://c.talyn.dev/api/v1/slack/cb' },
      'https://c.talyn.dev',
    ],
  ])('%s', (_label, env, expected) => {
    Object.assign(process.env, env);
    expect(publicApiOrigin()).toBe(expected);
  });
});

describe('mobileBillingBounceUrl', () => {
  it('null without a public origin', () => {
    expect(mobileBillingBounceUrl('talyn-mobile://', 'checkout', 'success')).toBeNull();
  });

  it('points at the bounce route with to/kind/result', () => {
    process.env.TALYN_PUBLIC_API_URL = 'https://prod.talyn.dev';
    const url = new URL(mobileBillingBounceUrl('talyn-mobile://', 'credits', 'cancel')!);
    expect(url.origin).toBe('https://prod.talyn.dev');
    expect(url.pathname).toBe('/api/v1/billing/mobile-return');
    expect(Object.fromEntries(url.searchParams)).toEqual({ to: 'talyn-mobile://', kind: 'credits', result: 'cancel' });
  });
});
