import type { WatchedRepo } from '@talyn/client/native';
import { defaultFleetModelForAgent, FLEET_MODELS, storedFleetModelForAgent, type CreateWorkbenchInput, type WorkbenchAgent,
  type WorkbenchReadiness, type WorkspaceSettings } from '@talyn/shared';

import { modelLabel as labelForModel } from '../../lib/models';

export type NewWorkMode = 'session' | 'thread';
export const AGENTS: readonly WorkbenchAgent[] = ['claude', 'codex'];
export const AGENT_NAMES: Record<WorkbenchAgent, string> = { claude: 'Claude Code', codex: 'Codex' };

export interface Choice {
  available: boolean;
  reason?: string;
  /** The fix is a sign-in, which the connect sheet does. */
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

interface RepositoryStorage { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> }
/** The device key for the last repository a person started in a workspace or space. */
export const lastRepositoryKey = (user: string, place: string) => `talyn.new-work-repo.${encodeURIComponent(user)}.${encodeURIComponent(place)}`;

function repositoryStorage(): RepositoryStorage | null {
  try {
    // Loaded on first use, so tests without the native module still run.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require('@react-native-async-storage/async-storage') as { default?: RepositoryStorage };
    return module.default ?? null;
  } catch {
    return null;
  }
}

// The last repository started, by `lastRepositoryKey`. The device keeps it between app runs; this map is the run's copy.
const lastRepository = new Map<string, string>();
export function rememberRepository(key: string, repositoryId: string) {
  lastRepository.set(key, repositoryId);
  void repositoryStorage()?.setItem(key, repositoryId).catch(() => {});
}
/** The saved last repository for `key`, read from the device once per app run. */
export async function loadLastRepository(key: string): Promise<string | null> {
  const known = lastRepository.get(key);
  if (known) return known;
  const saved = await repositoryStorage()?.getItem(key).catch(() => null);
  // A start during the read wins over the older saved value.
  if (saved && !lastRepository.has(key)) lastRepository.set(key, saved);
  return lastRepository.get(key) ?? null;
}
/** Forget the run's copy. For tests. */
export function forgetLastRepositories() { lastRepository.clear(); }
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

/**
 * The create request, like web `createWorkbench`. With images, the first
 * message goes after the create, so the create has no prompt. The text still
 * names the session, its branch and its chat.
 */
export function createInput(form: NewWorkForm, workspaceId: string, withImages = false): CreateWorkbenchInput {
  const text = form.prompt.trim() || undefined;
  const prompt = withImages ? undefined : text;
  const namingText = withImages ? text : undefined;
  if (form.mode === 'thread') {
    return { workspaceId, kind: 'thread', runtime: 'sandbox', agent: form.agent, model: form.model, prompt, namingText, internetAccess: form.internetAccess };
  }
  if (!form.repository) throw new Error('Choose a repository.');
  return { workspaceId, repositoryId: form.repository.id, runtime: 'sandbox', agent: form.agent, model: form.model,
    baseBranch: form.baseBranch.trim() || undefined, prompt, namingText, internetAccess: form.internetAccess, autoCreatePr: true };
}

// ---------------------------------------------------------------------------
// Composer controls
// ---------------------------------------------------------------------------

export const MODES: ReadonlyArray<{ value: NewWorkMode; label: string; detail: string }> = [
  { value: 'session', label: 'Session', detail: 'Works on one repository on a new branch, and can open a pull request.' },
  { value: 'thread', label: 'Thread', detail: 'Starts a thread. It can work across repositories.' },
];
export const PLACEHOLDER: Record<NewWorkMode, string> = {
  session: 'Describe a task',
  thread: 'What do you want to get done?',
};
const MODE_LABEL: Record<NewWorkMode, string> = { session: 'Session', thread: 'Thread' };
const AGENT_SHORT: Record<WorkbenchAgent, string> = { claude: 'Claude', codex: 'Codex' };

/** The branch the session starts from: the typed one, else the repository's default. */
export function effectiveBranch(baseBranch: string, repository: Pick<WatchedRepo, 'defaultBranch'> | null | undefined): string {
  return baseBranch.trim() || repository?.defaultBranch || 'main';
}

export type ComposerChip = 'mode' | 'repository' | 'branch' | 'internet' | 'model';

/**
 * The context row above the composer, and the controls inside it. A thread
 * has no repository, so its context row keeps only internet access. A space
 * session takes no base branch, like web.
 */
export function composerChips(mode: NewWorkMode, repository: unknown, inSpace = false): { context: ComposerChip[]; card: ComposerChip[] } {
  const context: ComposerChip[] = mode === 'thread' ? ['internet'] : repository && !inSpace ? ['repository', 'branch', 'internet'] : ['repository', 'internet'];
  return { context, card: ['mode', 'model'] };
}

export interface ChipState {
  mode: NewWorkMode;
  repository: Pick<WatchedRepo, 'fullName'> | null;
  /** True while the repository list is still loading. */
  repositoriesLoading?: boolean;
  branch: string;
  internetAccess: boolean;
  agent: WorkbenchAgent;
  model: string;
}

/** What a chip shows, and what a screen reader says for it. */
export function chipLabel(chip: ComposerChip, state: ChipState): { text: string; accessibilityLabel: string } {
  switch (chip) {
    case 'mode': return { text: MODE_LABEL[state.mode], accessibilityLabel: `Start a ${state.mode}. Change what to start` };
    case 'repository': {
      if (state.repository) return { text: state.repository.fullName,
        accessibilityLabel: `Repository: ${state.repository.fullName}. Change repository` };
      const text = state.repositoriesLoading ? 'Loading' : 'Repository';
      return { text, accessibilityLabel: state.repositoriesLoading ? 'Repositories are loading' : 'Repository: none. Choose a repository' };
    }
    case 'branch': return { text: state.branch, accessibilityLabel: `Base branch: ${state.branch}. Change base branch` };
    case 'internet': return { text: state.internetAccess ? 'Internet on' : 'Internet off', accessibilityLabel: 'Internet access' };
    case 'model': {
      const label = labelForModel(state.model, state.agent);
      return { text: label, accessibilityLabel: `Model: ${label}, ${AGENT_SHORT[state.agent]}. Change model` };
    }
  }
}

/** The announcement after the internet chip is pressed. */
export function internetMessage(on: boolean): string {
  return on ? 'Internet access on.' : 'Internet access off. The agent can reach the repository only.';
}

/** Whether Send works, and the hint a screen reader gives when it does not. */
export function sendState(blocked: string | null, busy: boolean, workspaceId: string): { enabled: boolean; hint?: string } {
  if (busy) return { enabled: false, hint: 'Starting.' };
  if (!workspaceId) return { enabled: false, hint: 'Choose a workspace.' };
  if (blocked) return { enabled: false, hint: blocked };
  return { enabled: true };
}

/** The agent whose models include `modelId`, or null for an id outside the catalogue. */
export function agentForModel(modelId: string): WorkbenchAgent | null {
  const model = FLEET_MODELS.find((item) => item.id === modelId);
  if (!model) return null;
  return model.provider === 'openai' ? 'codex' : 'claude';
}

export interface ModelSection {
  agent: WorkbenchAgent;
  title: string;
  models: ReturnType<typeof modelsFor>;
  /** Why the agent cannot run, in web's words. Its models are not offered then. */
  note?: string;
  connect?: Choice['connect'];
}

/**
 * The model sheet: one section per agent that can run, plus the current one.
 * An agent that needs a sign-in gets web's "not connected" sentence instead of
 * its models, so its models look locked rather than missing.
 */
export function modelSections(sandbox: Sandbox | null | undefined, current: WorkbenchAgent): ModelSection[] {
  return AGENTS.flatMap((agent): ModelSection[] => {
    const choice = agentChoice(sandbox, agent);
    const name = AGENT_SHORT[agent];
    if (choice.available || agent === current) return [{ agent, title: AGENT_NAMES[agent], models: modelsFor(agent) }];
    if (!choice.connect) return [];
    const note = choice.connect === 'reauth'
      ? `The ${name} sign-in for this workspace has expired, so ${name} models cannot run.`
      : `${name} is not connected to this workspace, so ${name} models cannot run.`;
    return [{ agent, title: AGENT_NAMES[agent], models: [], note, connect: choice.connect }];
  });
}

/** The label of a section's connect action in the model sheet. */
export const CONNECT_ACTION: Record<NonNullable<Choice['connect']>, string> = { connect: 'Connect', reauth: 'Sign in again' };

export interface ConnectNotice { agent: WorkbenchAgent; kind: NonNullable<Choice['connect']>; message: string; action: string }

/**
 * The composer's notice when the agent needs a sign-in, with the action that
 * opens the connect sheet. Null when the agent can run or the fix is not a
 * sign-in, such as a sandbox outage.
 */
export function connectNotice(sandbox: Sandbox | null | undefined, agent: WorkbenchAgent): ConnectNotice | null {
  const choice = agentChoice(sandbox, agent);
  if (!choice.connect) return null;
  const name = AGENT_SHORT[agent];
  if (choice.connect === 'reauth') {
    return { agent, kind: 'reauth', message: `The ${name} sign-in has expired. Sign in again to start.`, action: 'Sign in' };
  }
  const subscription = agent === 'codex' ? 'ChatGPT' : 'Claude';
  return { agent, kind: 'connect', message: `${name} is not connected. Connect your ${subscription} subscription to start.`, action: 'Connect' };
}

/** Repositories whose name contains the query, in the workspace's order. */
export function filterRepositories<T extends Pick<WatchedRepo, 'fullName'>>(repositories: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  return needle ? repositories.filter((repo) => repo.fullName.toLowerCase().includes(needle)) : [...repositories];
}

interface BranchRow { state: string; repositoryId: string; authored?: boolean; number: number; summary: { baseBranch?: string } }

/**
 * Branches to offer, like web: the default branch, then the base branches of
 * the repository's open pull requests, own pull requests first.
 */
export function branchSuggestions(repository: Pick<WatchedRepo, 'id' | 'defaultBranch'> | null, rows: readonly BranchRow[] = []): string[] {
  if (!repository) return [];
  const prs = rows.filter((row) => row.state === 'open' && row.repositoryId === repository.id)
    .sort((a, b) => Number(Boolean(b.authored)) - Number(Boolean(a.authored)) || b.number - a.number);
  return [...new Set([repository.defaultBranch, ...prs.map((row) => row.summary.baseBranch ?? '')].filter(Boolean))];
}

/** Suggestions that contain what is typed. Typing the default name shows them all. */
export function filterBranches(suggestions: readonly string[], typed: string): string[] {
  const needle = typed.trim().toLowerCase();
  if (!needle) return [...suggestions];
  return suggestions.filter((branch) => branch.toLowerCase().includes(needle));
}
