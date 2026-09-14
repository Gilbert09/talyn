import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeHost } from '../services/posthogCode/hostPolicy.js';

afterEach(() => vi.unstubAllEnvs());

describe('PostHog origins', () => {
  it.each(['https://us.posthog.com', 'https://eu.posthog.com'])('accepts cloud origin %s', (host) => {
    vi.stubEnv('POSTHOG_ALLOWED_ORIGINS', '');
    expect(normalizeHost(host)).toBe(host);
    expect(normalizeHost(`${host}/`)).toBe(host);
  });

  it.each([undefined, null, ''])('uses the default for %s', (host) => {
    vi.stubEnv('POSTHOG_ALLOWED_ORIGINS', '');
    expect(normalizeHost(host)).toBe('https://us.posthog.com');
  });

  it.each([
    'https://localhost', 'https://127.0.0.1', 'https://[::1]',
    'https://10.0.0.1', 'https://172.16.0.1', 'https://192.168.1.1',
    'https://169.254.169.254', 'https://[fe80::1]', 'https://[fd00::1]',
    'https://metadata.google.internal', 'https://posthog.example',
    'https://us.posthog.com.evil.example', 'https://evil-us.posthog.com',
    'https://us.i.posthog.com',
  ])('refuses an unapproved origin: %s', (host) => {
    vi.stubEnv('POSTHOG_ALLOWED_ORIGINS', '');
    expect(() => normalizeHost(host)).toThrow('not allowed');
  });

  // PostHog's legacy US cloud domain. A workspace connected before the regional
  // split still stores it, and it is PostHog's own host — not something an
  // operator should have to allowlist to keep a cloud user working.
  it.each(['https://app.posthog.com', 'https://app.posthog.com/'])(
    'accepts the legacy cloud origin without operator configuration: %s', (host) => {
      vi.stubEnv('POSTHOG_ALLOWED_ORIGINS', '');
      expect(normalizeHost(host)).toBe('https://app.posthog.com');
    });

  it.each([
    'http://us.posthog.com', 'file:///etc/passwd', 'ftp://localhost',
    '//us.posthog.com', 'https://us.posthog.com/path',
    'https://us.posthog.com/.', 'https://us.posthog.com//',
    'https://us.posthog.com?', 'https://us.posthog.com?x=1',
    'https://us.posthog.com#', 'https://us.posthog.com#suffix',
    'https://user:password@us.posthog.com', 'https://@us.posthog.com',
    'https://us.posthog.com\\@evil.example', 'https://us.posthog.com.',
    'https://%75s.posthog.com', 'https://US.posthog.com',
    'https://us.posthog.com:443', 'https://127.1', 'https://2130706433',
    'https://0x7f000001', 'https://0177.0.0.1', 'https://[0:0:0:0:0:0:0:1]',
    'https://us.posthog.com\n.evil.example', 'https://\uff55\uff53.posthog.com',
    {}, 123, ['https://us.posthog.com'],
  ])('refuses malformed or rewritten origins: %s', (host) => {
    vi.stubEnv('POSTHOG_ALLOWED_ORIGINS', 'https://127.0.0.1,https://[::1]');
    expect(() => normalizeHost(host)).toThrow('exact HTTPS origin');
  });

  it.each(['https://posthog.example:8443', 'https://127.0.0.1', 'https://[::1]', 'https://10.0.0.1']) (
    'permits an exact operator opt-in: %s', (host) => {
      vi.stubEnv('POSTHOG_ALLOWED_ORIGINS', ` https://other.example, ${host} `);
      expect(normalizeHost(host)).toBe(host);
      expect(() => normalizeHost('https://unlisted.example')).toThrow('not allowed');
    },
  );

  it.each(['*', 'https://*.example', 'http://127.0.0.1', 'https://example.com/path']) (
    'rejects invalid operator configuration: %s', (entry) => {
      vi.stubEnv('POSTHOG_ALLOWED_ORIGINS', entry);
      expect(() => normalizeHost(entry)).toThrow();
    },
  );
});
