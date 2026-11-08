import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxStartInfo, WorkbenchCapacityWait } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, workbenchChats, workbenchEvents, workbenches, workbenchScriptRuns, workspaces } from '../db/schema.js';
import type { FleetClient, FleetSandbox } from '../services/selfHosted/client.js';
import { setWorkbenchFleetClientForTests } from '../services/workbenches/sandboxRuntime.js';
import {
  describeSandboxStatus,
  FLEET_READ_TTL_MS,
  getSandboxStatus,
  PROBLEM_NOTE_WINDOW,
  problemNoteQuery,
  resetSandboxStatusCacheForTests,
  STUCK_START_MS,
  statusChatsQuery,
  statusScriptsQuery,
  type FleetRead,
  type SandboxStatusInput,
  type StatusChat,
  type StatusScript,
} from '../services/workbenches/sandboxStatus.js';
import { getWorkbench, insertChat, insertWorkbench, type WorkbenchRow } from '../services/workbenches/store.js';
import {
  parseStartHistory,
  recordSandboxWake,
  startHistoryQuery,
  type StartHistoryEntry,
  type StoredBoxStart,
  type StoredWake,
} from '../services/workbenches/boxStart.js';

const { workbenchRoutes } = await import('../routes/workbenches.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');

const NOW = new Date('2099-01-01T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

function row(overrides: Partial<WorkbenchRow> = {}): WorkbenchRow {
  return {
    id: 'wb1', workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'o/r', kind: 'session', threadId: null,
    name: 'paris', title: null, branch: 'feat', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', model: null,
    deviceId: null, localPath: null, sandboxId: 'box', sandboxGeneration: null, sandboxState: 'running',
    memoryRestorePending: null, archivePendingAt: null, archiveRetryAt: null, restoreRequestedAt: null,
    archiveLeaseUntil: null, archiveFailures: 0, fleetHost: 'hetzner-64', status: 'ready', statusMessage: null,
    pullRequestId: null, pullRequestLinkedAt: null, pushedHeadShas: [], allocatedBranch: false, settings: {},
    source: null, diffStat: null, workCheckpointSha: null, workCheckpointAt: null, workCheckpointBytes: null,
    workCheckedAt: null, workUnpushedCommits: null, workSaveFailures: 0, workSaveFailedAt: null, workSaveError: null,
    archivedAt: null, createdAt: ago(3 * 60 * MIN), updatedAt: ago(MIN),
    ...overrides,
  } as WorkbenchRow;
}

const chat = (overrides: Partial<StatusChat> = {}): StatusChat => ({
  id: 'c1', title: 'Chat', status: 'idle', turnStartedAt: null, nextSeq: 10, closedAt: null, queued: 0, headWait: null, ...overrides,
});

const fleet = (sandbox: Partial<FleetSandbox>, extra: Partial<Extract<FleetRead, { ok: true }>> = {}): FleetRead =>
  ({ ok: true, sandbox: { id: 'box', status: 'idle', ...sandbox } as FleetSandbox, terminal: false, retired: false, ...extra });

function input(overrides: Partial<SandboxStatusInput> = {}): SandboxStatusInput {
  return { row: row(), fleet: fleet({}), chats: [chat()], scripts: [], note: null, resuming: false, now: NOW, ...overrides };
}

const wait = (reason: WorkbenchCapacityWait['reason']): WorkbenchCapacityWait =>
  ({ turn: 2, startedAt: ago(4 * MIN).toISOString(), retryAt: new Date(NOW.getTime() + MIN).toISOString(), attempts: 2, reason });

// ============================================================================
// The state, from facts already read
// ============================================================================

describe('the state of the box', () => {
  it.each<[string, Partial<SandboxStatusInput>, string, string]>([
    ['local', { row: row({ runtime: 'local', sandboxId: null }) }, 'local', 'This session runs on your computer.'],
    ['archived', { row: row({ archivedAt: ago(MIN), status: 'archived' }) }, 'archived', 'Archived. The session has no sandbox.'],
    ['an archive that failed', { row: row({ status: 'archiveError' }) }, 'failed', 'The archive failed.'],
    ['starting', { row: row({ status: 'provisioning', sandboxState: 'creating', statusMessage: 'Cloning the repository' }), fleet: null }, 'starting', 'Starting.'],
    ['starting, waiting for room', { row: row({ status: 'provisioning' }), fleet: null, chats: [chat({ queued: 1, headWait: wait('capacity') })] }, 'starting', 'Waiting for a free sandbox.'],
    ['moving', { row: row({ status: 'moving' }), fleet: null }, 'moving', 'Moving to a new sandbox.'],
    ['lost, a new box starting', { row: row({ status: 'provisioning', sandboxState: 'lost' }), fleet: null }, 'lost', 'The sandbox was lost. Talyn is starting a new one.'],
    ['lost, nothing starting', { row: row({ status: 'error', sandboxState: 'lost' }), fleet: null }, 'lost', 'The sandbox was lost. Retry to start a new one.'],
    ['failed to start', { row: row({ status: 'error', sandboxState: 'error', statusMessage: 'Could not clone o/r' }), fleet: null }, 'failed', 'The session could not start.'],
    ['busy', { fleet: fleet({ status: 'busy', startedAt: ago(90 * MIN).toISOString() }) }, 'running', 'Running.'],
    ['idle, with a sleep time', { fleet: fleet({ status: 'idle', lastRequestAt: ago(18 * MIN).toISOString(), idleTtlSec: 30 * 60 }) }, 'idle', 'Idle. It goes to sleep in 12 minutes.'],
    ['idle, past its sleep time', { fleet: fleet({ status: 'idle', lastRequestAt: ago(40 * MIN).toISOString(), idleTtlSec: 30 * 60 }) }, 'idle', 'Idle. It goes to sleep soon.'],
    ['idle, on an older fleetd', { fleet: fleet({ status: 'idle' }) }, 'idle', 'Idle.'],
    ['idle on the fleet, but a turn runs', { chats: [chat({ status: 'running', turnStartedAt: ago(5 * MIN) })] }, 'running', 'Running.'],
    ['asleep on its host', { fleet: fleet({ status: 'suspended', suspendDir: '/var/fleet/x', suspendUploaded: true, suspendedAt: ago(3 * 60 * MIN).toISOString() }) }, 'asleep', 'Asleep. It wakes in a few seconds at the next message.'],
    ['asleep in storage', { fleet: fleet({ status: 'suspended', suspendUploaded: true, suspendedAt: ago(26 * 60 * MIN).toISOString() }) }, 'hibernated', 'Asleep in storage. Waking it takes a few minutes.'],
    ['waking, Talyn resumes it', { resuming: true, fleet: fleet({ status: 'suspended' }) }, 'waking', 'Waking the sandbox.'],
    ['waking, a message waits for it', { chats: [chat({ queued: 1, headWait: wait('waking') })], fleet: fleet({ status: 'suspended' }) }, 'waking', 'Waking the sandbox.'],
    ['waking, the fleet restores it', { fleet: fleet({ status: 'starting' }) }, 'waking', 'Waking the sandbox.'],
    ['gone from the fleet', { fleet: fleet({ status: 'failed', error: 'host lost' }, { terminal: true }) }, 'lost', 'The fleet no longer runs this sandbox. Talyn starts a new one at the next message.'],
    ['the fleet does not answer', { fleet: { ok: false, error: 'connect ECONNREFUSED' } }, 'unknown', 'Talyn could not read the sandbox from the fleet.'],
    ['the fleet does not answer, the row says asleep', { row: row({ sandboxState: 'suspended' }), fleet: { ok: false, error: 'timeout' } }, 'asleep', 'Asleep.'],
  ])('%s', (_label, given, state, headline) => {
    const s = describeSandboxStatus(input(given));
    expect(s.state).toBe(state);
    expect(s.headline).toBe(headline);
  });

  it('gives the times: sleep, uptime, time asleep', () => {
    expect(describeSandboxStatus(input({ fleet: fleet({ status: 'idle', startedAt: ago(90 * MIN).toISOString(), lastRequestAt: ago(18 * MIN).toISOString(), idleTtlSec: 1800 }) })))
      .toMatchObject({ since: ago(90 * MIN).toISOString(), sleepsAt: new Date(NOW.getTime() + 12 * MIN).toISOString() });
    expect(describeSandboxStatus(input({ fleet: fleet({ status: 'suspended', suspendedAt: ago(60 * MIN).toISOString() }) })).since)
      .toBe(ago(60 * MIN).toISOString());
    // The fleet's zero time means never.
    expect(describeSandboxStatus(input({ fleet: fleet({ status: 'busy', startedAt: '0001-01-01T00:00:00Z' }) })).since).toBeNull();
  });

  it('says what the fleet answered, and unknown when it did not', () => {
    expect(describeSandboxStatus(input({ fleet: fleet({ status: 'busy', phase: 'agent' }) })).fleet)
      .toEqual({ known: true, status: 'busy', phase: 'agent', error: null });
    expect(describeSandboxStatus(input({ fleet: { ok: false, error: 'boom' } })).fleet)
      .toEqual({ known: false, status: null, phase: null, error: 'boom' });
    expect(describeSandboxStatus(input({ row: row({ status: 'provisioning' }), fleet: null })).fleet)
      .toEqual({ known: false, status: null, phase: null, error: null });
  });

  it.each<[string, Partial<FleetSandbox> | null, Partial<WorkbenchRow>, unknown]>([
    ['from the fleet', { memMib: 12288, vcpuCount: 6 }, {}, { key: 'large', label: 'Large · 12 GB, 6 vCPU', memMib: 12288, vcpus: 6 }],
    ['an odd size from the fleet', { memMib: 6144, milliVcpu: 3000 }, {}, { key: null, label: '6 GB, 3 vCPU', memMib: 6144, vcpus: 3 }],
    ['the session choice when the fleet does not answer', null, { settings: { sandboxSize: 'xlarge' } }, { key: 'xlarge', label: 'X-Large · 16 GB, 8 vCPU', memMib: 16384, vcpus: 8 }],
    ['unknown', null, {}, null],
  ])('reads the size: %s', (_label, sandbox, patch, expected) => {
    const s = describeSandboxStatus(input({ row: row(patch), fleet: sandbox ? fleet(sandbox) : { ok: false, error: 'x' } }));
    expect(s.size).toEqual(expected);
    expect(s.host).toBe('hetzner-64');
  });

  it.each<[string, Partial<FleetSandbox> | null, Partial<WorkbenchRow>, unknown]>([
    [
      'live use and limits',
      { memUsedMib: 1463, memMib: 4096, milliVcpu: 4000, diskMib: 24234 },
      {},
      { memoryUsedMib: 1463, memoryLimitMib: 4096, vcpus: 4, diskMib: 24234 },
    ],
    [
      'zero memory use',
      { memUsedMib: 0, memMib: 4096, vcpuCount: 2, diskMib: 0 },
      {},
      { memoryUsedMib: 0, memoryLimitMib: 4096, vcpus: 2, diskMib: null },
    ],
    [
      'the chosen size when the fleet is unavailable',
      null,
      { settings: { sandboxSize: 'large' } },
      { memoryUsedMib: null, memoryLimitMib: 12288, vcpus: 6, diskMib: null },
    ],
    ['no known resources', null, {}, null],
  ])('reads resources: %s', (_label, sandbox, patch, expected) => {
    const s = describeSandboxStatus(input({ row: row(patch), fleet: sandbox ? fleet(sandbox) : { ok: false, error: 'x' } }));
    expect(s.resources).toEqual(expected);
  });

  it('reads fleet resources for a thread without assigning a session size', () => {
    const s = describeSandboxStatus(input({
      row: row({ kind: 'thread' }),
      fleet: fleet({ memUsedMib: 512, memMib: 4096, vcpuCount: 2, diskMib: 16384 }),
    }));
    expect(s.size).toBeNull();
    expect(s.resources).toEqual({ memoryUsedMib: 512, memoryLimitMib: 4096, vcpus: 2, diskMib: 16384 });
  });

  const stored = (minutesAgo: number, cpuSeconds: number | null, memUsedMib = 1024) => ({
    workbenchId: 'wb1', sandboxId: 'box', sampledAt: ago(minutesAgo * MIN), memUsedMib, memLimitMib: 4096, cpuSeconds, vcpus: 2,
  });

  it('charts the stored samples and the live read of an awake box', () => {
    const s = describeSandboxStatus(input({
      fleet: fleet({ status: 'busy', memUsedMib: 2048, cpuSeconds: 166, memMib: 4096, milliVcpu: 2000 }),
      samples: [stored(2, 100), stored(1, 160)],
    }));
    expect(s.usage).toMatchObject({ windowMinutes: 60, memoryLimitMib: 4096, cpuReported: true });
    expect(s.usage?.points.map((p) => [p.memoryUsedMib, p.cpuPercent])).toEqual([[1024, null], [1024, 50], [2048, 5]]);
  });

  it.each([
    ['an asleep box adds no live point', { fleet: fleet({ status: 'suspended', memUsedMib: 2048 }), samples: [stored(5, 1)] }, 1],
    ['a failed fleet read keeps the stored points', { fleet: { ok: false as const, error: 'x' }, samples: [stored(5, 1), stored(4, 2)] }, 2],
    ['no samples and no figures', { fleet: fleet({ status: 'idle' }), samples: [] }, null],
    ['samples not read', { fleet: fleet({ status: 'idle' }) }, null],
  ])('usage: %s', (_label, given, points) => {
    const s = describeSandboxStatus(input(given));
    expect(s.usage?.points.length ?? null).toBe(points);
  });

  it.each([
    ['a thread', { kind: 'thread' as const }],
    ['an archived session', { archivedAt: ago(MIN) }],
    ['a local session', { runtime: 'local' as const }],
  ])('has no usage for %s', (_label, patch) => {
    const s = describeSandboxStatus(input({ row: row(patch), fleet: fleet({ status: 'busy', memUsedMib: 1 }), samples: [stored(1, 1)] }));
    expect(s.usage).toBeNull();
  });
});

describe('what runs on the box', () => {
  it('lists turns, waits, queued messages and scripts, per chat when there are many', () => {
    const scripts: StatusScript[] = [
      { name: 'setup', sandboxId: 'box', running: true, exitCode: null, startedAt: ago(3 * MIN) },
      { name: 'dev', sandboxId: 'box', running: true, exitCode: null, startedAt: null },
      { name: 'old', sandboxId: 'box-r0', running: true, exitCode: null, startedAt: ago(MIN) },
      { name: 'test', sandboxId: 'box', running: false, exitCode: 0, startedAt: ago(MIN) },
    ];
    const s = describeSandboxStatus(input({
      chats: [
        chat({ id: 'c1', title: 'Main', status: 'running', turnStartedAt: ago(65 * MIN), queued: 2 }),
        chat({ id: 'c2', title: 'Side', queued: 1, headWait: wait('capacity') }),
        chat({ id: 'c3', title: 'Closed', status: 'running', closedAt: ago(MIN) }),
      ],
      scripts,
    }));
    expect(s.activity.map((a) => [a.kind, a.text])).toEqual([
      ['turn', 'The agent is working in "Main" for 1 hour 5 minutes.'],
      ['queued', '2 messages queued in "Main".'],
      ['capacity_wait', 'Waiting for a free sandbox for a message in "Side". Try 3 at 2099-01-01 12:01 UTC.'],
      ['setup', 'The setup script is running for 3 minutes.'],
      ['script', 'The script "dev" is running.'],
    ]);
  });

  it('says nothing runs with an empty list', () => {
    expect(describeSandboxStatus(input()).activity).toEqual([]);
  });
});

describe('work safety', () => {
  it.each<[string, Partial<WorkbenchRow>, StatusChat[], string | null, string | null]>([
    ['saved and nothing running', { workCheckpointAt: ago(140 * MIN), workUnpushedCommits: 1 }, [chat()], null, null],
    ['one failed save', { workCheckpointAt: ago(40 * MIN), workSaveFailures: 1, workSaveError: 'could not write the bundle', workSaveFailedAt: ago(MIN) }, [chat()],
      'warn', 'The last save failed: could not write the bundle. Talyn tries again after the next change.'],
    ['saves keep failing', { workCheckpointAt: new Date('2099-01-01T10:00:00Z'), workSaveFailures: 4, workSaveError: 'x', workSaveFailedAt: ago(MIN) }, [chat()],
      'danger', 'Talyn could not save the work 4 times in a row. If the sandbox is lost, changes made after 2099-01-01 10:00 UTC are lost. Push the branch to keep them.'],
    ['a long turn with no save', { workCheckpointAt: ago(50 * MIN) }, [chat({ status: 'running', turnStartedAt: ago(45 * MIN) })],
      'warn', 'The agent is working and Talyn has not saved the work for 45 minutes.'],
    ['a long turn with a recent check', { workCheckpointAt: ago(50 * MIN), workCheckedAt: ago(2 * MIN) }, [chat({ status: 'running', turnStartedAt: ago(45 * MIN) })], null, null],
    ['a new turn after a long idle time', { workCheckpointAt: ago(3 * 60 * MIN) }, [chat({ status: 'running', turnStartedAt: ago(5 * MIN) })], null, null],
    ['work with no saved copy', { diffStat: { added: 3, removed: 1, files: 2 } }, [chat()],
      'warn', 'Talyn has no saved copy of this work. If the sandbox is lost, changes that are not pushed are lost.'],
    ['nothing to save', { workCheckedAt: ago(MIN), workUnpushedCommits: 0 }, [chat()], null, null],
  ])('%s', (_label, patch, chats, level, warning) => {
    const s = describeSandboxStatus(input({ row: row(patch), chats }));
    expect(s.work?.warningLevel).toBe(level);
    expect(s.work?.warning).toBe(warning);
  });

  it('reports the saved copy, the check, the changes and the push state', () => {
    const s = describeSandboxStatus(input({ row: row({
      workCheckpointAt: ago(30 * MIN), workCheckpointBytes: 1554, workCheckedAt: ago(5 * MIN), workUnpushedCommits: 1,
      diffStat: { added: 0, removed: 0, files: 0, uncommittedStats: { added: 1, removed: 2, files: 1 }, committedStats: { added: 5, removed: 0, files: 2 } },
    }) }));
    expect(s.work).toEqual({
      savedAt: ago(30 * MIN).toISOString(), savedBytes: 1554, checkedAt: ago(5 * MIN).toISOString(), unpushedCommits: 1,
      uncommitted: { added: 1, removed: 2, files: 1 }, committed: { added: 5, removed: 0, files: 2 }, branchPushed: false,
      failures: 0, lastFailureAt: null, lastFailure: null, warning: null, warningLevel: null,
    });
    expect(describeSandboxStatus(input({ row: row({ workUnpushedCommits: 0 }) })).work?.branchPushed).toBe(true);
    expect(describeSandboxStatus(input()).work?.branchPushed).toBeNull();
    expect(describeSandboxStatus(input({ row: row({ kind: 'thread' }) })).work).toBeNull();
  });
});

describe('the last problem', () => {
  it.each<[string, Partial<SandboxStatusInput>, unknown]>([
    ['none', {}, null],
    ['the session failed, first', {
      row: row({ status: 'error', statusMessage: 'Could not clone', updatedAt: ago(10 * MIN) }),
      note: { subtype: 'sandbox_recovered', text: 'newer note', at: ago(MIN) },
    }, { text: 'Could not clone', at: ago(10 * MIN).toISOString() }],
    ['the newest of a save failure and a note', {
      row: row({ workSaveFailures: 1, workSaveError: 'disk I/O error', workSaveFailedAt: ago(2 * MIN) }),
      note: { subtype: 'sandbox_recovered', text: 'The sandbox was lost.', at: ago(30 * MIN) },
    }, { text: 'A save of the work failed: disk I/O error', at: ago(2 * MIN).toISOString() }],
    ['a recovery note', { note: { subtype: 'sandbox_recovered', text: 'The sandbox was lost and Talyn started a new one.', at: ago(30 * MIN) } },
      { text: 'The sandbox was lost and Talyn started a new one.', at: ago(30 * MIN).toISOString() }],
    ['a failed move', { row: row({ settings: { moveFailedAt: ago(5 * MIN).toISOString() } as never }) },
      { text: 'The last move to a new sandbox failed. The session stayed on its sandbox.', at: ago(5 * MIN).toISOString() }],
  ])('%s', (_label, given, expected) => {
    expect(describeSandboxStatus(input(given)).problem).toEqual(expected);
  });
});

describe('the actions', () => {
  const kinds = (given: Partial<SandboxStatusInput>) => describeSandboxStatus(input(given)).actions.map((a) => a.kind);
  it.each<[string, Partial<SandboxStatusInput>, string[]]>([
    ['awake', {}, ['resize']],
    ['asleep', { fleet: fleet({ status: 'suspended', suspendDir: '/x' }) }, ['wake', 'resize']],
    ['hibernated', { fleet: fleet({ status: 'suspended', suspendUploaded: true }) }, ['wake', 'resize']],
    ['failed', { row: row({ status: 'error' }), fleet: null }, ['retry']],
    ['starting, recently', { row: row({ status: 'provisioning', updatedAt: ago(MIN) }), fleet: null }, []],
    ['starting, stuck', { row: row({ status: 'provisioning', updatedAt: ago(STUCK_START_MS + MIN) }), fleet: null }, ['retry']],
    ['starting, waiting for room for long', { row: row({ status: 'provisioning', updatedAt: ago(STUCK_START_MS + MIN) }), fleet: null, chats: [chat({ queued: 1, headWait: wait('capacity') })] }, []],
    ['lost and recovering', { row: row({ status: 'provisioning', sandboxState: 'lost' }), fleet: null }, []],
    ['a thread', { row: row({ kind: 'thread' }) }, []],
    ['archived', { row: row({ archivedAt: ago(MIN) }) }, []],
    ['local', { row: row({ runtime: 'local' }) }, []],
    ['a setup that failed', { scripts: [{ name: 'setup', sandboxId: 'box', running: false, exitCode: 2, startedAt: null }] }, ['resize', 'show_setup_output']],
    ['a setup that worked', { scripts: [{ name: 'setup', sandboxId: 'box', running: false, exitCode: 0, startedAt: null }] }, ['resize']],
  ])('%s', (_label, given, expected) => {
    expect(kinds(given)).toEqual(expected);
  });

  it('asks before a retry that deletes the box, and not before one that keeps the checkpoint', () => {
    const failed = describeSandboxStatus(input({ row: row({ status: 'error' }), fleet: null })).actions[0];
    expect(failed.confirm).toContain('Changes that are not pushed are lost.');
    const lost = describeSandboxStatus(input({ row: row({ status: 'provisioning', sandboxState: 'lost', updatedAt: ago(STUCK_START_MS + MIN) }), fleet: null })).actions[0];
    expect(lost).toEqual({ kind: 'retry', label: 'Retry', confirm: null });
    for (const a of describeSandboxStatus(input({ fleet: fleet({ status: 'suspended' }) })).actions) expect(a.confirm).toBeNull();
  });
});

// ============================================================================
// How the box started
// ============================================================================

const SEC = 1000;

function boxStart(overrides: Partial<StoredBoxStart> = {}): StoredBoxStart {
  return {
    sandboxId: 'box', cause: 'new', measuredAt: ago(30 * MIN).toISOString(), requestedAt: ago(37 * MIN).toISOString(),
    waitMs: null, readyMs: 20 * SEC, checkoutMs: 4 * SEC, prebaked: true, repoSetupMs: 6 * SEC, stepsMs: 15 * SEC,
    setupMs: 22 * SEC, setupExit: 0, totalMs: 47 * SEC,
    steps: [
      { id: 'dotfiles', name: 'Dotfiles', ms: 3 * SEC, exit: 0 },
      { id: 'st_1', name: 'Install sqlx', ms: 12 * SEC, exit: 0 },
    ],
    layer: 'repo', repoCommit: 'abc123def4567890', userLayerPending: null, repoLayerPending: null,
    ...overrides,
  };
}

const withStart = (start: StoredBoxStart | null, extra: Record<string, unknown> = {}, rowOverrides: Partial<WorkbenchRow> = {}) =>
  row({ settings: { ...(start ? { boxStart: start } : {}), ...extra } as WorkbenchRow['settings'], ...rowOverrides });

const hist = (ms: number, overrides: Partial<StartHistoryEntry> = {}): StartHistoryEntry =>
  ({ at: ago(60 * MIN).toISOString(), ms, layer: 'repo', wb: 'other', ...overrides });

describe('how the box started', () => {
  it.each<[string, Partial<FleetSandbox>, string, string]>([
    ['your image', { layer: 'user' }, 'user', 'Your image for this repository'],
    ['the shared image', { layer: 'repo' }, 'repo', 'The shared image for this repository'],
    ['an older image', { layer: 'legacy' }, 'legacy', 'An older image for this repository'],
    ['the base image', { layer: 'base' }, 'base', 'The base image, with a full clone'],
    ['an old fleet that says only goldenLayer repo', { goldenLayer: 'repo' }, 'legacy', 'An older image for this repository'],
    ['an old fleet that says only goldenLayer base', { goldenLayer: 'base' }, 'base', 'The base image, with a full clone'],
  ])('names %s from the fleet record', (_label, sandbox, layer, label) => {
    const image = describeSandboxStatus(input({ fleet: fleet({ status: 'idle', repoCommit: 'f00d', ...sandbox }) })).start!.image!;
    expect(image).toMatchObject({ layer, label, repoCommit: 'f00d', builtAt: null });
    expect(image.detail.length).toBeGreaterThan(20);
  });

  it('reads the image from the stored start when the fleet does not answer, and the fleet record wins when it does', () => {
    expect(describeSandboxStatus(input({ row: withStart(boxStart({ layer: 'user' })), fleet: { ok: false, error: 'timeout' } })).start!.image)
      .toMatchObject({ layer: 'user', repoCommit: 'abc123def4567890' });
    expect(describeSandboxStatus(input({ row: withStart(boxStart({ layer: 'user' })), fleet: fleet({ layer: 'base' }) })).start!.image)
      .toMatchObject({ layer: 'base', repoCommit: 'abc123def4567890' });
  });

  it('has no image when neither the fleet nor Talyn knows one', () => {
    const start = describeSandboxStatus(input({ fleet: fleet({ status: 'idle' }) })).start!;
    expect(start.image).toBeNull();
    expect(start.timeline).toBeNull();
    expect(start.note).toBe('Talyn has no start times for this box. A box that started before Talyn kept them has none.');
  });

  it.each<[boolean | undefined, boolean | undefined, string | null]>([
    [true, false, 'The fleet is building a new image with the Setup list. A new box uses it when it is ready.'],
    [false, true, 'The fleet is building a new image of this repository. A new box uses it when it is ready.'],
    [true, true, 'The fleet is building new images for this repository. A new box uses them when they are ready.'],
    [false, false, null],
  ])('says when a newer layer is building: user %s, repo %s', (user, repo, words) => {
    const image = describeSandboxStatus(input({ fleet: fleet({ layer: 'repo', userLayerPending: user, repoLayerPending: repo }) })).start!.image!;
    expect(image.pending).toBe(words);
    expect(image).toMatchObject({ userLayerPending: user, repoLayerPending: repo });
  });

  it('says a stale image', () => {
    expect(describeSandboxStatus(input({ fleet: fleet({ layer: 'repo', goldenStale: true }) })).start!.image!.stale).toBe(true);
  });

  it('builds the timeline from the stored start, with each step and its result', () => {
    const start = describeSandboxStatus(input({
      row: withStart(boxStart({
        waitMs: 90 * SEC, readyMs: 110 * SEC, setupExit: 1,
        steps: [
          { id: 'dotfiles', name: 'Dotfiles', ms: 3 * SEC, exit: 0 },
          { id: 'st_1', name: 'Install sqlx', ms: 12 * SEC, exit: 101 },
          { id: 'st_2', name: 'Start the database', ms: 300 * SEC, exit: 124, timedOut: true },
        ],
      })),
    })).start!;
    expect(start.timeline).toMatchObject({ sandboxId: 'box', cause: 'new', capacityWaitMs: 90 * SEC, totalMs: 47 * SEC });
    expect(start.timeline!.steps).toEqual([
      { kind: 'capacity_wait', label: 'Waited for a free sandbox', durationMs: 90 * SEC, ok: null },
      { kind: 'box', label: 'Box started', durationMs: 20 * SEC, ok: null },
      { kind: 'checkout', label: 'Checked out the branch', durationMs: 4 * SEC, ok: null },
      { kind: 'repository_setup', label: 'Repository setup', durationMs: 6 * SEC, ok: false, detail: 'exit 1' },
      { kind: 'box_steps', label: 'Setup list steps', durationMs: 15 * SEC, ok: false },
      { kind: 'setup_step', label: 'Dotfiles', durationMs: 3 * SEC, ok: true },
      { kind: 'setup_step', label: 'Install sqlx', durationMs: 12 * SEC, ok: false, detail: 'exit 101' },
      { kind: 'setup_step', label: 'Start the database', durationMs: 300 * SEC, ok: false, detail: 'timed out' },
      { kind: 'ready', label: 'Ready', durationMs: 47 * SEC, ok: null },
    ]);
  });

  it('says clone for a base image, and takes the whole setup as the repository setup when no step ran', () => {
    const steps = describeSandboxStatus(input({
      row: withStart(boxStart({ layer: 'base', prebaked: null, repoSetupMs: null, stepsMs: null, steps: [], setupMs: 30 * SEC })),
      fleet: fleet({}),
    })).start!.timeline!.steps;
    expect(steps.map((s) => s.kind)).toEqual(['box', 'clone', 'repository_setup', 'ready']);
    expect(steps[1]).toMatchObject({ label: 'Cloned the repository', durationMs: 4 * SEC });
    expect(steps[2]).toMatchObject({ durationMs: 30 * SEC, ok: true });
  });

  it('leaves out rows that were not measured: an old record, and a start whose setup still runs', () => {
    const partial = boxStart({ totalMs: null, setupMs: null, setupExit: null, repoSetupMs: null, stepsMs: null, steps: [], checkoutMs: null });
    const running = describeSandboxStatus(input({ row: withStart(partial, {}, { status: 'provisioning' }), fleet: null })).start!;
    expect(running.timeline!.steps.map((s) => s.kind)).toEqual(['box']);
    expect(running.note).toBe('The setup is running. Talyn adds its times when it ends.');
    expect(running.image).toMatchObject({ layer: 'repo' });
  });

  it('ignores a stored start of another box', () => {
    const start = describeSandboxStatus(input({ row: withStart(boxStart({ sandboxId: 'old-box' })), fleet: fleet({}) })).start!;
    expect(start.timeline).toBeNull();
    expect(start.note).toContain('Talyn has no start times for this box');
  });

  it('says a start that has not ended yet', () => {
    expect(describeSandboxStatus(input({ row: row({ status: 'provisioning' }), fleet: null })).start!.note)
      .toBe('Talyn shows the start times when the box is ready.');
  });

  it.each<[string, Partial<SandboxStatusInput>]>([
    ['a local session', { row: row({ runtime: 'local', sandboxId: null }) }],
    ['an archived session', { row: row({ archivedAt: ago(MIN), status: 'archived' }) }],
    ['a thread', { row: row({ kind: 'thread', repositoryId: null }) }],
  ])('has no section for %s', (_label, given) => {
    expect(describeSandboxStatus(input(given)).start).toBeNull();
  });

  it('compares the start with the median of the repository, leaving its own entry out', () => {
    const own = boxStart({ totalMs: 380 * SEC });
    const history = [
      hist(380 * SEC, { wb: 'wb1', at: own.measuredAt }),
      hist(40 * SEC), hist(48 * SEC, { wb: 'wb1', at: ago(5 * 60 * MIN).toISOString() }), hist(50 * SEC), hist(60 * SEC, { layer: 'base' }),
      hist(45 * SEC), hist(52 * SEC),
    ];
    const start = describeSandboxStatus(input({ row: withStart(own), history })).start!;
    expect(start.medianMs).toBe(49 * SEC);
    expect(start.comparison).toBe('This start took 6m 20s. The median start for this repository is 49s.');
    expect(start.slow).toBe(true);
    expect(start.recent).toHaveLength(5);
    expect(start.recent[0]).toEqual({ at: own.measuredAt, totalMs: 380 * SEC, layer: 'repo', thisSession: true });
    expect(start.recent[2]).toMatchObject({ thisSession: true });
    expect(start.recent[4]).toMatchObject({ layer: 'base', thisSession: false });
  });

  it.each<[string, number, number[], boolean, string | null]>([
    ['a normal start', 50 * SEC, [40 * SEC, 48 * SEC, 52 * SEC], false, 'This start took 50s. The median start for this repository is 48s.'],
    ['twice the median but under a minute more', 90 * SEC, [40 * SEC, 45 * SEC, 50 * SEC], false, 'This start took 1m 30s. The median start for this repository is 45s.'],
    ['too few other starts', 300 * SEC, [40 * SEC, 45 * SEC], false, null],
  ])('%s', (_label, total, others, slow, comparison) => {
    const start = describeSandboxStatus(input({ row: withStart(boxStart({ totalMs: total })), history: others.map((ms) => hist(ms)) })).start!;
    expect(start.slow).toBe(slow);
    expect(start.comparison).toBe(comparison);
  });

  it('gives the median alone when this box has no total', () => {
    const start = describeSandboxStatus(input({ history: [hist(40 * SEC), hist(50 * SEC), hist(60 * SEC)] })).start!;
    expect(start).toMatchObject({ medianMs: 50 * SEC, comparison: 'The median start for this repository is 50s.', slow: false });
  });

  it.each<[Partial<StoredWake>, string]>([
    [{ from: 'storage', ok: true, ms: 130 * SEC }, 'Restored from storage in 2m 10s.'],
    [{ from: 'host', ok: true, ms: 3 * SEC }, 'Woke on its host in 3s.'],
    [{ from: 'storage', ok: false, ms: 300 * SEC }, 'A restore from storage failed after 5m 0s.'],
    [{ from: 'host', ok: true, ms: null }, 'Woke on its host.'],
  ])('says the last wake: %o', (wake, words) => {
    const stored: StoredWake = { sandboxId: 'box', at: ago(10 * MIN).toISOString(), ms: null, from: 'host', ok: true, ...wake };
    expect(describeSandboxStatus(input({ row: withStart(null, { lastWake: stored }) })).start!.lastWake)
      .toEqual({ at: stored.at, durationMs: stored.ms, from: stored.from, ok: stored.ok, text: words });
  });

  it('ignores a wake of another box', () => {
    const stored: StoredWake = { sandboxId: 'old-box', at: ago(MIN).toISOString(), ms: 1000, from: 'host', ok: true };
    expect(describeSandboxStatus(input({ row: withStart(null, { lastWake: stored }) })).start!.lastWake).toBeNull();
  });
});

// ============================================================================
// The endpoint, against a database
// ============================================================================

describe('GET /workbenches/:id/sandbox-status', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base: string;
  const getSandbox = vi.fn();

  async function call(url: string, user = 'owner-a') {
    const resp = await fetch(`${base}${url}`, { headers: { 'x-user': user } });
    return { status: resp.status, body: (await resp.json()) as { success: boolean; data?: Record<string, unknown> & { [k: string]: unknown } } };
  }

  beforeAll(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws-a', name: 'o/r', url: 'https://github.com/o/r' });
    const app = express();
    app.use((req, _res, next) => {
      const id = req.headers['x-user'] as string;
      req.user = { id, email: `${id}@example.test`, isAdmin: false };
      next();
    });
    app.use('/workbenches', wrapAsyncRoutes(workbenchRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await testDb.cleanup();
  });

  beforeEach(async () => {
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    resetFeatureFlagsForTests();
    resetSandboxStatusCacheForTests();
    getSandbox.mockReset();
    setWorkbenchFleetClientForTests(async () => ({ getSandbox } as unknown as FleetClient));
    await testDb.db.delete(workbenches);
    await insertWorkbench({
      id: 'wb-a', workspaceId: 'ws-a', repositoryId: 'repo', repoFullName: 'o/r', name: 'paris', branch: 'feat',
      baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready', sandboxId: 'box', sandboxState: 'running',
      fleetHost: 'hetzner-64',
    });
    await insertChat({ id: 'chat-a', workbenchId: 'wb-a', workspaceId: 'ws-a', title: 'Chat', agent: 'claude' });
  });

  afterEach(() => {
    setWorkbenchFleetClientForTests(null);
    vi.unstubAllEnvs();
  });

  it('assembles the row, the chats, the scripts, the newest problem note and the fleet record', async () => {
    getSandbox.mockResolvedValue({ sandbox: { id: 'box', status: 'busy', memMib: 4096, vcpuCount: 4 }, terminal: false });
    await testDb.db.update(workbenchChats).set({ status: 'running', turnStartedAt: new Date(Date.now() - 5 * MIN), nextSeq: 3 });
    await testDb.db.insert(workbenchEvents).values([
      { chatId: 'chat-a', seq: 1, turn: 1, event: { type: 'system', subtype: 'sandbox_recovered', text: 'The sandbox was lost.' } },
      { chatId: 'chat-a', seq: 2, turn: 1, event: { type: 'system', subtype: 'status', text: 'not a problem' } },
      { chatId: 'chat-a', seq: 3, turn: 1, event: { type: 'assistant', message: { content: 'hello' } } },
    ]);
    await testDb.db.insert(workbenchScriptRuns).values({
      id: 'wb-a:setup', workbenchId: 'wb-a', workspaceId: 'ws-a', sandboxId: 'box', name: 'setup', generation: 'g', owner: 'o',
      running: false, exitCode: 1, startedAt: new Date(Date.now() - 10 * MIN),
    });
    const res = await call('/workbenches/wb-a/sandbox-status');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      workbenchId: 'wb-a', state: 'running', host: 'hetzner-64',
      size: { key: 'standard', label: 'Standard · 4 GB, 4 vCPU' },
      fleet: { known: true, status: 'busy' },
      problem: { text: 'The sandbox was lost.' },
      activity: [{ kind: 'turn', text: 'The agent is working for 5 minutes.' }],
    });
    expect((res.body.data!.actions as Array<{ kind: string }>).map((a) => a.kind)).toEqual(['resize', 'show_setup_output']);
    expect(getSandbox).toHaveBeenCalledWith('box');
  });

  it('answers with an unknown fleet part when the fleet fails, and never fails the request', async () => {
    getSandbox.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const res = await call('/workbenches/wb-a/sandbox-status');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ state: 'unknown', fleet: { known: false, error: 'connect ECONNREFUSED' } });
  });

  it('answers with an unknown fleet part when the fleet client cannot be made', async () => {
    setWorkbenchFleetClientForTests(async () => null);
    const res = await call('/workbenches/wb-a/sandbox-status');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ fleet: { known: false, error: expect.stringContaining('not configured') } });
  });

  it('reads the fleet once per box per ten seconds', async () => {
    getSandbox.mockResolvedValue({ sandbox: { id: 'box', status: 'idle' }, terminal: false });
    const stored = (await getWorkbench('wb-a'))!;
    const t = Date.now();
    await Promise.all([getSandboxStatus(stored, new Date(t)), getSandboxStatus(stored, new Date(t + 1_000))]);
    await getSandboxStatus(stored, new Date(t + FLEET_READ_TTL_MS - 1));
    expect(getSandbox).toHaveBeenCalledTimes(1);
    await getSandboxStatus(stored, new Date(t + FLEET_READ_TTL_MS));
    expect(getSandbox).toHaveBeenCalledTimes(2);
  });

  it('does not ask the fleet about a box that is starting or lost', async () => {
    await testDb.db.update(workbenches).set({ status: 'provisioning', sandboxState: 'lost' });
    const res = await call('/workbenches/wb-a/sandbox-status');
    expect(res.body.data).toMatchObject({ state: 'lost', replacementStarting: true });
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it('reads ship no transcript, no parser state, no queued attachments and no script output', () => {
    const chats = statusChatsQuery('wb1').toSQL().sql;
    expect(chats).toContain('jsonb_array_length("queued_messages")');
    expect(chats).not.toMatch(/"queued_messages",|"turn_parser"|"agent_backup"|"turn_message"/);
    const scripts = statusScriptsQuery('wb1').toSQL().sql;
    expect(scripts).not.toContain('"output"');
    const note = problemNoteQuery([{ id: 'c1', nextSeq: 5000 }]).toSQL();
    const selected = note.sql.slice(0, note.sql.indexOf(' from '));
    expect(selected.replace(/(?:"workbench_events"\.)?"event" ->> '[a-z]+'/g, '')).not.toContain('"event"');
    expect(note.sql).not.toContain('transcript');
    expect(note.params).toContain(5000 - PROBLEM_NOTE_WINDOW);
  });
  it('answers how the box started: the stored start, the fleet image, the last wake and the repository median', async () => {
    getSandbox.mockResolvedValue({ sandbox: { id: 'box', status: 'idle', layer: 'user', repoCommit: 'c0ffee', userLayerPending: false }, terminal: false });
    const measuredAt = new Date(Date.now() - 30 * MIN).toISOString();
    await testDb.db.update(workbenches).set({
      settings: {
        boxStart: { sandboxId: 'box', cause: 'new', measuredAt, requestedAt: null, waitMs: null, readyMs: 20_000, checkoutMs: 3_000, prebaked: true,
          repoSetupMs: null, stepsMs: 1_000, setupMs: 2_000, setupExit: 0, totalMs: 380_000,
          steps: [{ id: 'st_1', name: 'Install just', ms: 1_000, exit: 0 }], layer: 'user', repoCommit: null, userLayerPending: true, repoLayerPending: null },
      } as never,
    });
    await recordSandboxWake({ sandboxId: 'box', at: new Date(Date.now() - MIN).toISOString(), ms: 2_500, from: 'host', ok: true });
    const entry = (ms: number, extra: Record<string, unknown> = {}) =>
      ({ totalMs: 0, repositoryMs: null, learnedMs: 0, measuredAt: new Date(Date.now() - 60 * MIN).toISOString(), workbenchId: 'other', boxReadyMs: ms, checkoutMs: 0, ...extra });
    await testDb.db.update(repositories).set({
      settings: { setupTimingHistory: [entry(1, { startTotalMs: 380_000, measuredAt, workbenchId: 'wb-a' }), entry(40_000), entry(45_000), entry(50_000)] } as never,
    });
    const res = await call('/workbenches/wb-a/sandbox-status');
    const start = res.body.data!.start as SandboxStartInfo;
    expect(start.image).toMatchObject({ layer: 'user', label: 'Your image for this repository', repoCommit: 'c0ffee', userLayerPending: false, pending: null });
    expect(start.timeline!.steps.map((s) => s.kind)).toEqual(['box', 'checkout', 'box_steps', 'setup_step', 'ready']);
    expect(start.lastWake).toMatchObject({ from: 'host', text: 'Woke on its host in 3s.' });
    expect(start).toMatchObject({ medianMs: 45_000, slow: true, comparison: 'This start took 6m 20s. The median start for this repository is 45s.' });
    expect(start.recent.map((r) => r.thisSession)).toEqual([true, false, false, false]);
    // The start and the wake stay out of the session payload.
    const wb = await call('/workbenches/wb-a');
    expect(JSON.stringify(wb.body.data)).not.toMatch(/boxStart|lastWake/);
  });

  it('answers with an empty history when the repository has none, and never fails on a broken one', async () => {
    getSandbox.mockResolvedValue({ sandbox: { id: 'box', status: 'idle' }, terminal: false });
    await testDb.db.update(repositories).set({ settings: { setupTimingHistory: 'not a list' } as never });
    const res = await call('/workbenches/wb-a/sandbox-status');
    expect(res.status).toBe(200);
    expect(res.body.data!.start).toMatchObject({ recent: [], medianMs: null, image: null, timeline: null });
  });

  it('reduces the history in SQL to four fields, leaves out entries with no box time, and totals old entries from their parts', async () => {
    await testDb.db.update(repositories).set({
      settings: {
        setupTiming: { big: 'x'.repeat(5000) },
        setupTimingHistory: [
          { measuredAt: '2099-01-01T10:00:00.000Z', workbenchId: 'w1', boxReadyMs: 10_000, checkoutMs: 2_000, totalMs: 30_000, layer: 'repo', startTotalMs: 45_500 },
          { measuredAt: '2099-01-01T09:00:00.000Z', workbenchId: 'w2', boxReadyMs: 10_000, checkoutMs: null, totalMs: 30_000, layer: 'base' },
          { measuredAt: '2099-01-01T08:00:00.000Z', workbenchId: 'w3', totalMs: 99_000, repositoryMs: null, learnedMs: 99_000 },
          'junk',
        ],
      } as never,
    });
    const [found] = await startHistoryQuery('repo');
    expect(parseStartHistory(found.recent)).toEqual([
      { at: '2099-01-01T10:00:00.000Z', ms: 45_500, layer: 'repo', wb: 'w1' },
      { at: '2099-01-01T09:00:00.000Z', ms: 40_000, layer: 'base', wb: 'w2' },
    ]);
    const query = startHistoryQuery('repo').toSQL().sql;
    const selected = query.slice(0, query.lastIndexOf(' from "repositories"'));
    expect(selected.replace(/"repositories"\."settings" -> 'setupTimingHistory'/g, '')).not.toContain('"settings"');
  });

  it('records a wake on the session that names the box, and on no other', async () => {
    await recordSandboxWake({ sandboxId: 'box', at: '2099-01-01T10:00:00.000Z', ms: 120_000, from: 'storage', ok: true });
    await recordSandboxWake({ sandboxId: 'not-ours', at: '2099-01-01T10:00:00.000Z', ms: 1, from: 'host', ok: true });
    expect(((await getWorkbench('wb-a'))!.settings as Record<string, unknown>).lastWake)
      .toEqual({ sandboxId: 'box', at: '2099-01-01T10:00:00.000Z', ms: 120_000, from: 'storage', ok: true });
  });

  it('refuses another owner, and an account without sessions', async () => {
    expect([403, 404]).toContain((await call('/workbenches/wb-a/sandbox-status', 'owner-b')).status);
    vi.stubEnv('WORKBENCHES_ENABLED', 'false');
    resetFeatureFlagsForTests();
    expect((await call('/workbenches/wb-a/sandbox-status')).status).toBe(403);
    expect((await call('/workbenches/nope/sandbox-status')).status).toBe(404);
  });
});
