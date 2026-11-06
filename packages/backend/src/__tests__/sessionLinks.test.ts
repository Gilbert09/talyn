import { describe, expect, it } from 'vitest';
import { sessionAppUrl, sessionIdFromAppUrl } from '@talyn/shared';

describe('session app links', () => {
  it('round-trips a session id', () => {
    const url = sessionAppUrl('session with spaces');
    expect(url).toBe('fastowl://session/session%20with%20spaces');
    expect(sessionIdFromAppUrl(url)).toBe('session with spaces');
  });

  it.each([
    'https://app.talyn.dev/s/session-1',
    'fastowl://auth-callback?code=secret',
    'fastowl://session/',
    'fastowl://session/one/two',
    'not a url',
  ])('rejects %s', (url) => {
    expect(sessionIdFromAppUrl(url)).toBeNull();
  });

  it('accepts the development app scheme', () => {
    expect(sessionIdFromAppUrl('fastowl-dev://session/session-1')).toBe('session-1');
  });
});
