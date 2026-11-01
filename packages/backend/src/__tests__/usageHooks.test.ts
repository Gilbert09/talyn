import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxSize, UsageSubjectKind } from '@talyn/shared';

const { openInterval, closeInterval, ownerOfWorkspace } = vi.hoisted(() => ({
  openInterval: vi.fn(),
  closeInterval: vi.fn(),
  ownerOfWorkspace: vi.fn(),
}));

vi.mock('../services/billing/usage/index.js', () => ({ openInterval, closeInterval }));
vi.mock('../services/workflows/owner.js', () => ({ ownerOfWorkspace }));
vi.mock('../services/mcpServersAccess.js', () => ({ workspaceMayUseMcpServers: async () => false }));

const { meterBoxClosed, meterBoxOpened, resetUsageHookCacheForTests } = await import('../services/billing/usageHooks.js');
const { debugBus } = await import('../services/debugBus.js');
const {
  FleetClient,
  FleetDispatchUncertainError,
  FleetThrottleError,
  TALYN_SANDBOX_IDLE_TTL_SEC,
  fleetInstant,
  isIdleTtlCeilingRefusal,
} = await import('../services/selfHosted/client.js');
const { buildSandboxCreateBody, createSandboxRetryingUncertain } = await import('../services/selfHosted/sandboxRun.js');
const { workbenchBoxSize } = await import('../services/workbenches/usageMeter.js');

beforeEach(() => {
  resetUsageHookCacheForTests();
  openInterval.mockReset().mockResolvedValue(undefined);
  closeInterval.mockReset().mockResolvedValue(undefined);
  ownerOfWorkspace.mockReset().mockResolvedValue('owner-1');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('meterBoxOpened', () => {
  it.each<[UsageSubjectKind, SandboxSize]>([
    ['task', 'small'],
    ['task', 'standard'],
    ['review_unit', 'small'],
    ['workbench', 'medium'],
    ['workbench', 'large'],
    ['workbench', 'xlarge'],
  ])('opens a %s interval at %s for the workspace owner', async (subjectKind, size) => {
    await meterBoxOpened({ workspaceId: 'ws', subjectKind, subjectId: 'sub', sandboxId: 'box', size });
    expect(openInterval).toHaveBeenCalledTimes(1);
    expect(openInterval).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      workspaceId: 'ws',
      subjectKind,
      subjectId: 'sub',
      sandboxId: 'box',
      size,
    });
  });

  it('passes the start time through when the caller knows it', async () => {
    const startedAt = new Date('2026-11-01T10:00:00Z');
    await meterBoxOpened({ workspaceId: 'ws', subjectKind: 'task', subjectId: 't', sandboxId: 'box', size: 'small', startedAt });
    expect(openInterval.mock.calls[0][0]).toMatchObject({ startedAt });
  });

  it('uses a known owner without reading the workspace', async () => {
    await meterBoxOpened({ workspaceId: 'ws', ownerId: 'given', subjectKind: 'task', subjectId: 't', sandboxId: 'box', size: 'small' });
    expect(ownerOfWorkspace).not.toHaveBeenCalled();
    expect(openInterval.mock.calls[0][0]).toMatchObject({ ownerId: 'given' });
  });

  it('reads the owner of a workspace once', async () => {
    for (const sandboxId of ['a', 'b', 'c']) {
      await meterBoxOpened({ workspaceId: 'ws', subjectKind: 'task', subjectId: 't', sandboxId, size: 'small' });
    }
    expect(ownerOfWorkspace).toHaveBeenCalledTimes(1);
    expect(openInterval).toHaveBeenCalledTimes(3);
  });

  it.each<[string, () => void]>([
    ['the ledger throws', () => openInterval.mockRejectedValue(new Error('ledger down'))],
    ['the owner read throws', () => ownerOfWorkspace.mockRejectedValue(new Error('db down'))],
    ['the workspace has no owner', () => ownerOfWorkspace.mockResolvedValue(null)],
  ])('never throws when %s, and reports it on the debug bus', async (_label, arrange) => {
    arrange();
    const record = vi.spyOn(debugBus, 'recordEvent');
    await expect(
      meterBoxOpened({ workspaceId: 'ws', subjectKind: 'task', subjectId: 't', sandboxId: 'box', size: 'small' }),
    ).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'usage-meter', action: 'meter_open', ok: false, meta: { sandboxId: 'box' } }),
    );
  });
});

