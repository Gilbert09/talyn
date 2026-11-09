import type { PRRow } from '@talyn/client/native';
import { useMemo } from 'react';

import { useResource } from '../../workflow/hooks';
import { mineCohort, queueCohort, reviewCohort } from './lists';

export interface PrCounts { mine: number | null; reviews: number | null; queue: number | null }
const UNKNOWN: PrCounts = Object.freeze({ mine: null, reviews: null, queue: null });

/**
 * Web `usePrBadgeCounts`: each badge counts with its page's own rule, so a
 * badge never counts a PR its page does not list. Null while the rows are unknown.
 */
export function prCounts(rows: PRRow[] | undefined): PrCounts {
  if (!rows) return UNKNOWN;
  return { mine: mineCohort(rows).length, reviews: reviewCohort(rows).length, queue: queueCohort(rows).length };
}

/** The drawer badges for Pull requests, Review requests and Merge queue. Shares the list pages' live rows. */
export function usePrCounts(): PrCounts {
  const rows = useResource<PRRow[]>('attention').data;
  return useMemo(() => prCounts(rows), [rows]);
}
