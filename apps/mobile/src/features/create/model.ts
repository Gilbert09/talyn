import type { WatchedRepo } from '@talyn/client/native';
import { defaultFleetModelForAgent, FLEET_MODELS, storedFleetModelForAgent, type CreateWorkbenchInput, type WorkbenchAgent,
  type WorkbenchReadiness, type WorkspaceSettings } from '@talyn/shared';

export type NewWorkMode = 'session' | 'thread';
export const AGENTS: readonly WorkbenchAgent[] = ['claude', 'codex'];
export const AGENT_NAMES: Record<WorkbenchAgent, string> = { claude: 'Claude Code', codex: 'Codex' };

export interface Choice {
  available: boolean;
  reason?: string;
  /** The fix is a sign-in in Settings on the web. */
  connect?: 'connect' | 'reauth';
}
type Sandbox = WorkbenchReadiness['sandbox'];

const CONNECT_CODES: Record<string, Choice['connect']> = { agent_not_connected: 'connect', agent_reauth_required: 'reauth' };

/** Whether `agent` can start a session. Mirrors web `agentChoice`. */
export function agentChoice(sandbox: Sandbox | null | undefined, agent: WorkbenchAgent): Choice {
  if (!sandbox) return { available: false, reason: 'Checking cloud availability' };
  if (!sandbox.ok) return { available: false, reason: sandbox.reasons[0]?.message ?? 'Cloud sessions are unavailable' };
  const entry = sandbox.agents?.[agent];
  if (entry && !entry.ok) {
    const connect = entry.reason ? CONNECT_CODES[entry.reason.code] : undefined;
    return { available: false, reason: entry.reason?.message ?? `${AGENT_NAMES[agent]} is not connected`, ...(connect ? { connect } : {}) };
  }
  return { available: true };
}

/** Whether a session can start at all: the first agent that can run, or why none can. */
export function sandboxChoice(sandbox: Sandbox | null | undefined): Choice {
  const choices = AGENTS.map((agent) => agentChoice(sandbox, agent));
  return choices.find((choice) => choice.available) ?? { available: false, reason: choices[0]?.reason, connect: choices.find((c) => c.connect)?.connect };
}

/** The agent to use: the wanted one when it can run, else the first that can. */
export function usableAgent(sandbox: Sandbox | null | undefined, wanted: WorkbenchAgent): WorkbenchAgent {
  if (agentChoice(sandbox, wanted).available) return wanted;
  return AGENTS.find((agent) => agentChoice(sandbox, agent).available) ?? wanted;
}

/** The workspace's model for the agent, or the shipped default. */
export function modelFor(settings: WorkspaceSettings | null | undefined, agent: WorkbenchAgent): string {
  return storedFleetModelForAgent(settings, agent) ?? defaultFleetModelForAgent(agent);
}
export function modelsFor(agent: WorkbenchAgent) {
  return FLEET_MODELS.filter((model) => model.provider === (agent === 'codex' ? 'openai' : 'anthropic'));
}
export function modelLabel(id: string): string {
  return FLEET_MODELS.find((model) => model.id === id)?.label ?? id;
}

// The last repository chosen per workspace, for this app run.
const lastRepository = new Map<string, string>();
export function rememberRepository(workspaceId: string, repositoryId: string) { lastRepository.set(workspaceId, repositoryId); }
/** The last repository when it is still watched, else the first one. */
export function defaultRepositoryId(workspaceId: string, repositories: ReadonlyArray<Pick<WatchedRepo, 'id'>>): string {
  const last = lastRepository.get(workspaceId);
  if (last && repositories.some((repo) => repo.id === last)) return last;
  return repositories[0]?.id ?? '';
}

export interface NewWorkForm {
  mode: NewWorkMode;
  prompt: string;
  repository: Pick<WatchedRepo, 'id' | 'fullName'> | null;
  agent: WorkbenchAgent;
  model: string;
  baseBranch: string;
  internetAccess: boolean;
}

/**
 * Why Start is off, or null when it can start. Same order as web: the
 * repository, then the sandbox, then the agent. The prompt and the connection
 * come last because they are the person's to fix.
 */
export function blockedReason(form: NewWorkForm, sandbox: Sandbox | null | undefined, offline: boolean): string | null {
  if (form.mode === 'session' && !form.repository) return 'Choose a repository.';
  const sandboxOk = sandboxChoice(sandbox);
  if (!sandboxOk.available) return sandboxOk.reason ?? 'Cloud sessions are unavailable';
  const agentOk = agentChoice(sandbox, form.agent);
  if (!agentOk.available) return agentOk.reason ?? `${AGENT_NAMES[form.agent]} is not connected`;
  if (offline) return 'You are offline.';
  if (!form.prompt.trim()) return form.mode === 'thread' ? 'Describe what you want to get done.' : 'Describe a task.';
  return null;
}

/** The create request, like web `createWorkbench` without attachments. */
export function createInput(form: NewWorkForm, workspaceId: string): CreateWorkbenchInput {
  const prompt = form.prompt.trim() || undefined;
  if (form.mode === 'thread') {
    return { workspaceId, kind: 'thread', runtime: 'sandbox', agent: form.agent, model: form.model, prompt, internetAccess: form.internetAccess };
  }
  if (!form.repository) throw new Error('Choose a repository.');
  return { workspaceId, repositoryId: form.repository.id, runtime: 'sandbox', agent: form.agent, model: form.model,
    baseBranch: form.baseBranch.trim() || undefined, prompt, internetAccess: form.internetAccess, autoCreatePr: true };
}
