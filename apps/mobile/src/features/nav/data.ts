import { TRANSCRIPT_SEARCH_MIN_LENGTH, type SpacesTeam, type Workbench, type WorkbenchTranscriptMatch } from '@talyn/shared';
import { useEffect, useMemo, useState } from 'react';

import { useMobileRuntime } from '../../auth/AuthProvider';
import { featureOffered, useFeatures } from '../../lib/features';
import { useResource } from '../../workflow/hooks';
import { useTeams } from '../spaces/data';
import { personalItems, spacesOffered } from '../spaces/model';
import { needsYouCount, TRANSCRIPT_SEARCH_DEBOUNCE_MS } from './model';

const NO_TEAMS: SpacesTeam[] = [];
const NO_MATCHES: WorkbenchTranscriptMatch[] = [];

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

/**
 * The sessions and threads whose transcripts hold the search, archived ones
 * too. Mirrors web `usePaletteTranscriptsSection`: the server searches a short
 * moment after the last key, a stale answer is dropped, and an error finds nothing.
 */
export function useTranscriptMatches(search: string, enabled: boolean): { matches: WorkbenchTranscriptMatch[]; loading: boolean } {
  const { workflow } = useMobileRuntime();
  const workspace = workflow.getScope()?.workspace ?? null;
  const query = search.trim();
  const wanted = enabled && Boolean(workspace) && query.length >= TRANSCRIPT_SEARCH_MIN_LENGTH;
  const key = `${workspace}\n${query}`;
  const [results, setResults] = useState<{ key: string; matches: WorkbenchTranscriptMatch[] } | null>(null);

  useEffect(() => {
    if (!wanted || !workspace) return;
    let active = true;
    const timer = setTimeout(() => {
      workflow.api.workbenches.searchTranscripts(workspace, query).then(
        (matches) => { if (active) setResults({ key, matches: matches.filter((match) => match.workbench.workspaceId === workspace) }); },
        () => { if (active) setResults({ key, matches: [] }); });
    }, TRANSCRIPT_SEARCH_DEBOUNCE_MS);
    return () => { active = false; clearTimeout(timer); };
  }, [wanted, workspace, query, key, workflow]);

  const current = wanted && results?.key === key ? results.matches : null;
  return { matches: current ?? NO_MATCHES, loading: wanted && current === null };
}
