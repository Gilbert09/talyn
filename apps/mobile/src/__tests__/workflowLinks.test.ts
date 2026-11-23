import { redirectSystemPath } from '../../app/+native-intent';
import { clearIntent, completeIntent, consumeIntent, peekIntent, productPath, rememberIntent } from '../navigation/intents';

afterEach(clearIntent);
describe('product deep links in memory', () => {
  it.each([
    ['/sessions/session-one', '/sessions/session-one'],
    ['talyn-mobile-development://threads/thread-one', '/threads/thread-one'],
    ['https://mobile.example.test/attention/pr-one', '/attention/pr-one'],
  ])('normalizes %s without retaining query data', (url, expected) => {
    expect(productPath(`${url}?ignored=private`)).toBe(expected);
    expect(redirectSystemPath({ path: url, initial: true })).toBe(expected);
  });
  it.each(['/sessions', '/sessions/id/extra', '/sessions/a%2fb', '/threads/a%5cb', '/settings/admin', 'not a link'])('rejects unsupported product path %s', (path) => {
    expect(productPath(path)).toBeNull();
  });
  it.each([
    ['talyn-mobile-development://pulls?tab=mine', '/pulls?tab=mine'],
    ['talyn-mobile://pulls?tab=reviews', '/pulls?tab=reviews'],
    ['talyn-mobile://pulls?tab=queue&secret=x', '/pulls?tab=queue'],
    ['talyn-mobile://pulls?tab=admin', '/pulls'],
    ['talyn-mobile://pulls', '/pulls'],
    ['/pulls?tab=mine', '/pulls?tab=mine'],
    ['talyn-mobile://settings', '/settings'],
    ['talyn-mobile://settings?token=private', '/settings'],
    ['talyn-mobile://billing', '/billing'],
    ['talyn-mobile://automations', '/integrations/github'],
    ['talyn-mobile://automations/workflows', '/integrations/github'],
    ['talyn-mobile://automations/loops', '/integrations/schedule'],
    ['talyn-mobile://automations/loops/rule-one', '/integrations/schedule/rule-one'],
    ['talyn-mobile://automations/workflows/rule-two', '/integrations/github/rule-two'],
    ['talyn-mobile://automations/rule-three?kind=loop', '/integrations/schedule/rule-three'],
    ['talyn-mobile://', '/'],
    ['talyn-mobile-development://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082', '/'],
  ])('routes the custom-scheme link %s to %s', (url, expected) => {
    expect(redirectSystemPath({ path: url, initial: true })).toBe(expected);
  });
  it('retains one cold intent across authentication and workspace selection', () => {
    rememberIntent('/sessions/session-one'); expect(peekIntent()).toBe('/sessions/session-one');
    expect(consumeIntent()).toBe('/sessions/session-one'); expect(consumeIntent()).toBeNull();
  });
  it('replaces a pending warm intent and clears it at an account boundary', () => {
    rememberIntent('/threads/thread-one'); rememberIntent('/attention/pr-one');
    expect(peekIntent()).toBe('/attention/pr-one'); clearIntent(); expect(consumeIntent()).toBeNull();
  });
  it('clears a warm destination only after its authorized detail opens', () => {
    rememberIntent('/sessions/session-one'); completeIntent('/threads/thread-one');
    expect(peekIntent()).toBe('/sessions/session-one'); completeIntent('/sessions/session-one'); expect(peekIntent()).toBeNull();
  });
  it('does not store authentication parameters as a product intent', () => {
    redirectSystemPath({ path: 'talyn-mobile-development://auth/callback?code=test-code', initial: false });
    expect(peekIntent()).toBeNull();
  });
});
