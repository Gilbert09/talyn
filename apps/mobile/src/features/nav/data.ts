import type { SpacesTeam, Workbench } from '@talyn/shared';
import { useMemo } from 'react';

import { featureOffered, useFeatures } from '../../lib/features';
import { useResource } from '../../workflow/hooks';
import { useTeams } from '../spaces/data';
import { personalItems, spacesOffered } from '../spaces/model';
import { needsYouCount } from './model';

const NO_TEAMS: SpacesTeam[] = [];

/**
 * The sessions and threads the drawer lists. Nothing is read when the account
 * has no sessions. `personal` leaves out the ones in a space, like web's
 * sidebar; `sessions` and `threads` keep them, for the space drawer's states.
 */
export function useDrawerWork() {
  const features = useFeatures();
  const offered = featureOffered(features, 'workbenches');
  const sessions = useResource<Workbench[]>('sessions', '', offered);
  const threads = useResource<Workbench[]>('threads', '', offered);
  const teams = useTeams();
  const spaces = spacesOffered(features);
  // A failed teams read counts as no teams, like web, so nothing is lost from Personal.
  const known = teams.data ?? (teams.status === 'loading' ? null : NO_TEAMS);
  const personal = useMemo(() => ({ sessions: personalItems(sessions.data, known, spaces), threads: personalItems(threads.data, known, spaces) }),
    [sessions.data, threads.data, known, spaces]);
  return { features, offered, sessions, threads, personal };
}

/** How many sessions and threads in Personal wait on the person. */
export function useNeedsYouCount(): number {
  const { offered, personal } = useDrawerWork();
  return offered ? needsYouCount(personal.sessions, personal.threads) : 0;
}
