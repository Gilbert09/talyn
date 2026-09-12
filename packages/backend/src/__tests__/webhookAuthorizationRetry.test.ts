import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { WebhookWorker, WEBHOOK_STREAM, WEBHOOK_AUTH_DEAD_LETTERS } from '../services/webhookWorker.js';
import { GitHubAuthorizationUnavailableError } from '../services/github.js';
import { targetsForRepo } from '../services/webhookIndex.js';
import { evaluateWorkflowsForDelivery } from '../services/workflows/engine.js';
import type { WebhookDelivery } from '../services/webhookPayload.js';

vi.mock('../services/webhookIndex.js', () => ({ targetsForRepo: vi.fn(), refreshWebhookIndex: vi.fn() }));
vi.mock('../services/workflows/engine.js', () => ({ evaluateWorkflowsForDelivery: vi.fn() }));

const delivery: WebhookDelivery = {
  deliveryId: 'original-delivery', repoFullName: 'private/repo', eventType: 'check_suite',
  action: 'completed', payload: { check_suite: { pull_requests: [] } }, enqueuedAtMs: 1,
};

function worker(conn: object) {
  const instance = new WebhookWorker() as unknown as {
    conn: Redis;
    running: boolean;
    loop(): Promise<void>;
    handleEntry(id: string, data: WebhookDelivery, lane: 'slow'): Promise<void>;
  };
  instance.conn = conn as Redis;
  return instance;
}

describe('webhook authorization retries', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(targetsForRepo).mockRejectedValue(new GitHubAuthorizationUnavailableError());
    vi.mocked(evaluateWorkflowsForDelivery).mockResolvedValue(0);
  });

  function redis(attempts = 1) {
    return {
      xpending: vi.fn().mockResolvedValue([['1-0', 'old-replica', 300_000, attempts]]),
      xack: vi.fn().mockResolvedValue(1),
      xadd: vi.fn().mockResolvedValue('dead-letter-id'),
    };
  }

  it('does not acknowledge or invoke workflows when authorization is unverifiable', async () => {
    const conn = redis();
    await worker(conn).handleEntry('1-0', delivery, 'slow');
    expect(conn.xack).not.toHaveBeenCalled();
    expect(conn.xadd).not.toHaveBeenCalled();
    expect(evaluateWorkflowsForDelivery).not.toHaveBeenCalled();
  });

  it('a new worker reclaims the pending delivery and invokes workflows after recovery', async () => {
    const conn = redis();
    await worker(conn).handleEntry('1-0', delivery, 'slow');
    const targets = [{ workspaceId: 'allowed', repositoryId: 'repo-id', owner: 'private', repo: 'repo' }];
    vi.mocked(targetsForRepo).mockResolvedValue(targets);
    const recoveredConn = {
      ...conn,
      xautoclaim: vi.fn().mockResolvedValueOnce(['0-0', [['1-0', ['data', JSON.stringify(delivery)]]]])
        .mockResolvedValue(['0-0', []]),
      xreadgroup: vi.fn(async () => { recovered.running = false; return null; }),
    };
    const recovered = worker(recoveredConn);
    recovered.running = true;
    await recovered.loop();
    await vi.waitFor(() => expect(conn.xack).toHaveBeenCalledWith(WEBHOOK_STREAM, 'fastowl', '1-0'));
    expect(recoveredConn.xautoclaim).toHaveBeenCalledWith(WEBHOOK_STREAM, 'fastowl', expect.any(String), 300_000, '0-0', 'COUNT', 32);
    expect(evaluateWorkflowsForDelivery).toHaveBeenCalledTimes(1);
    expect(evaluateWorkflowsForDelivery).toHaveBeenCalledWith(delivery, targets);
  });

  it('acknowledges a definitive denial without invoking workflows', async () => {
    vi.mocked(targetsForRepo).mockResolvedValue([]);
    const conn = redis();
    await worker(conn).handleEntry('1-0', delivery, 'slow');
    expect(conn.xack).toHaveBeenCalled();
    expect(evaluateWorkflowsForDelivery).not.toHaveBeenCalled();
  });

  it('retains exhausted triggers in a dead-letter stream before acknowledging', async () => {
    const conn = redis(16);
    await worker(conn).handleEntry('1-0', delivery, 'slow');
    expect(conn.xadd).toHaveBeenCalledWith(WEBHOOK_AUTH_DEAD_LETTERS, '*', 'data', JSON.stringify(delivery),
      'reason', 'authorization_unavailable', 'attempts', '16');
    expect(conn.xadd.mock.invocationCallOrder[0]).toBeLessThan(conn.xack.mock.invocationCallOrder[0]);
  });

  it('does not acknowledge when retaining the exhausted trigger fails', async () => {
    const conn = redis(16);
    conn.xadd.mockRejectedValue(new Error('redis unavailable'));
    await worker(conn).handleEntry('1-0', delivery, 'slow');
    expect(conn.xack).not.toHaveBeenCalled();
  });
});
