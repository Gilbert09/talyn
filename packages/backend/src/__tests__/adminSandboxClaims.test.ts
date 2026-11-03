import { describe, it, expect } from 'vitest';
import {
  classifySandbox,
  logicalSandboxId,
  parseSandboxId,
  sandboxIdGeneration,
  workbenchShortId,
  type ReviewClaim,
  type SandboxClaims,
  type TaskClaim,
  type WorkbenchClaim,
} from '../services/admin/sandboxClaims.js';
import { adminRunFromFleet, applyClassification, runMatches, sleepOf } from '../services/admin/runIndex.js';
import type { FleetSandbox } from '../services/selfHosted/client.js';

/**
 * Which Talyn row claims a fleet sandbox, and what the Runs page calls it.
 *
 * On 2026-11-03 every session box on the Runs page showed "orphan" with no host
 * and no owner, because the page joined only `talyn-<task>` ids. "Orphan" is
 * the signal that a microVM burns memory for nobody; shown on every session it
 * meant nothing. These pin the three id schemes and the line between an orphan
 * (no row of any status) and a superseded box (a row that moved on).
 */

const WB_ID = '0b1a719c-5cb9-4c14-901f-5b9812345678';
const WB_SHORT = workbenchShortId(WB_ID);
const TASK_ID = '325792e2-4f3c-4a73-b04d-f10e7b361b2a';

function wb(over: Partial<WorkbenchClaim> = {}): WorkbenchClaim {
  return {
    id: WB_ID,
    kind: 'session',
    title: 'Fix the login flow',
    name: 'lisbon',
    status: 'ready',
    workspaceId: 'ws1',
    workspaceName: 'PostHog',
    ownerEmail: 'owner@example.test',
    repoFullName: 'posthog/posthog',
    sandboxId: `talyn-wb-${WB_SHORT}-r5`,
    fleetSandboxId: null,
    moveSandboxId: null,
    keptSandboxIds: [],
    fleetHost: 'hetzner-64',
    sandboxSize: 'large',
    archivedAt: null,
    ...over,
  };
}

function task(over: Partial<TaskClaim> = {}): TaskClaim {
  return {
    id: TASK_ID,
    title: 'Get posthog#1 mergeable',
    status: 'in_progress',
    workspaceId: 'ws1',
    workspaceName: 'PostHog',
    ownerEmail: 'owner@example.test',
    remoteRunId: `talyn-${TASK_ID}`,
    fleetHost: 'scaleway-1',
    costUsd: 0.42,
    ...over,
  };
}

function review(over: Partial<ReviewClaim> = {}): ReviewClaim {
  return {
    id: 'unit-1',
    lens: 'security',
    kind: 'lens',
    status: 'running',
    settled: false,
    workspaceId: 'ws1',
    workspaceName: 'PostHog',
    ownerEmail: 'owner@example.test',
    host: 'hetzner-64',
    ...over,
  };
}

function claims(over: Partial<SandboxClaims> = {}): SandboxClaims {
  return { tasks: new Map(), workbenches: [], reviews: new Map(), ...over };
}

describe('parseSandboxId', () => {
  it.each([
    ['a task run', `talyn-${TASK_ID}`, 'task', TASK_ID, 0],
    ['a retried task run', `talyn-${TASK_ID}-r2`, 'task', TASK_ID, 2],
    ['a session box', `talyn-wb-${WB_SHORT}`, 'workbench', WB_SHORT, 0],
    ['a session box after five restores', `talyn-wb-${WB_SHORT}-r5`, 'workbench', WB_SHORT, 5],
    ['a session box with the gateway suffix', `talyn-wb-${WB_SHORT}-r5--3542ee`, 'workbench', WB_SHORT, 5],
    ['a review unit', 'talyn-rev-unit-1', 'review', 'unit-1', 0],
    ['a moved review unit', 'talyn-rev-unit-1-r1', 'review', 'unit-1', 1],
    ['a deploy self-test', 'deploy-api-1785848330', 'unknown', null, 0],
    ['a hand-made box', 'test--3f9c1a', 'unknown', null, 0],
  ])('reads %s', (_label, id, kind, key, generation) => {
    const parsed = parseSandboxId(id);
    expect(parsed.kind).toBe(kind);
    expect(parsed.key).toBe(key);
    expect(parsed.generation).toBe(generation);
  });

  it('drops only the gateway suffix from the logical id', () => {
    expect(logicalSandboxId(`talyn-wb-${WB_SHORT}-r5--3542ee`)).toBe(`talyn-wb-${WB_SHORT}-r5`);
    expect(sandboxIdGeneration(`talyn-wb-${WB_SHORT}-r5--3542ee`)).toBe(5);
  });

  it('uses 24 hex digits of the workbench id, as sandboxIdFor does', () => {
    expect(WB_SHORT).toBe('0b1a719c5cb94c14901f5b98');
  });
});

