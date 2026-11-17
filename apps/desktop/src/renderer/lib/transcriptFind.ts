/**
 * Find in a session transcript (⌘F). The transcript is not virtualized, so
 * the search reads the text the DOM holds now, with collapsed tool output
 * left out, as the browser's own find does. The find bar loads the earlier
 * pages of the transcript first, so the DOM holds the whole transcript.
 *
 * Matches are painted with the CSS Custom Highlight API, which marks text
 * ranges without changing the DOM. Wrapping matches in <mark> would change
 * nodes that React owns. Where the API is missing, find still counts and
 * scrolls, but does not paint.
 */

/** `AppShell` sends this with `{ workbenchId }`. The transcript of that session opens its find bar. */
export const OPEN_TRANSCRIPT_FIND_EVENT = 'talyn:open-transcript-find';

export interface OpenTranscriptFindDetail {
  workbenchId: string;
  /** The text to find. Absent: the bar keeps its own text. */
  query?: string;
}

/** A request with a query for a transcript that is not on screen yet, such as a pick in ⌘K. */
let pending: { workbenchId: string; query: string; at: number } | null = null;
const PENDING_MS = 10_000;

/** Open the find bar of a session's transcript. With `query`, also when the transcript mounts in the next seconds. */
export function requestTranscriptFind(workbenchId: string, query?: string): void {
  pending = query ? { workbenchId, query, at: Date.now() } : null;
  const detail: OpenTranscriptFindDetail = query ? { workbenchId, query } : { workbenchId };
  window.dispatchEvent(new CustomEvent<OpenTranscriptFindDetail>(OPEN_TRANSCRIPT_FIND_EVENT, { detail }));
}

/** The query of a request for this session that no find bar took yet. A second read answers null. */
export function takePendingTranscriptFind(workbenchId: string): string | null {
  const request = pending;
  if (!request || request.workbenchId !== workbenchId) return null;
  pending = null;
  return Date.now() - request.at <= PENDING_MS ? request.query : null;
}

/**
 * What to find in a transcript that a search found: the whole search when
 * the matching text holds it, else its longest word that the text holds.
 */
export function transcriptFindText(search: string, matchText: string): string {
  const query = search.trim().replace(/\s+/g, ' ');
  const text = matchText.toLowerCase();
  if (text.includes(query.toLowerCase())) return query;
  const words = query.split(' ').filter((word) => text.includes(word.toLowerCase()));
  return words.sort((a, b) => b.length - a.length)[0] ?? query;
}

/** Text under these is not searched: hidden content and controls that are not transcript text. */
const SKIP = '[hidden], [aria-hidden="true"], [data-find-skip], script, style, svg';

/** Each case-insensitive occurrence of `query` in the text under `root`, in document order. */
export function findTextRanges(root: Node, query: string): Range[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent || parent.closest(SKIP)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const ranges: Range[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLowerCase();
    let at = text.indexOf(needle);
    while (at !== -1) {
      const range = doc.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      at = text.indexOf(needle, at + needle.length);
    }
  }
  return ranges;
}

/** The match to select after a step of `delta`, wrapping at both ends. */
export function stepMatch(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1;
  if (current < 0 || current >= count) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/** '3 of 12', 'No results', or nothing for an empty query. */
export function matchLabel(query: string, current: number, count: number): string {
  if (!query.trim()) return '';
  if (count === 0) return 'No results';
  return `${current + 1} of ${count}`;
}

export const FIND_HIGHLIGHT = 'transcript-find';
export const FIND_HIGHLIGHT_CURRENT = 'transcript-find-current';

interface HighlightRegistry {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

function highlightApi(): { registry: HighlightRegistry; make: (...ranges: Range[]) => unknown } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Ctor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!css?.highlights || typeof Ctor !== 'function') return null;
  return { registry: css.highlights, make: (...ranges) => new Ctor(...ranges) };
}

/**
 * Paint every match, and the current one in a stronger colour. One page
 * shows at most one find bar at a time (only the focused split pane opens
 * one), so one pair of highlight names is enough.
 */
export function paintMatches(ranges: Range[], current: number): void {
  const api = highlightApi();
  if (!api) return;
  if (ranges.length === 0) {
    clearMatches();
    return;
  }
  api.registry.set(FIND_HIGHLIGHT, api.make(...ranges.filter((_, i) => i !== current)));
  const selected = ranges[current];
  if (selected) api.registry.set(FIND_HIGHLIGHT_CURRENT, api.make(selected));
  else api.registry.delete(FIND_HIGHLIGHT_CURRENT);
}

export function clearMatches(): void {
  const api = highlightApi();
  if (!api) return;
  api.registry.delete(FIND_HIGHLIGHT);
  api.registry.delete(FIND_HIGHLIGHT_CURRENT);
}

/** Scroll `container` so the match is in the middle of the view. */
export function scrollToMatch(container: HTMLElement, range: Range): void {
  const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
  if (rect && (rect.height > 0 || rect.width > 0)) {
    const box = container.getBoundingClientRect();
    const offset = rect.top - box.top - (container.clientHeight - rect.height) / 2;
    container.scrollTop += offset;
    return;
  }
  const el = range.startContainer.parentElement;
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
}
