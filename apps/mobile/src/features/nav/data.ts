import type { Workbench } from '@talyn/shared';

import { featureOffered, useFeatures } from '../../lib/features';
import { useResource } from '../../workflow/hooks';
import { needsYouCount } from './model';

/** The sessions and threads the drawer lists. Nothing is read when the account has no sessions. */
export function useDrawerWork() {
  const features = useFeatures();
  const offered = featureOffered(features, 'workbenches');
  const sessions = useResource<Workbench[]>('sessions', '', offered);
  const threads = useResource<Workbench[]>('threads', '', offered);
  return { features, offered, sessions, threads };
}

/** How many sessions and threads wait on the person. */
export function useNeedsYouCount(): number {
  const { offered, sessions, threads } = useDrawerWork();
  return offered ? needsYouCount(sessions.data, threads.data) : 0;
}
