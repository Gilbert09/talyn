import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, X } from 'lucide-react';
import { IS_MAC } from '../../lib/shortcuts';
import {
  OPEN_TRANSCRIPT_FIND_EVENT,
  clearMatches,
  findTextRanges,
  matchLabel,
  paintMatches,
  scrollToMatch,
  stepMatch,
  takePendingTranscriptFind,
  type OpenTranscriptFindDetail,
} from '../../lib/transcriptFind';
import type { OlderHistory } from './WorkbenchTranscript';

/** The first match that is not above the top of the view, so a search starts where the person is reading. */
function firstMatchInView(container: HTMLElement, ranges: Range[]): number {
  if (ranges.length === 0) return -1;
  if (typeof ranges[0].getBoundingClientRect !== 'function') return 0;
  const top = container.getBoundingClientRect().top;
  const i = ranges.findIndex((range) => range.getBoundingClientRect().bottom >= top);
  return i === -1 ? ranges.length - 1 : i;
}

const sameStart = (a: Range, b: Range) => a.startContainer === b.startContainer && a.startOffset === b.startOffset;

/**
 * The find bar over a session transcript. It opens on `OPEN_TRANSCRIPT_FIND_EVENT`
 * for its own session and closes when another session's bar opens, so only one
 * set of highlights is on the page.
 *
 * The transcript loads its newest messages first. A search loads the earlier
 * pages too, so it covers the whole transcript.
 */
export function TranscriptFindBar({
  workbenchId,
  scrollRef,
  older,
}: {
  workbenchId: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  older: OlderHistory;
}) {
  const [open, setOpen] = useState(false);
  // Goes up on each ⌘F, so the input gets the focus again when the bar is already open.
  const [focusRequest, setFocusRequest] = useState(0);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(-1);
  const [count, setCount] = useState(0);
  const rangesRef = useRef<Range[]>([]);
  const currentRef = useRef(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const select = useCallback(
    (index: number, scroll: boolean) => {
      currentRef.current = index;
      setCurrent(index);
      paintMatches(rangesRef.current, index);
      const range = rangesRef.current[index];
      const el = scrollRef.current;
      if (scroll && range && el) scrollToMatch(el, range);
    },
    [scrollRef],
  );

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenTranscriptFindDetail>).detail;
      if (detail?.workbenchId !== workbenchId) {
        setOpen(false);
        return;
      }
      takePendingTranscriptFind(workbenchId);
      if (detail.query) setQuery(detail.query);
      setOpen(true);
      setFocusRequest((n) => n + 1);
    };
    window.addEventListener(OPEN_TRANSCRIPT_FIND_EVENT, onOpen);
    // A request sent before this transcript was on screen.
    const pendingQuery = takePendingTranscriptFind(workbenchId);
    if (pendingQuery) {
      setQuery(pendingQuery);
      setOpen(true);
      setFocusRequest((n) => n + 1);
    }
    return () => window.removeEventListener(OPEN_TRANSCRIPT_FIND_EVENT, onOpen);
  }, [workbenchId]);

  // After the commit, so the input is in the DOM. A focus before the render lands would do nothing.
  useLayoutEffect(() => {
    if (!open || focusRequest === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open, focusRequest]);

  // A new query, or the bar opening: search again and start at the view.
  useEffect(() => {
    const el = scrollRef.current;
    if (!open || !el) return;
    rangesRef.current = findTextRanges(el, query);
    setCount(rangesRef.current.length);
    select(firstMatchInView(el, rangesRef.current), true);
  }, [open, query, scrollRef, select]);

  // A search covers the whole transcript: load the earlier pages one after another.
  const searching = open && query.trim() !== '';
  const { hasOlder, loading: loadingOlder, error: olderError } = older;
  const loadRef = useRef(older.load);
  loadRef.current = older.load;
  useEffect(() => {
    if (searching && hasOlder && !loadingOlder && !olderError) void loadRef.current();
  }, [searching, hasOlder, loadingOlder, olderError]);

  // The transcript changes while the bar is open: count again and keep the current match.
  // Earlier pages land above it, so find it by its text position, not by its index.
  useEffect(() => {
    const el = scrollRef.current;
    if (!open || !el || !query.trim() || typeof MutationObserver === 'undefined') return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const prev = rangesRef.current[currentRef.current];
        const ranges = findTextRanges(el, query);
        rangesRef.current = ranges;
        setCount(ranges.length);
        if (!prev) {
          // The first matches, for example from an earlier page: go to the nearest one.
          select(firstMatchInView(el, ranges), true);
          return;
        }
        const kept = ranges.findIndex((range) => sameStart(range, prev));
        select(kept !== -1 ? kept : ranges.length === 0 ? -1 : Math.min(currentRef.current, ranges.length - 1), false);
      });
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [open, query, scrollRef, select]);

  useEffect(() => {
    if (!open) {
      rangesRef.current = [];
      clearMatches();
    }
  }, [open]);

  useEffect(() => () => clearMatches(), []);

  const step = (delta: 1 | -1) => select(stepMatch(currentRef.current, delta, rangesRef.current.length), true);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Enter' || (mod && e.key.toLowerCase() === 'g')) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };

  if (!open) return null;
  const label = matchLabel(query, current, count);

  return (
    <div
      data-find-skip
      role="search"
      aria-label="Find in transcript"
      className="absolute right-4 top-2 z-20 flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find in transcript"
        aria-label="Find in transcript"
        spellCheck={false}
        className="h-6 w-48 border-0 bg-transparent px-1 text-xs outline-none placeholder:text-muted-foreground"
      />
      <span className="min-w-[4.5rem] text-right tabular-nums text-muted-foreground" aria-live="polite">
        {label}
      </span>
      {searching && hasOlder && !olderError && (
        <span className="flex items-center gap-1 whitespace-nowrap text-muted-foreground" title="Loading earlier messages to search them">
          <Loader2 className="h-3 w-3 animate-spin" /> searching earlier
        </span>
      )}
      {searching && hasOlder && olderError && (
        <button
          type="button"
          onClick={() => void older.load()}
          className="whitespace-nowrap rounded px-1 text-destructive hover:bg-accent"
          title={`Earlier messages did not load, so they are not searched: ${olderError}`}
        >
          Retry earlier
        </button>
      )}
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={count === 0}
        aria-label="Previous match"
        title="Previous match (⇧Enter)"
        className="rounded p-0.5 hover:bg-accent disabled:opacity-40"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={count === 0}
        aria-label="Next match"
        title="Next match (Enter)"
        className="rounded p-0.5 hover:bg-accent disabled:opacity-40"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Close find"
        title="Close (Esc)"
        className="rounded p-0.5 hover:bg-accent"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
