import { useEffect, useMemo } from 'react';
import {
  appendReviewRankingLog,
  readReviewRankingLog,
  ReviewRankingRecorder,
  type ReviewRankingContext,
  type ReviewRankingRow,
} from '@talyn/shared';

export function exportReviewRankingData(workspaceId: string): void {
  const events = readReviewRankingLog(localStorage, workspaceId);
  const data = JSON.stringify({ schema_version: 1, events }, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'talyn-review-ranking.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useReviewRankingCapture(
  rows: ReviewRankingRow[],
  context: ReviewRankingContext,
  enabled: boolean,
): (id: string) => void {
  const recorder = useMemo(
    () => new ReviewRankingRecorder(
      (event, properties) => {
        try {
          appendReviewRankingLog(localStorage, event, properties);
        } catch {
          // The browser can refuse access to localStorage itself.
        }
      },
      () => crypto.randomUUID(),
    ),
    [context.workspaceId],
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(
      (entries) => {
        if (cancelled || document.visibilityState !== 'visible') return;
        const ids = entries
          .filter((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5)
          .map((entry) => (entry.target as HTMLElement).dataset.reviewRankingId)
          .filter((id): id is string => !!id);
        recorder.observe(ids, Date.now());
      },
      { threshold: 0.5 },
    );
    const record = () => {
      if (document.visibilityState !== 'visible') return;
      try {
        recorder.record(rows, context, Date.now());
        observer?.disconnect();
        document.querySelectorAll('[data-review-ranking-id]').forEach((row) => observer?.observe(row));
      } catch {
        // Local recording must not prevent a review.
      }
    };
    record();
    document.addEventListener('visibilitychange', record);
    const timer = setInterval(record, 300_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', record);
    };
  }, [rows, context, enabled, recorder]);

  return (id) => {
    if (!enabled || document.visibilityState !== 'visible') return;
    try {
      recorder.record(rows, context, Date.now());
      recorder.open(id, Date.now());
    } catch {
      // Local recording must not prevent a review.
    }
  };
}
