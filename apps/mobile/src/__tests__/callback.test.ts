import { callbackCode } from '../auth/callback';
import { redirectSystemPath } from '../../app/+native-intent';

const callback = 'talyn-mobile-development://auth/callback';

describe('callback validation', () => {
  it.each([
    [callback, `${callback}?code=abc-123`, 'abc-123'],
    [callback, `${callback}?code=abc&state=library-state`, 'abc'],
    ['https://mobile.example.com/callback', 'https://mobile.example.com/callback?code=abc', 'abc'],
  ])('accepts the exact configured target %s', (expected, url, code) => {
    expect(callbackCode(url, expected)).toBe(code);
  });
  it.each([
    'other://auth/callback?code=secret',
    'talyn-mobile-development://other/callback?code=secret',
    'talyn-mobile-development://auth/other?code=secret',
    'talyn-mobile-development://auth/callback/?code=secret',
    'talyn-mobile-development://user@auth/callback?code=secret',
    'talyn-mobile-development://auth:443/callback?code=secret',
    `${callback}?code=one&code=secret`, `${callback}?code=secret&state=a&state=b`,
    `${callback}?access_token=secret`, `${callback}#code=secret`, `${callback}?code=secret#`,
    `${callback}?code=`, `${callback}?code=%`, `${callback}?code=%0Asecret`,
    `${callback}?code=secret&redirect_to=https://evil.test`, `${callback}?error=access_denied&error_description=secret`,
    `${callback}?error_code=otp_expired&code=secret`, 'not a url',
    'https://mobile.example.com/callback?code=secret',
  ])('rejects malformed or unexpected links without diagnostic data: %s', (url) => {
    expect(() => callbackCode(url, callback)).toThrow();
    try { callbackCode(url, callback); } catch (error) { expect(String(error)).not.toContain('secret'); }
  });
  it.each([
    `${callback}?code=secret`, 'https://wrong.example/callback?code=secret',
    '/auth/callback?code=secret', '/settings?access_token=secret',
  ])('strips callback parameters before navigation: %s', (path) => {
    expect(redirectSystemPath({ path, initial: true })).toBe('/auth/callback');
  });
  it('strips query and fragment data from other routes', () => {
    expect(redirectSystemPath({ path: '/sessions/example?secret=value#secret', initial: false })).toBe('/sessions/example');
  });
});
