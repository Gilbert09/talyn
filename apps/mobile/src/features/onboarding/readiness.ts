import type { WorkbenchAgent, WorkbenchReadiness } from '@talyn/shared';

/** The fix a sign-in gives: connect the agent, or sign in to it again. */
export type ReadinessFix = 'connect' | 'reauth';

export interface ReadinessRow {
  key: 'sandbox' | WorkbenchAgent;
  label: string;
  state: 'loading' | 'ready' | 'blocked';
  detail: string;
  fix: ReadinessFix | null;
}

const AGENT_NAMES: Record<WorkbenchAgent, string> = { claude: 'Claude Code', codex: 'Codex' };
const AGENTS: WorkbenchAgent[] = ['claude', 'codex'];
const FIXES: Record<string, ReadinessFix> = { agent_not_connected: 'connect', agent_reauth_required: 'reauth' };

interface Choice { available: boolean; reason?: string; fix: ReadinessFix | null }

/** Mirrors web `agentChoice`: a sandbox problem first, then the agent's own. */
export function agentChoice(readiness: WorkbenchReadiness, agent: WorkbenchAgent): Choice {
  const { sandbox } = readiness;
  if (!sandbox.ok) return { available: false, reason: sandbox.reasons[0]?.message ?? 'Cloud sessions are unavailable', fix: null };
  const entry = sandbox.agents?.[agent];
  if (entry && !entry.ok) {
    return { available: false, reason: entry.reason?.message ?? `${AGENT_NAMES[agent]} is not connected`,
      fix: entry.reason ? FIXES[entry.reason.code] ?? null : null };
  }
  return { available: true, fix: null };
}

/**
 * Web's Welcome checklist: whether a session can start at all, then each
 * agent, each with the fix a person can make from the phone.
 */
export function readinessRows(readiness: WorkbenchReadiness | undefined): ReadinessRow[] {
  if (!readiness) {
    const keys: ReadinessRow['key'][] = ['sandbox', ...AGENTS];
    return keys.map((key) => ({ key, label: key === 'sandbox' ? 'Sandbox' : AGENT_NAMES[key], state: 'loading', detail: 'Checking', fix: null }));
  }
  const agents = AGENTS.map((agent) => ({ agent, choice: agentChoice(readiness, agent) }));
  const first = agents.find((item) => item.choice.available);
  const sandbox: ReadinessRow = first
    ? { key: 'sandbox', label: 'Sandbox', state: 'ready', detail: 'Ready', fix: null }
    // Each agent row carries its own fix, so the sandbox row carries none.
    : { key: 'sandbox', label: 'Sandbox', state: 'blocked', detail: agents[0].choice.reason ?? 'Cloud sessions are unavailable', fix: null };
  return [sandbox, ...agents.map(({ agent, choice }): ReadinessRow => ({
    key: agent, label: AGENT_NAMES[agent], state: choice.available ? 'ready' : 'blocked',
    detail: choice.available ? 'Ready' : choice.reason ?? 'Not available', fix: choice.fix,
  }))];
}

/**
 * Nothing set up yet: no agent can run and the only blockers are connections a
 * person makes. A sandbox outage is not this: the composer shows that itself.
 */
export function nothingConnected(readiness: WorkbenchReadiness | undefined): boolean {
  if (!readiness?.sandbox.ok) return false;
  const entries = AGENTS.map((agent) => readiness.sandbox.agents?.[agent]);
  return entries.every((entry) => entry && !entry.ok && entry.reason?.code === 'agent_not_connected');
}
