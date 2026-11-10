import { REVIEW_SORT_MODE_KEY } from '@talyn/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { parseReviewSortMode } from './filters';
import type { ReviewSortMode } from './lists';

interface SortStorage { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> }

// Kept for the session, so a second visit draws in the saved order straight away.
let remembered: ReviewSortMode | null = null;

function sortStorage(): SortStorage | null {
  try {
    // Loaded on first use, like the theme preference, so tests without the native module still render.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require('@react-native-async-storage/async-storage') as { default?: SortStorage };
    return module.default ?? null;
  } catch {
    return null;
  }
}

/** Forget the session copy. For tests. */
export function forgetReviewSortMode() { remembered = null; }

/**
 * The Reviews sort, saved on this device under web's key. It draws with the
 * default (Priority) at once and switches to the saved mode when it loads.
 * A choice made while it loads wins.
 */
export function useReviewSortMode(): [ReviewSortMode, (mode: ReviewSortMode) => void] {
  const [mode, setMode] = useState<ReviewSortMode>(remembered ?? parseReviewSortMode(null));
  const chosen = useRef(false);
  useEffect(() => {
    if (remembered) return undefined;
    const storage = sortStorage();
    if (!storage) return undefined;
    let live = true;
    storage.getItem(REVIEW_SORT_MODE_KEY).then((value) => {
      if (chosen.current) return;
      const saved = parseReviewSortMode(value);
      remembered = saved;
      if (live) setMode(saved);
    }, () => {});
    return () => { live = false; };
  }, []);
  const choose = useCallback((next: ReviewSortMode) => {
    chosen.current = true;
    remembered = next;
    setMode(next);
    void sortStorage()?.setItem(REVIEW_SORT_MODE_KEY, next).catch(() => {});
  }, []);
  return [mode, choose];
}
