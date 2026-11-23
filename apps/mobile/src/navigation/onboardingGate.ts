import type { WorkbenchReadiness, WorkspaceIntegrations } from '@talyn/shared';

import type { LoadState } from '../workflow/model';

/**
 * `notifications` is optional and comes last. The gate never opens it: a
 * restart after the agent step goes home, and Settings can turn alerts on.
 */
export type OnboardingStep = 'github' | 'repos' | 'agent' | 'notifications';
export type OnboardingGate = 'loading' | OnboardingStep | 'done';

export const ONBOARDING_STEPS: readonly OnboardingStep[] = ['github', 'repos', 'agent', 'notifications'];

interface Loaded<T> { status: LoadState; data?: T }

export interface OnboardingGateInput {
  /** The selected workspace. Its GitHub connection is the evidence of setup. */
  workspace: Loaded<{ integrations?: Partial<WorkspaceIntegrations> | null }>;
  repositories: Loaded<readonly unknown[]>;
  readiness: Loaded<WorkbenchReadiness>;
  /** Onboarding started on this device and was not finished or skipped. Undefined while it loads. */
  inProgress: boolean | undefined;
}

const pending = (status: LoadState) => status === 'idle' || status === 'loading';

/** True when at least one agent can start a session now. */
export function agentReady(readiness: WorkbenchReadiness | undefined): boolean {
  const sandbox = readiness?.sandbox;
  if (!sandbox?.ok) return false;
  return Object.values(sandbox.agents ?? {}).some((agent) => agent?.ok);
}

/**
 * Connecting Claude or Codex is required. The one way out is a sandbox the
 * workspace cannot use at all (the fleet is not offered): no connection the
 * person makes can fix that, so the step must not trap them.
 */
export function agentStepSkippable(readiness: WorkbenchReadiness | undefined): boolean {
  return readiness?.sandbox.ok === false;
}

/**
 * Where the selected workspace stands in setup. Like web, a workspace that
 * exists says nothing: the backend makes one for every account. A GitHub
 * connection is the evidence. Without it the person connects GitHub. With it,
 * only a device that started onboarding resumes at the first open step, so a
 * returning account never sees the wizard. A failed load never traps the
 * person in onboarding.
 */
export function onboardingGate({ workspace, repositories, readiness, inProgress }: OnboardingGateInput): OnboardingGate {
  if (!workspace.data) return pending(workspace.status) ? 'loading' : 'done';
  if (!workspace.data.integrations?.github) return 'github';
  if (inProgress === undefined) return 'loading';
  if (!inProgress) return 'done';
  if (!repositories.data) return pending(repositories.status) ? 'loading' : 'repos';
  if (!repositories.data.length) return 'repos';
  if (!readiness.data) return pending(readiness.status) ? 'loading' : 'agent';
  return agentReady(readiness.data) ? 'done' : 'agent';
}

/** The step's position for the progress dots. */
export function stepIndex(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step);
}
