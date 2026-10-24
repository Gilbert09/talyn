import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/api', () => ({ ApiNetworkError: class extends Error {}, api: { workbenches: {} } }));

import { agentChoice, isUnreachable, sandboxChoice } from '../lib/readiness';

const okSandbox = {
  ok: true,
  reasons: [],
  agents: { claude: { ok: true }, codex: { ok: true } },
};

describe('agentChoice', () => {
  it('allows an agent when the sandbox is ready', () => {
    expect(agentChoice({ sandbox: okSandbox }, 'claude')).toEqual({ available: true });
    expect(agentChoice({ sandbox: okSandbox }, 'codex')).toEqual({ available: true });
  });
  it('uses the sandbox reasons', () => {
    const sandbox = { ok: false, reasons: [{ code: 'flag_off', message: 'Off' }], agents: okSandbox.agents };
    expect(agentChoice({ sandbox }, 'claude')).toEqual({ available: false, reason: 'Off' });
  });
  it('falls back to a generic reason when the sandbox gives none', () => {
    const sandbox = { ok: false, reasons: [], agents: okSandbox.agents };
    expect(agentChoice({ sandbox }, 'claude')).toEqual({ available: false, reason: 'Cloud sessions are unavailable' });
  });
  it('uses the per-agent sandbox reason', () => {
    const sandbox = {
      ...okSandbox,
      agents: { ...okSandbox.agents, codex: { ok: false, reason: { code: 'agent_not_connected', message: 'Connect Codex' } } },
    };
    expect(agentChoice({ sandbox }, 'codex').reason).toBe('Connect Codex');
    expect(agentChoice({ sandbox }, 'claude').available).toBe(true);
  });
  it('names the agent when its reason has no message', () => {
    const sandbox = { ...okSandbox, agents: { ...okSandbox.agents, codex: { ok: false } } };
    expect(agentChoice({ sandbox }, 'codex').reason).toBe('Codex is not connected');
  });
  it('is unavailable while the sandbox answer is pending', () => {
    expect(agentChoice({ sandbox: null }, 'claude')).toEqual({ available: false, reason: 'Checking cloud availability' });
  });
});

describe('sandboxChoice', () => {
  it('is available when any agent works', () => {
    const sandbox = { ...okSandbox, agents: { claude: { ok: false }, codex: { ok: true } } };
    expect(sandboxChoice({ sandbox }).available).toBe(true);
  });
  it('reports why no agent works', () => {
    const sandbox = { ok: false, reasons: [{ code: 'unreachable', message: 'Down' }], agents: okSandbox.agents };
    expect(sandboxChoice({ sandbox })).toEqual({ available: false, reason: 'Down' });
  });
});

describe('isUnreachable', () => {
  it.each([
    [null, false],
    [okSandbox, false],
    [{ ok: false, reasons: [{ code: 'unreachable', message: 'Down' }], agents: okSandbox.agents }, true],
    [{ ok: false, reasons: [{ code: 'flag_off', message: 'Off' }], agents: okSandbox.agents }, false],
  ])('%j → %s', (sandbox, expected) => {
    expect(isUnreachable(sandbox)).toBe(expected);
  });
});
