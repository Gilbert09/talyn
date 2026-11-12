import type { ReactNode } from 'react';

/** One row of the command palette. The twin file in the other app must stay the same. */
export interface PaletteEntry {
  /** Unique across the palette. cmdk tracks the selected row by it. */
  id: string;
  /** The text the row shows. A match here ranks above a keyword match. */
  label: string;
  /** Other text that finds the row: a branch, a repository, a synonym. */
  keywords?: readonly (string | null | undefined)[];
  content: ReactNode;
  onSelect: () => void;
}

export interface PaletteSection {
  id: string;
  heading: string;
  /** The tag each row shows when a search puts all rows in one ranked list. */
  kind: string;
  entries: PaletteEntry[];
  /** The rows show only for a search. */
  searchOnly?: boolean;
  /** At most this many rows from the section match a search. */
  limit?: number;
}

export interface RankedPaletteEntry {
  entry: PaletteEntry;
  kind: string;
}

// A match in the label always ranks above a match in a keyword, and a closer
// match ranks above a looser one. Rows with the same score keep their order.
const LABEL_EXACT = 1;
const LABEL_PREFIX = 0.9;
const LABEL_WORD_PREFIX = 0.8;
const LABEL_SUBSTRING = 0.7;
const LABEL_ALL_WORDS = 0.6;
const KEYWORD_EXACT = 0.5;
const KEYWORD_PREFIX = 0.45;
const KEYWORD_WORD_PREFIX = 0.4;
const KEYWORD_SUBSTRING = 0.35;
const ALL_WORDS = 0.3;
const FUZZY_MIN = 0.1;
const FUZZY_RANGE = 0.1;

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}]/u.test(char);
}

function startsWord(text: string, query: string): boolean {
  for (let at = text.indexOf(query, 1); at > 0; at = text.indexOf(query, at + 1)) {
    if (!isWordChar(text[at - 1])) return true;
  }
  return false;
}

type Closeness = 'exact' | 'prefix' | 'wordPrefix' | 'substring';

function closeness(text: string, query: string): Closeness | null {
  if (text === query) return 'exact';
  if (text.startsWith(query)) return 'prefix';
  if (startsWord(text, query)) return 'wordPrefix';
  if (text.includes(query)) return 'substring';
  return null;
}

const LABEL_SCORE: Record<Closeness, number> = {
  exact: LABEL_EXACT,
  prefix: LABEL_PREFIX,
  wordPrefix: LABEL_WORD_PREFIX,
  substring: LABEL_SUBSTRING,
};

const KEYWORD_SCORE: Record<Closeness, number> = {
  exact: KEYWORD_EXACT,
  prefix: KEYWORD_PREFIX,
  wordPrefix: KEYWORD_WORD_PREFIX,
  substring: KEYWORD_SUBSTRING,
};

/** The query's letters in order inside the label, scored by how close together they are. */
function fuzzyScore(label: string, query: string): number {
  const letters = query.replace(/ /g, '');
  if (!letters) return 0;
  let best = 0;
  for (let start = label.indexOf(letters[0]); start !== -1; start = label.indexOf(letters[0], start + 1)) {
    let at = start;
    for (let i = 1; i < letters.length && at !== -1; i += 1) at = label.indexOf(letters[i], at + 1);
    if (at === -1) break;
    best = Math.max(best, letters.length / (at - start + 1));
  }
  return best > 0 ? FUZZY_MIN + FUZZY_RANGE * best : 0;
}

/**
 * How well a row matches a search, from 0 (no match) to 1 (the label is the
 * search). An empty search matches every row equally.
 */
export function paletteMatchScore(search: string, label: string, keywords: PaletteEntry['keywords'] = []): number {
  const query = normalize(search);
  if (!query) return 1;
  const text = normalize(label);

  const inLabel = closeness(text, query);
  if (inLabel) return LABEL_SCORE[inLabel];

  const words = query.split(' ');
  if (words.length > 1 && words.every((word) => text.includes(word))) return LABEL_ALL_WORDS;

  const extras = keywords.filter((k): k is string => Boolean(k)).map(normalize);
  let best = 0;
  for (const keyword of extras) {
    const inKeyword = closeness(keyword, query);
    if (inKeyword) best = Math.max(best, KEYWORD_SCORE[inKeyword]);
  }
  if (best) return best;

  if (words.length > 1 && words.every((word) => text.includes(word) || extras.some((k) => k.includes(word)))) {
    return ALL_WORDS;
  }
  return fuzzyScore(text, query);
}

interface Scored extends RankedPaletteEntry {
  score: number;
  index: number;
}

const byRank = (a: Scored, b: Scored) => b.score - a.score || a.index - b.index;

/**
 * Every row that matches the search, best match first, as one list. Rows
 * with the same score keep the order of their sections.
 */
export function rankPaletteSections(search: string, sections: readonly PaletteSection[]): RankedPaletteEntry[] {
  const all: Scored[] = [];
  let index = 0;
  for (const section of sections) {
    const matches: Scored[] = [];
    for (const entry of section.entries) {
      const score = paletteMatchScore(search, entry.label, entry.keywords);
      if (score > 0) matches.push({ entry, kind: section.kind, score, index });
      index += 1;
    }
    all.push(...(section.limit === undefined ? matches : matches.sort(byRank).slice(0, section.limit)));
  }
  return all.sort(byRank).map(({ entry, kind }) => ({ entry, kind }));
}
