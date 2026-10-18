jest.mock('../renderer/lib/api', () => ({ ApiNetworkError: class extends Error {}, api: { workbenches: {} } }));

import type { WorkbenchLocalReadiness } from '@talyn/shared';
import { agentChoice, runtimeChoice } from '../renderer/lib/readiness';

const okSandbox = {
  ok: true,
  reasons: [],
  agents: { claude: { ok: true }, codex: { ok: true } },
};
const okLocal: WorkbenchLocalReadiness = {
  claude: { ok: true, path: '/bin/claude' },
  codex: { ok: false },
  pty: { ok: true },
  git: { ok: true, path: '/usr/bin/git' },
};

describe('agentChoice', () => {
  it('allows local when the agent and git exist', () => {
    expect(agentChoice({ sandbox: null, local: okLocal }, 'local', 'claude')).toEqual({ available: true });
  });
  it('refuses a missing agent CLI', () => {
    const choice = agentChoice({ sandbox: null, local: okLocal }, 'local', 'codex');
    expect(choice.available).toBe(false);
    expect(choice.reason).toMatch(/Codex/);
  });
  it('refuses without git', () => {
    const local = { ...okLocal, git: { ok: false } };
    expect(agentChoice({ sandbox: null, local }, 'local', 'claude').available).toBe(false);
  });
  it('treats a pty failure as a warning only', () => {
    const local = { ...okLocal, pty: { ok: false, error: 'NODE_MODULE_VERSION' } };
    const choice = agentChoice({ sandbox: null, local }, 'local', 'claude');
    expect(choice.available).toBe(true);
    expect(choice.warning).toMatch(/NODE_MODULE_VERSION/);
  });
  it('refuses local without the bridge', () => {
    expect(agentChoice({ sandbox: null, local: null }, 'local', 'claude').available).toBe(false);
  });
  it('uses the sandbox reasons', () => {
    const sandbox = { ok: false, reasons: [{ code: 'flag_off', message: 'Off' }], agents: okSandbox.agents };
    expect(agentChoice({ sandbox, local: null }, 'sandbox', 'claude')).toEqual({ available: false, reason: 'Off' });
  });
  it('uses the per-agent sandbox reason', () => {
    const sandbox = {
      ...okSandbox,
      agents: { ...okSandbox.agents, codex: { ok: false, reason: { code: 'agent_not_connected', message: 'Connect Codex' } } },
    };
    expect(agentChoice({ sandbox, local: null }, 'sandbox', 'codex').reason).toBe('Connect Codex');
    expect(agentChoice({ sandbox, local: null }, 'sandbox', 'claude').available).toBe(true);
  });
  it('is unavailable while the sandbox answer is pending', () => {
    expect(agentChoice({ sandbox: null, local: null }, 'sandbox', 'claude').available).toBe(false);
  });
});

describe('runtimeChoice', () => {
  it('is available when any agent works', () => {
    const result = runtimeChoice({ sandbox: okSandbox, local: okLocal });
    expect(result.sandbox.available).toBe(true);
    expect(result.local.available).toBe(true);
  });
  it('reports why neither works', () => {
    const result = runtimeChoice({
      sandbox: { ok: false, reasons: [{ code: 'unreachable', message: 'Down' }], agents: okSandbox.agents },
      local: { ...okLocal, claude: { ok: false } },
    });
    expect(result.sandbox).toEqual({ available: false, reason: 'Down' });
    expect(result.local.available).toBe(false);
    expect(result.local.reason).toBeTruthy();
  });
});