describe('meterBoxClosed', () => {
  it.each(['terminal', 'suspended', 'deleted', 'vanished', 'exhausted', 'sweep'] as const)(
    'closes with reason %s at the given end time',
    async (reason) => {
      const endedAt = new Date('2026-11-01T11:00:00Z');
      await meterBoxClosed({ sandboxId: 'box', reason, endedAt });
      expect(closeInterval).toHaveBeenCalledWith('box', endedAt, reason);
    },
  );

  it.each([undefined, null])('closes at now when the end time is %s', async (endedAt) => {
    const before = Date.now();
    await meterBoxClosed({ sandboxId: 'box', reason: 'deleted', endedAt });
    const at = closeInterval.mock.calls[0][1] as Date;
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
    expect(at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('never throws when the ledger fails', async () => {
    closeInterval.mockRejectedValue(new Error('ledger down'));
    const record = vi.spyOn(debugBus, 'recordEvent');
    await expect(meterBoxClosed({ sandboxId: 'box', reason: 'terminal' })).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'meter_close', ok: false }));
  });
});

describe('fleetInstant', () => {
  it.each<[string | null | undefined, string | null]>([
    [undefined, null],
    [null, null],
    ['', null],
    ['0001-01-01T00:00:00Z', null],
    ['not a date', null],
    ['1999-12-31T23:59:59Z', null],
    ['2026-11-01T10:00:00Z', '2026-11-01T10:00:00.000Z'],
    ['2026-11-01T10:00:00.123456789+01:00', '2026-11-01T09:00:00.123Z'],
  ])('reads %j as %j', (value, expected) => {
    expect(fleetInstant(value)?.toISOString() ?? null).toBe(expected);
  });
});

