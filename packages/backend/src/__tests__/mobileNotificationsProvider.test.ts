import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpoPushProvider, genericPushText, mobileProviderAvailable } from '../services/mobileNotifications/provider.js';
import { defaultMobileNotificationPreferences } from '@talyn/shared';
import { inMobileQuietHours, retryDelayMs } from '../services/mobileNotifications/worker.js';
const event = { schemaVersion: 1 as const, eventId: '00000000-0000-4000-8000-000000000001', category: 'session_update' as const,
  destination: { kind: 'session' as const, workspaceId: '00000000-0000-4000-8000-000000000002', entityId: '00000000-0000-4000-8000-000000000003' } };
const message = { token: 'ExpoPushToken[synthetic_fixture_only]', data: event };
const ticketId = '00000000-0000-4000-8000-000000000004';
function provider(response: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response), { status }));
  return { fetcher, subject: new ExpoPushProvider(fetcher) };
}
afterEach(() => vi.unstubAllEnvs());
describe('Expo provider', () => {
  it('sends the composed title and body with the explicit safe payload', async () => {
    const { fetcher, subject } = provider({ data: [{ status: 'ok', id: ticketId }] });
    expect(await subject.send([{ ...message, title: 'Done: Fix login', body: 'Opened PR #42' }])).toEqual([{ status: 'ok', ticketId }]);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual([{ to: message.token, title: 'Done: Fix login',
      body: 'Opened PR #42', data: event, channelId: 'session_update', sound: 'default', ttl: 3600 }]);
    expect(fetcher.mock.calls[0][1]!.headers).not.toHaveProperty('Authorization');
  });
  it.each([
    ['session_update', 'Session update', 'A session needs your attention.'],
    ['human_gate', 'Needs your input', 'Something in Talyn is waiting for you.'],
    ['pr_review', 'Pull request review', 'A pull request review changed.'],
    ['ci_failure', 'Checks failed', 'Required checks failed on a pull request.'],
    ['merge_ready', 'Ready to merge', 'A pull request is ready to merge.'],
  ] as const)('falls back to the generic %s text when the message has none', async (category, title, body) => {
    const { fetcher, subject } = provider({ data: [{ status: 'ok', id: ticketId }] });
    await subject.send([{ token: message.token, data: { ...event, category } }]);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)[0]).toMatchObject({ title, body, channelId: category });
    expect(genericPushText(category)).toEqual({ title, body });
  });
  it.each([['empty', '', ''], ['blank', '  ', ' \n ']])('falls back for %s text', async (_name, title, body) => {
    const { fetcher, subject } = provider({ data: [{ status: 'ok', id: ticketId }] });
    await subject.send([{ ...message, title, body }]);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)[0]).toMatchObject({ title: 'Session update', body: 'A session needs your attention.' });
  });
  it('bounds delivery TTL to the remaining event lifetime', async () => {
    const { fetcher, subject } = provider({ data: [{ status: 'ok', id: ticketId }] });
    await subject.send([{ ...message, ttlSeconds: 30 }]);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)[0].ttl).toBe(30);
  });
  it('preserves accepted tickets in a partial response', async () => {
    expect(await provider({ data: [{ status: 'ok', id: ticketId }] }).subject.send([message, message]))
      .toEqual([{ status: 'ok', ticketId }, { status: 'error', errorClass: 'temporary' }]);
  });
  it.each([['DeviceNotRegistered', 'device_not_registered'], ['MessageRateExceeded', 'temporary'],
    ['MessageTooBig', 'permanent'], ['InvalidCredentials', 'permanent'], ['unexpected', 'permanent']])('classifies %s', async (error, errorClass) => {
    expect(await provider({ data: [{ status: 'error', details: { error } }] }).subject.send([message])).toEqual([{ status: 'error', errorClass }]);
  });
  it.each([429, 500, 503])('retries HTTP %i', async (status) => {
    await expect(provider({}, status).subject.send([message])).rejects.toMatchObject({ errorClass: 'temporary' });
  });
  it('rejects malformed responses', async () => {
    await expect(provider({ private: 'never expose' }).subject.send([message])).rejects.toMatchObject({ errorClass: 'temporary' });
    expect(await provider({ data: [{ status: 'ok', id: 'invalid' }] }).subject.send([message])).toEqual([{ status: 'error', errorClass: 'temporary' }]);
  });
  it('bounds request batches', async () => {
    const { fetcher, subject } = provider({});
    await expect(subject.send(Array(101).fill(message))).rejects.toMatchObject({ errorClass: 'permanent' });
    await expect(subject.receipts(Array(1001).fill(ticketId))).rejects.toMatchObject({ errorClass: 'permanent' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('aborts timed out requests', async () => {
    const fetcher = vi.fn<typeof fetch>((_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    await expect(new ExpoPushProvider(fetcher, 1).send([message])).rejects.toMatchObject({ errorClass: 'temporary' });
  });
  it('polls receipts separately and preserves missing results', async () => {
    const { subject } = provider({ data: { [ticketId]: { status: 'error', details: { error: 'DeviceNotRegistered' } } } });
    expect(await subject.receipts([ticketId, event.eventId])).toEqual([{ ticketId, status: 'error', errorClass: 'device_not_registered' }]);
    await expect(provider({ data: { [ticketId]: { status: 'bad' } } }).subject.receipts([ticketId])).rejects.toMatchObject({ errorClass: 'temporary' });
  });
  it('keeps an optional Expo credential on the server request', async () => {
    vi.stubEnv('EXPO_ACCESS_TOKEN', 'synthetic-credential');
    const { fetcher, subject } = provider({ data: [{ status: 'ok', id: ticketId }] });
    await subject.send([message]);
    expect(fetcher.mock.calls[0][1]!.headers).toHaveProperty('Authorization', 'Bearer synthetic-credential');
    expect(fetcher.mock.calls[0][1]!.body).not.toContain('synthetic-credential');
  });
  it('bounds streamed responses and rejects malformed JSON', async () => {
    const malformed = vi.fn<typeof fetch>(async () => new Response('{bad'));
    await expect(new ExpoPushProvider(malformed).send([message])).rejects.toMatchObject({ errorClass: 'temporary' });
    const oversized = vi.fn<typeof fetch>(async () => new Response('x'.repeat(1_000_001)));
    await expect(new ExpoPushProvider(oversized).send([message])).rejects.toMatchObject({ errorClass: 'temporary' });
  });
  it('disables absent provider configuration', () => {
    vi.stubEnv('TALYN_MOBILE_PUSH_ENABLED', 'false'); expect(mobileProviderAvailable()).toBe(false);
  });
});
describe('quiet hours and retry policy', () => {
  it.each([['UTC', '2026-11-08T21:59:00Z', false], ['UTC', '2026-11-08T22:00:00Z', true],
    ['UTC', '2026-11-09T07:59:00Z', true], ['UTC', '2026-11-09T08:00:00Z', false],
    ['America/New_York', '2026-11-01T05:30:00Z', true], ['America/New_York', '2026-11-01T06:30:00Z', true],
    ['Asia/Kathmandu', '2026-11-08T16:15:00Z', true]])('uses timezone %s at %s', (timezone, at, expected) => {
    const preference = defaultMobileNotificationPreferences(event.destination.workspaceId);
    preference.timezone = timezone; preference.quietHours.enabled = true;
    expect(inMobileQuietHours(preference, new Date(at))).toBe(expected);
  });
  it.each([[1, 30_000], [2, 60_000], [3, 120_000], [20, 3_600_000]])('backs off attempt %i', (attempt, expected) => {
    expect(retryDelayMs(attempt)).toBe(expected);
  });
});
