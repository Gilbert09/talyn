import { describe, expect, it } from 'vitest';
import { Webhook } from 'standardwebhooks';
import { eventIdFor } from '../services/apiWebhooks/events.js';
import { generateWebhookSecret, newEventId, signWebhook, webhookHeaders } from '../services/apiWebhooks/signing.js';

/**
 * Standard Webhooks signing. The spec's own vector pins the scheme; the
 * `standardwebhooks` package (a dependency of the Polar SDK) verifies what we
 * send, which is what a receiver will run.
 */

const SPEC = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};

describe('webhook signing', () => {
  it('matches the Standard Webhooks spec vector', () => {
    expect(signWebhook(SPEC.secret, SPEC.id, SPEC.timestamp, SPEC.body)).toBe(SPEC.signature);
  });

  it('accepts a secret without the whsec_ prefix', () => {
    expect(signWebhook(SPEC.secret.slice('whsec_'.length), SPEC.id, SPEC.timestamp, SPEC.body)).toBe(SPEC.signature);
  });

  it.each([
    ['a different body', { body: '{"test": 2432232315}' }],
    ['a different id', { id: 'msg_other' }],
    ['a different timestamp', { timestamp: SPEC.timestamp + 1 }],
    ['a different secret', { secret: 'whsec_' + Buffer.from('x'.repeat(32)).toString('base64') }],
  ])('gives another signature for %s', (_name, change) => {
    const v = { ...SPEC, ...change };
    expect(signWebhook(v.secret, v.id, v.timestamp, v.body)).not.toBe(SPEC.signature);
  });

  it('makes headers that the standardwebhooks library verifies', () => {
    const secret = generateWebhookSecret();
    const body = JSON.stringify({ id: 'evt_1', type: 'ping', data: { object: {} } });
    const headers = webhookHeaders([secret], 'evt_1', body);
    expect(new Webhook(secret).verify(body, headers)).toEqual(JSON.parse(body));
  });

  it('signs with every secret during a rotation, and either one verifies', () => {
    const current = generateWebhookSecret();
    const previous = generateWebhookSecret();
    const body = '{"a":1}';
    const headers = webhookHeaders([current, previous], 'evt_2', body);
    expect(headers['webhook-signature'].split(' ')).toHaveLength(2);
    expect(new Webhook(current).verify(body, headers)).toEqual({ a: 1 });
    expect(new Webhook(previous).verify(body, headers)).toEqual({ a: 1 });
    expect(() => new Webhook(generateWebhookSecret()).verify(body, headers)).toThrow();
  });

  it('refuses a body changed after signing', () => {
    const secret = generateWebhookSecret();
    const headers = webhookHeaders([secret], 'evt_3', '{"a":1}');
    expect(() => new Webhook(secret).verify('{"a":2}', headers)).toThrow();
  });

  it('stamps the timestamp in seconds', () => {
    const headers = webhookHeaders([SPEC.secret], 'evt_4', '{}', new Date(1_700_000_000_123));
    expect(headers['webhook-timestamp']).toBe('1700000000');
    expect(headers['webhook-id']).toBe('evt_4');
  });

  it('makes 32-byte secrets with the whsec_ prefix, each one new', () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(a.slice(6), 'base64')).toHaveLength(32);
    expect(generateWebhookSecret()).not.toBe(a);
  });

  it('makes event ids: random without a key, stable with one', () => {
    expect(newEventId()).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(eventIdFor()).not.toBe(eventIdFor());
    expect(eventIdFor('chat.turn_started:c1:3')).toBe(eventIdFor('chat.turn_started:c1:3'));
    expect(eventIdFor('chat.turn_started:c1:3')).not.toBe(eventIdFor('chat.turn_started:c1:4'));
    expect(eventIdFor('k')).toMatch(/^evt_[0-9a-f]{32}$/);
  });
});
