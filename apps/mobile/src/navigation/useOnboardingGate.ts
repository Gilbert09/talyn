import type { WatchedRepo } from '@talyn/client/native';
import type { WorkbenchReadiness, Workspace } from '@talyn/shared';

import { useOnboardingProgress } from '../features/onboarding/progress';
import { useResource } from '../workflow/hooks';
import { onboardingGate } from './onboardingGate';

/** The gate for the selected workspace, from the store's cached resources. */
export function useOnboardingGate() {
  const workspace = useResource<Workspace>('workspace');
  const repositories = useResource<WatchedRepo[]>('repositories');
  const readiness = useResource<WorkbenchReadiness>('readiness');
  const progress = useOnboardingProgress();
  const gate = onboardingGate({ workspace, repositories, readiness, inProgress: progress.inProgress });
  return { gate, progress, workspace, repositories, readiness };
}
