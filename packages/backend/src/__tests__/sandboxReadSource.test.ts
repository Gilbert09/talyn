import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FleetClient, FleetSandbox } from '../services/selfHosted/client.js';
import { setWorkbenchFleetClientForTests } from '../services/workbenches/sandboxRuntime.js';
import { resetSandboxStatusCacheForTests } from '../services/workbenches/sandboxStatus.js';
import { chooseReadSource } from '../services/workbenches/sandboxReadSource.js';
import type { WorkbenchRow } from '../services/workbenches/store.js';

/**
 * Where a read of a session's work comes from. The fleet's record decides,
 * because Talyn never writes `suspended` into the row.
 */

const NOW = Date.parse('2099-01-01T12:00:00Z');

function row(overrides: Partial<WorkbenchRow> = {}): WorkbenchRow {
  return {
    id: 'wb1', workspaceId: 'ws', runtime: 'sandbox', kind: 'session', sandboxId: 'box', sandboxState: 'running',
    fleetHost: 'hetzner-64', status: 'ready', archivedAt: null,
    ...overrides,
  } as WorkbenchRow;
}

type Answer = { sandbox: Partial<FleetSandbox>; terminal?: boolean; retired?: boolean } | Error;

describe('chooseReadSource', () => {
  let answers: Answer[];
  let reads: number;

  beforeEach(() => {
    resetSandboxStatusCacheForTests();
    reads = 0;
    answers = [];
    setWorkbenchFleetClientForTests(async () => ({
      getSandbox: async (id: string) => {
        reads++;
        const next = answers.length > 1 ? answers.shift()! : answers[0];
        if (next instanceof Error) throw next;
        return { sandbox: { id, ...next.sandbox }, terminal: next.terminal ?? false, retired: next.retired ?? false };
      },
    }) as unknown as FleetClient);
  });

  afterEach(() => {
    setWorkbenchFleetClientForTests(null);
    resetSandboxStatusCacheForTests();
  });

  it.each([
    ['idle', { sandbox: { status: 'idle' } }, { live: true }],
    ['busy', { sandbox: { status: 'busy' } }, { live: true }],
    ['suspended', { sandbox: { status: 'suspended' } }, { live: false, reason: 'asleep' }],
    ['queued', { sandbox: { status: 'queued' } }, { live: false, reason: 'waking' }],
    ['starting', { sandbox: { status: 'starting' } }, { live: false, reason: 'waking' }],
    ['stopped', { sandbox: { status: 'stopped' } }, { live: false, reason: 'lost' }],
    ['failed', { sandbox: { status: 'failed' } }, { live: false, reason: 'lost' }],
    ['cancelled', { sandbox: { status: 'cancelled' } }, { live: false, reason: 'lost' }],
    ['terminal', { sandbox: { status: 'idle' }, terminal: true }, { live: false, reason: 'lost' }],
    ['retired', { sandbox: { status: 'idle' }, retired: true }, { live: false, reason: 'lost' }],
    ['an unknown status', { sandbox: { status: 'weird' as never } }, { live: false, reason: 'fleet_unreachable' }],
    ['a failed read', new Error('fleet down'), { live: false, reason: 'fleet_unreachable' }],
  ] as Array<[string, Answer, unknown]>)('maps a fleet record of %s', async (_name, answer, expected) => {
    answers = [answer];
    expect(await chooseReadSource(row(), NOW)).toEqual(expected);
  });

  it.each([
    ['archived', { archivedAt: new Date(NOW) }, { live: false, reason: 'archived' }],
    ['lost', { sandboxState: 'lost' }, { live: false, reason: 'lost' }],
    ['suspended in the row', { sandboxState: 'suspended' }, { live: false, reason: 'asleep' }],
    ['creating', { sandboxState: 'creating' }, { live: false, reason: 'starting' }],
    ['none', { sandboxState: 'none' }, { live: false, reason: 'starting' }],
    ['local', { runtime: 'local' }, { live: true }],
    ['moving', { status: 'moving' }, { live: true }],
    ['provisioning', { status: 'provisioning' }, { live: true }],
    ['ready with no box id', { sandboxId: null }, { live: true }],
  ] as Array<[string, Partial<WorkbenchRow>, unknown]>)('decides from the row alone when the session is %s', async (_name, overrides, expected) => {
    answers = [{ sandbox: { status: 'idle' } }];
    expect(await chooseReadSource(row(overrides), NOW)).toEqual(expected);
    expect(reads).toBe(0);
  });

  it('reads the fleet once for two quick reads', async () => {
    answers = [{ sandbox: { status: 'suspended' } }];
    await chooseReadSource(row(), NOW);
    await chooseReadSource(row(), NOW + 1000);
    expect(reads).toBe(1);
  });

  it('asks the fleet again when a cached idle record is past its idle time', async () => {
    const lastRequestAt = new Date(NOW - 5 * 60_000).toISOString();
    answers = [{ sandbox: { status: 'idle', lastRequestAt, idleTtlSec: 60 } }, { sandbox: { status: 'suspended' } }];
    expect(await chooseReadSource(row(), NOW)).toEqual({ live: false, reason: 'asleep' });
    expect(reads).toBe(2);
  });

  it.each([
    ['inside its idle time', { lastRequestAt: new Date(NOW - 30_000).toISOString(), idleTtlSec: 60 }],
    ['with no idle time', { lastRequestAt: new Date(NOW - 5 * 60_000).toISOString() }],
    ['with no last request', { idleTtlSec: 60 }],
  ])('trusts a cached idle record %s', async (_name, fields) => {
    answers = [{ sandbox: { status: 'idle', ...fields } }, { sandbox: { status: 'suspended' } }];
    expect(await chooseReadSource(row(), NOW)).toEqual({ live: true });
    expect(reads).toBe(1);
  });
});
