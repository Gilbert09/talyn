import { useEffect, useMemo, useState } from 'react';
import { MessageSquareText } from 'lucide-react';
import { TRANSCRIPT_SEARCH_MIN_LENGTH, workbenchDisplayName, workbenchesOffered, type WorkbenchTranscriptMatch } from '@talyn/shared';
import { api } from '../lib/api';
import { PALETTE_FOUND_ELSEWHERE, type PaletteSection } from '../lib/paletteSearch';
import { requestTranscriptFind, transcriptFindText } from '../lib/transcriptFind';
import { workbenchPlaceLabel } from '../lib/threads';
import { useNavigationStore } from '../stores/navigation';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';
import { isArchived } from './workbench/workbenchSelectors';

const ICON = 'h-3.5 w-3.5 shrink-0 text-muted-foreground';

/** How long the search waits after the last key before it asks the server. */
export const TRANSCRIPT_SEARCH_DEBOUNCE_MS = 250;

interface TranscriptResults {
  key: string;
  query: string;
  matches: WorkbenchTranscriptMatch[];
}

/**
 * The palette's Transcripts section: the sessions and threads whose messages
 * hold the search, archived ones too. The server searches, a short moment
 * after the last key. A pick opens the session with its find bar on the match.
 */
export function usePaletteTranscriptsSection(
  search: string,
  pick: (fn: () => void) => void
): { section: PaletteSection | null; loading: boolean } {
  const workspaceId = useWorkbenchStore((s) => s.workspaceId);
  const offered = workbenchesOffered(useWorkspaceStore((s) => s.features));
  const navigate = useNavigationStore((s) => s.navigate);
  const query = search.trim();
  const wanted = Boolean(workspaceId) && offered && query.length >= TRANSCRIPT_SEARCH_MIN_LENGTH;
  const key = `${workspaceId}\n${query}`;
  const [results, setResults] = useState<TranscriptResults | null>(null);

  useEffect(() => {
    if (!wanted || !workspaceId) return;
    let active = true;
    const timer = setTimeout(() => {
      void Promise.resolve()
        .then(() => api.workbenches.searchTranscripts(workspaceId, query))
        .then(
        (matches) => {
          if (active) setResults({ key, query, matches });
        },
        () => {
          if (active) setResults({ key, query, matches: [] });
        }
      );
    }, TRANSCRIPT_SEARCH_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [wanted, workspaceId, query, key]);

  const current = wanted && results?.key === key ? results : null;
  const section = useMemo<PaletteSection | null>(() => {
    if (!current || current.matches.length === 0) return null;
    return {
      id: 'transcripts',
      heading: 'Transcripts',
      kind: 'Transcript',
      searchOnly: true,
      matchScore: PALETTE_FOUND_ELSEWHERE,
      entries: current.matches.map((match) => {
        const wb = match.workbench;
        return {
          id: `transcript:${wb.id}`,
          label: workbenchDisplayName(wb),
          group: `workbench:${wb.id}`,
          onSelect: () =>
            pick(() => {
              if (isArchived(wb)) useWorkbenchStore.getState().upsertWorkbench(wb);
              navigate({ view: 'workbench', id: wb.id });
              requestTranscriptFind(wb.id, transcriptFindText(current.query, match.snippet));
            }),
          content: (
            <>
              <MessageSquareText className={ICON} />
              <span className="flex min-w-0 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{workbenchDisplayName(wb)}</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">{workbenchPlaceLabel(wb)}</span>
                </span>
                <span className="truncate text-[11px] text-muted-foreground" data-transcript-snippet="">
                  {match.snippet}
                </span>
              </span>
            </>
          ),
        };
      }),
    };
  }, [current, navigate, pick]);

  return { section, loading: wanted && !current };
}