describe('the 10-minute idle timeout', () => {
  it('is 600 seconds', () => {
    expect(TALYN_SANDBOX_IDLE_TTL_SEC).toBe(600);
  });

  it.each<[string, Error, boolean]>([
    [
      'the tenant ceiling',
      new FleetThrottleError('an idle timeout of 600s was asked for and this account allows at most 300s; ask for that or less, or omit idleTtlSec to take the default'),
      true,
    ],
    ['the resource code', new FleetThrottleError('tenant_idle_ttl'), true],
    ['a memory refusal', new FleetThrottleError('tenant_memory: exceeds the 10240 MiB permitted'), false],
    ['a rate limit', new FleetThrottleError('rate limited'), false],
    ['another error', new Error('idleTtlSec bad'), false],
  ])('knows %s refusal: %s', (_label, err, expected) => {
    expect(isIdleTtlCeilingRefusal(err)).toBe(expected);
  });

  const creds = { claudeToken: 'sk-ant', openaiKey: 'sk-oa' };
  it.each([
    ['a task dispatch', { ephemeral: true, task: { taskType: 'code_writing', prompt: 'p' } }],
    ['a bare session box', { repo: 'a/b', baseBranch: 'main' }],
    ['a thread box', {}],
  ])('goes on the create body of %s', async (_label, extra) => {
    const built = await buildSandboxCreateBody({
      id: 'box',
      workspaceId: 'ws',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      creds,
      githubToken: 'gh',
      mcpServerIds: null,
      ...extra,
    });
    expect(built.ok && built.body.idleTtlSec).toBe(600);
  });

  it('is dropped once when the tenant ceiling is lower, and the create goes on', async () => {
    const createSandbox = vi
      .fn()
      .mockRejectedValueOnce(new FleetThrottleError('tenant_idle_ttl: allows at most 300s'))
      .mockResolvedValue({ sandbox: { id: 'box' } });
    const client = { createSandbox } as unknown as InstanceType<typeof FleetClient>;
    await createSandboxRetryingUncertain(client, { id: 'box', workspaceId: 'ws', idleTtlSec: 600 });
    expect(createSandbox).toHaveBeenCalledTimes(2);
    expect(createSandbox.mock.calls[0][0]).toMatchObject({ idleTtlSec: 600 });
    expect(createSandbox.mock.calls[1][0]).not.toHaveProperty('idleTtlSec');
  });

  it('still retries an uncertain dispatch with the same body', async () => {
    vi.useFakeTimers();
    try {
      const createSandbox = vi
        .fn()
        .mockRejectedValueOnce(new FleetDispatchUncertainError('lost'))
        .mockResolvedValue({ sandbox: { id: 'box' } });
      const client = { createSandbox } as unknown as InstanceType<typeof FleetClient>;
      const done = createSandboxRetryingUncertain(client, { id: 'box', workspaceId: 'ws', idleTtlSec: 600 });
      await vi.runAllTimersAsync();
      await done;
      expect(createSandbox.mock.calls.map((c) => c[0].idleTtlSec)).toEqual([600, 600]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['a rate limit', new FleetThrottleError('rate limited')],
    ['a size refusal', new FleetThrottleError('tenant_memory: exceeds the 10240 MiB permitted')],
  ])('does not drop it for %s', async (_label, err) => {
    const createSandbox = vi.fn().mockRejectedValue(err);
    const client = { createSandbox } as unknown as InstanceType<typeof FleetClient>;
    await expect(createSandboxRetryingUncertain(client, { id: 'box', workspaceId: 'ws', idleTtlSec: 600 })).rejects.toBe(err);
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });

  it('goes on a resume, so an older box moves to it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await new FleetClient('https://fleet.test', 'token').resumeSandbox('box');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://fleet.test/v1/sandboxes/box/resume');
    expect(JSON.parse(String(init.body))).toEqual({ idleTtlSec: 600 });
  });

  it('resumes with no idle timeout when the tenant ceiling is lower', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'quota_exceeded', message: 'tenant_idle_ttl: allows at most 300s' }), { status: 429 }),
      )
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await new FleetClient('https://fleet.test', 'token').resumeSandbox('box');
    expect(fetchSpy.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)))).toEqual([{ idleTtlSec: 600 }, {}]);
  });
});

describe('workbenchBoxSize', () => {
  it.each<[string, { kind: string; settings: Record<string, unknown> }, Record<string, number> | null, SandboxSize]>([
    ['the recorded size', { kind: 'session', settings: { boxSize: 'large', sandboxSize: 'medium' } }, { memMib: 4096, milliVcpu: 2000 }, 'large'],
    ['the fleet: small by its CPU', { kind: 'session', settings: {} }, { memMib: 4096, milliVcpu: 2000 }, 'small'],
    ['the fleet: standard by its CPU', { kind: 'session', settings: {} }, { memMib: 4096, milliVcpu: 4000 }, 'standard'],
    ['the fleet: small by its vCPU count', { kind: 'session', settings: {} }, { memMib: 4096, vcpuCount: 2 }, 'small'],
    ['the fleet: medium', { kind: 'session', settings: {} }, { memMib: 8192, milliVcpu: 4000 }, 'medium'],
    ['the session choice when the fleet is unknown', { kind: 'session', settings: { sandboxSize: 'medium' } }, { memMib: 2048 }, 'medium'],
    ['a thread', { kind: 'thread', settings: {} }, null, 'small'],
    ['standard when nothing is known', { kind: 'session', settings: { boxSize: 'huge' } }, null, 'standard'],
  ])('reads %s', (_label, row, sandbox, expected) => {
    expect(workbenchBoxSize(row as never, sandbox)).toBe(expected);
  });
});
