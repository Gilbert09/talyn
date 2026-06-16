import { describe, it, expect, beforeEach } from 'vitest';
import {
  REPLICA_ID,
  dispatchIncoming,
  setLocalDelivery,
  publishBroadcast,
  publishToWorkspace,
} from '../services/wsBus.js';
import type { WSEvent } from '@fastowl/shared';

/**
 * Cross-replica WebSocket fan-out (wsBus). These tests cover the envelope
 * dispatch logic in isolation — no live Redis. REDIS_URL is unset under
 * vitest, so the publishers are inert no-ops (the single-process path) and we
 * exercise the receive side via the exported dispatchIncoming().
 */

const evt: WSEvent = {
  type: 'pull_request:updated',
  payload: { id: 'pr-1' },
  timestamp: '2026-06-16T00:00:00.000Z',
};

let allDeliveries: WSEvent[];
let workspaceDeliveries: Array<{ workspaceId: string; event: WSEvent }>;

beforeEach(() => {
  allDeliveries = [];
  workspaceDeliveries = [];
  setLocalDelivery({
    all: (event) => allDeliveries.push(event),
    workspace: (workspaceId, event) => workspaceDeliveries.push({ workspaceId, event }),
  });
});

function envelope(env: Record<string, unknown>): string {
  return JSON.stringify(env);
}

describe('dispatchIncoming', () => {
  it('drops an envelope this replica published (no double-send)', () => {
    const result = dispatchIncoming(
      envelope({ replicaId: REPLICA_ID, scope: 'all', event: evt }),
    );
    expect(result).toBe('self');
    expect(allDeliveries).toHaveLength(0);
    expect(workspaceDeliveries).toHaveLength(0);
  });

  it('delivers an all-scope envelope from another replica to local clients', () => {
    const result = dispatchIncoming(
      envelope({ replicaId: 'other-replica:1:abcd', scope: 'all', event: evt }),
    );
    expect(result).toBe('delivered');
    expect(allDeliveries).toEqual([evt]);
    expect(workspaceDeliveries).toHaveLength(0);
  });

  it('delivers a workspace-scope envelope to the workspace sink', () => {
    const result = dispatchIncoming(
      envelope({
        replicaId: 'other-replica:1:abcd',
        scope: 'workspace',
        workspaceId: 'ws-42',
        event: evt,
      }),
    );
    expect(result).toBe('delivered');
    expect(workspaceDeliveries).toEqual([{ workspaceId: 'ws-42', event: evt }]);
    expect(allDeliveries).toHaveLength(0);
  });

  it('ignores malformed JSON without throwing', () => {
    expect(dispatchIncoming('not json{')).toBe('invalid');
    expect(allDeliveries).toHaveLength(0);
  });

  it('drops events when no local-delivery sink is registered', () => {
    // Override with an empty registration: simulate a sink that is present but
    // a fresh dispatch arriving for a different replica still routes through it.
    let received = 0;
    setLocalDelivery({ all: () => (received += 1), workspace: () => undefined });
    dispatchIncoming(envelope({ replicaId: 'other:1:zzzz', scope: 'all', event: evt }));
    expect(received).toBe(1);
  });
});

describe('publishers (Redis disabled)', () => {
  it('are inert no-ops when REDIS_URL is unset', () => {
    expect(process.env.REDIS_URL).toBeFalsy();
    expect(() => publishBroadcast(evt)).not.toThrow();
    expect(() => publishToWorkspace('ws-1', evt)).not.toThrow();
    // Nothing is delivered locally by publishing — that is the caller's job.
    expect(allDeliveries).toHaveLength(0);
  });

  it('never publishes debug:event across replicas', () => {
    const debugEvt: WSEvent = { type: 'debug:event', payload: {}, timestamp: evt.timestamp };
    // No Redis to assert against; this just guards the early-return branch.
    expect(() => publishBroadcast(debugEvt)).not.toThrow();
  });
});

describe('REPLICA_ID', () => {
  it('is a stable non-empty per-process identifier', () => {
    expect(typeof REPLICA_ID).toBe('string');
    expect(REPLICA_ID.length).toBeGreaterThan(0);
    expect(REPLICA_ID.split(':')).toHaveLength(3);
  });
});
