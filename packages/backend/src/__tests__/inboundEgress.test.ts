import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebhookEventFacts } from '@talyn/shared';
import { createTestDb } from './helpers/testDb.js';
import { listDeliveriesQuery, webhookConnectionQuery } from '../services/inbound/store.js';
import { storedFacts } from '../services/workflows/runs.js';

/**
 * Egress guards for the inbound tables: the list reads never ship a body,
 * the kept headers or a secret, and a run row never stores a webhook body.
 */

describe('inbound egress', () => {
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ cleanup } = await createTestDb());
  });

  afterEach(async () => {
    await cleanup();
  });

  it.each([
    ['the first page', { limit: 50 }],
    ['a later page', { limit: 50, cursor: '2026-11-12T10:00:00.000Z' }],
  ])('the deliveries list never selects payload or headers (%s)', (_name, opts) => {
    const sql = listDeliveriesQuery('c1', opts).toSQL().sql;
    expect(sql).toContain('"delivery_id"');
    expect(sql).not.toContain('"payload"');
    expect(sql).not.toContain('"headers"');
  });

  it('the connection summary never selects a secret', () => {
    const sql = webhookConnectionQuery('r1').toSQL().sql;
    expect(sql).not.toContain('token_hash');
    expect(sql).not.toContain('secret_enc');
    expect(sql).not.toContain('credential_enc');
  });

  it('a run stores a webhook without its body or headers', () => {
    const facts: WebhookEventFacts = {
      integration: 'webhook',
      event: 'webhook_received',
      ruleId: 'r',
      connectionId: 'c',
      deliveryRowId: 'row',
      deliveryId: 'd',
      receivedAt: '2026-11-12T10:00:00.000Z',
      payload: { big: 'x'.repeat(10_000) },
      headers: { 'user-agent': 'x' },
    };
    expect(storedFacts(facts)).toEqual({ ...facts, payload: null, headers: {} });
  });
});
