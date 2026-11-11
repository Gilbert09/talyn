import { ipcErrorMessage } from '../renderer/lib/ipcError';
import { describeTokenRefusal } from '../main/codexAuth';

describe('ipcErrorMessage', () => {
  it.each([
    ["Error invoking remote method 'codex:sign-in': Error: Plain text", 'Plain text'],
    ['Error invoking method "codex-sign-in": Error: Plain text', 'Plain text'],
    ["Error invoking remote method 'x': TypeError: Bad thing", 'Bad thing'],
    ['No prefix here', 'No prefix here'],
    ['Error: only a name prefix', 'only a name prefix'],
  ])('strips the IPC prefix from %s', (raw, expected) => {
    expect(ipcErrorMessage(new Error(raw), 'fallback')).toBe(expected);
  });

  it.each([[undefined], ['text'], [new Error('')]])('falls back for %p', (value) => {
    expect(ipcErrorMessage(value, 'fallback')).toBe('fallback');
  });
});

describe('describeTokenRefusal', () => {
  const region = 'OpenAI does not offer ChatGPT sign-in in your region. Connect Claude instead.';
  it.each([
    [403, '{ "error": { "code": "unsupported_country_region_territory" } }', region],
    [403, '{ "error": "unsupported_country_region_territory" }', region],
    [403, '{ "error": { "code": "other" } }', 'OpenAI refused the sign-in (403): { "error": { "code": "other" } }'],
    [
      400,
      '{ "error": { "code": "unsupported_country_region_territory" } }',
      'OpenAI refused the sign-in (400): { "error": { "code": "unsupported_country_region_territory" } }',
    ],
    [500, 'not json', 'OpenAI refused the sign-in (500): not json'],
  ])('maps status %s body %s', (status, body, expected) => {
    expect(describeTokenRefusal(status, body)).toBe(expected);
  });
});