describe('classifySandbox', () => {
  it.each([
    ['the current box', `talyn-wb-${WB_SHORT}-r5--3542ee`, {}, 'session', 'active'],
    ['the current box named by fleetSandboxId', `talyn-wb-${WB_SHORT}-r5--3542ee`, { sandboxId: null, fleetSandboxId: `talyn-wb-${WB_SHORT}-r5--3542ee` }, 'session', 'active'],
    ['a thread box', `talyn-wb-${WB_SHORT}-r5--3542ee`, { kind: 'thread' }, 'thread', 'active'],
    ['the box a move is creating', `talyn-wb-${WB_SHORT}-r6--3542ee`, { status: 'moving', moveSandboxId: `talyn-wb-${WB_SHORT}-r6` }, 'session', 'active'],
    ['an older generation after a move', `talyn-wb-${WB_SHORT}-r4--3542ee`, {}, 'session', 'superseded'],
    ['the box of an archived session', `talyn-wb-${WB_SHORT}-r5--3542ee`, { archivedAt: new Date('2026-11-01T00:00:00Z') }, 'session', 'superseded'],
    ['a box kept after a failed restore', `talyn-wb-${WB_SHORT}-r3--3542ee`, { keptSandboxIds: [`talyn-wb-${WB_SHORT}-r3--3542ee`] }, 'session', 'superseded'],
    ['a newer generation from a move that did not finish', `talyn-wb-${WB_SHORT}-r7--3542ee`, {}, 'session', 'superseded'],
  ] as const)('reads %s', (_label, id, over, kind, claim) => {
    const c = classifySandbox(id, claims({ workbenches: [wb(over)] }));
    expect(c.kind).toBe(kind);
    expect(c.claim).toBe(claim);
    expect(c.workbench?.id).toBe(WB_ID);
    if (claim === 'superseded') expect(c.supersededReason).toBeTruthy();
    else expect(c.supersededReason).toBeNull();
  });

  it('names the newer sandbox in the reason for a moved session', () => {
    const c = classifySandbox(`talyn-wb-${WB_SHORT}-r4--3542ee`, claims({ workbenches: [wb()] }));
    expect(c.supersededReason).toContain(`talyn-wb-${WB_SHORT}-r5`);
  });

  it('calls a session box with no row an orphan', () => {
    const c = classifySandbox(`talyn-wb-${WB_SHORT}-r5--3542ee`, claims());
    expect(c).toMatchObject({ kind: 'session', claim: 'orphan', workbench: null });
  });

  it('does not let a different workbench claim the box', () => {
    const other = wb({ id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', sandboxId: 'talyn-wb-ffffffffffffffffffffffff' });
    expect(classifySandbox(`talyn-wb-${WB_SHORT}--3542ee`, claims({ workbenches: [other] })).claim).toBe('orphan');
  });

  it.each([
    ['the current run', `talyn-${TASK_ID}`, {}, 'active'],
    ['the current retry', `talyn-${TASK_ID}-r2`, { remoteRunId: `talyn-${TASK_ID}-r2` }, 'active'],
    ['a run with no recorded id, on attempt zero', `talyn-${TASK_ID}`, { remoteRunId: null }, 'active'],
    ['an attempt the task retried past', `talyn-${TASK_ID}-r1`, { remoteRunId: `talyn-${TASK_ID}-r2` }, 'superseded'],
    ['an attempt newer than the recorded one', `talyn-${TASK_ID}-r3`, { remoteRunId: `talyn-${TASK_ID}-r2` }, 'superseded'],
  ] as const)('reads a task box: %s', (_label, id, over, claim) => {
    const c = classifySandbox(id, claims({ tasks: new Map([[TASK_ID, task(over)]]) }));
    expect(c.kind).toBe('task');
    expect(c.claim).toBe(claim);
    expect(c.task?.id).toBe(TASK_ID);
  });

  it('calls a task box with no task row an orphan', () => {
    expect(classifySandbox(`talyn-${TASK_ID}`, claims())).toMatchObject({ kind: 'task', claim: 'orphan' });
  });

  it.each([
    ['a running unit', { settled: false }, 'active'],
    ['a unit that has settled', { settled: true }, 'superseded'],
  ] as const)('reads a review box: %s', (_label, over, claim) => {
    const c = classifySandbox('talyn-rev-unit-1', claims({ reviews: new Map([['unit-1', review(over)]]) }));
    expect(c).toMatchObject({ kind: 'review', claim });
  });

  it('calls an id Talyn does not make an orphan of unknown kind', () => {
    expect(classifySandbox('deploy-api-1785848330', claims())).toMatchObject({ kind: 'unknown', claim: 'orphan' });
  });
});

function sandbox(over: Partial<FleetSandbox> & Record<string, unknown> = {}): FleetSandbox {
  return {
    id: `talyn-wb-${WB_SHORT}-r5--3542ee`,
    status: 'idle',
    createdAt: '2026-11-03T09:00:00.000Z',
    startedAt: '2026-11-03T09:00:05.000Z',
    memMib: 12288,
    memUsedMib: 3100,
    vcpuCount: 6,
    diskMib: 40960,
    ...over,
  } as FleetSandbox;
}

describe('sleepOf', () => {
  it.each([
    ['an awake box', { status: 'busy' }, null],
    ['an idle box', { status: 'idle' }, null],
    [
      'a box asleep on the host',
      { status: 'suspended', suspendKind: 'memory', suspendedAt: '2026-11-03T10:00:00Z' },
      { kind: 'local', since: '2026-11-03T10:00:00.000Z', suspendKind: 'memory', uploadError: null },
    ],
    [
      'a hibernated box',
      { status: 'suspended', suspendKind: 'rootfs', suspendUploaded: true, suspendedAt: '2026-11-03T10:00:00Z' },
      { kind: 'storage', since: '2026-11-03T10:00:00.000Z', suspendKind: 'rootfs', uploadError: null },
    ],
    [
      'a box whose upload failed',
      { status: 'suspended', suspendUploadError: 'bucket 503' },
      { kind: 'local', since: null, suspendKind: null, uploadError: 'bucket 503' },
    ],
  ] as const)('reads %s', (_label, over, expected) => {
    expect(sleepOf(sandbox(over as Partial<FleetSandbox>))).toEqual(expected);
  });
});

describe('applyClassification', () => {
  it('gives a session box its title, owner, workspace, repository, size and recorded host', () => {
    const row = applyClassification(
      adminRunFromFleet(sandbox(), null),
      classifySandbox(`talyn-wb-${WB_SHORT}-r5--3542ee`, claims({ workbenches: [wb()] })),
    );
    expect(row).toMatchObject({
      kind: 'session',
      claim: 'active',
      orphan: false,
      title: 'Fix the login flow',
      ownerEmail: 'owner@example.test',
      workspaceName: 'PostHog',
      repo: 'posthog/posthog',
      sandboxSize: 'large',
      host: 'hetzner-64',
      workbenchId: WB_ID,
      vcpuCount: 6,
      diskMib: 40960,
    });
  });

  it('prefers the host the fleet named over the recorded one', () => {
    // A sleeping box can wake on another host; the recorded host is where it was created.
    const row = applyClassification(
      adminRunFromFleet(sandbox(), 'scaleway-1'),
      classifySandbox(`talyn-wb-${WB_SHORT}-r5--3542ee`, claims({ workbenches: [wb()] })),
    );
    expect(row.host).toBe('scaleway-1');
  });

  it('gives a task box its task, owner and recorded host', () => {
    const row = applyClassification(
      adminRunFromFleet(sandbox({ id: `talyn-${TASK_ID}`, status: 'busy' }), null),
      classifySandbox(`talyn-${TASK_ID}`, claims({ tasks: new Map([[TASK_ID, task()]]) })),
    );
    expect(row).toMatchObject({ kind: 'task', taskId: TASK_ID, host: 'scaleway-1', title: 'Get posthog#1 mergeable' });
  });

  it('keeps an orphan an orphan, with no owner', () => {
    const row = applyClassification(
      adminRunFromFleet(sandbox(), 'hetzner-64'),
      classifySandbox(`talyn-wb-${WB_SHORT}-r5--3542ee`, claims()),
    );
    expect(row).toMatchObject({ claim: 'orphan', orphan: true, ownerEmail: null, host: 'hetzner-64' });
  });

  it('never carries the prompt', () => {
    const row = applyClassification(
      adminRunFromFleet(sandbox({ task: { repo: 'o/r' } }), null),
      classifySandbox(`talyn-wb-${WB_SHORT}-r5--3542ee`, claims({ workbenches: [wb()] })),
    );
    expect(JSON.stringify(row)).not.toContain('prompt');
  });
});

describe('runMatches', () => {
  const row = applyClassification(
    adminRunFromFleet(sandbox(), 'hetzner-64'),
    classifySandbox(`talyn-wb-${WB_SHORT}-r5--3542ee`, claims({ workbenches: [wb()] })),
  );
  const none = { host: '', status: '', kind: '', owner: '' };

  it.each([
    ['no filters', none, true],
    ['the right host', { ...none, host: 'hetzner-64' }, true],
    ['another host', { ...none, host: 'scaleway-1' }, false],
    ['the right kind', { ...none, kind: 'session' }, true],
    ['another kind', { ...none, kind: 'task' }, false],
    ['part of the owner email, any case', { ...none, owner: 'OWNER@' }, true],
    ['another owner', { ...none, owner: 'someone-else' }, false],
    ['the status word', { ...none, status: 'running' }, true],
    ['another status', { ...none, status: 'failed' }, false],
  ])('with %s', (_label, filters, expected) => {
    expect(runMatches(row, filters)).toBe(expected);
  });
});
