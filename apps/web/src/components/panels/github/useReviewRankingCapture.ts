import { api } from '../../../lib/api';
import { getAnalyticsOptOut } from '../../../lib/analytics';
import { useEffect, useMemo } from 'react';
import { ReviewRankingArchive, ReviewRankingUploader } from '@talyn/client';
import {
  appendReviewRankingLog,
  readReviewRankingLog,
  ReviewRankingRecorder,
  type ReviewRankingContext,
  type ReviewRankingRow,
} from '@talyn/shared';

const archive = new ReviewRankingArchive();

export async function exportReviewRankingData(workspaceId: string): Promise<void> {
  let recent = [] as ReturnType<typeof readReviewRankingLog>;
  try {
    recent = readReviewRankingLog(localStorage, workspaceId);
  } catch {
    // The browser can refuse localStorage while the archive remains available.
  }
  const stored = await archive.read(workspaceId).catch(() => null);
  const unique = new Map([...stored?.events ?? [], ...recent].map((event) => [
    JSON.stringify([event.event, event.properties]), event,
  ]));
  const events = [...unique.values()].sort((left, right) => left.stored_at - right.stored_at);
  const data = JSON.stringify({
    schema_version: 1, events, archive_available: stored !== null, archive: stored?.archive ?? null,
  }, null, 2);
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
  const session = useMemo(() => ({ id: crypto.randomUUID(), startedAt: new Date().toISOString() }), [context.workspaceId]);
  const uploader = useMemo(() => new ReviewRankingUploader(
    context.workspaceId, {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key),
    }, (batch) => api.workspaces.recordRankingEvents(context.workspaceId, batch),
  ), [context.workspaceId]);
  useEffect(() => {
    if (!enabled) return;
    const flush = () => {
      uploader.setEnabled(!getAnalyticsOptOut());
      void uploader.flush();
    };
    flush();
    const timer = setInterval(flush, 5000);
    window.addEventListener('talyn-analytics-preference-changed', flush);
    return () => {
      clearInterval(timer);
      window.removeEventListener('talyn-analytics-preference-changed', flush);
      flush();
    };
  }, [uploader, enabled]);

  const recorder = useMemo(
    () => new ReviewRankingRecorder(
      (event, properties) => {
        uploader.setEnabled(!getAnalyticsOptOut());
        uploader.append({ id: crypto.randomUUID(), event, properties: {
          ...properties, session_id: session.id, session_started_at: session.startedAt,
        } });
        void archive.append(event, properties);
        try {
          appendReviewRankingLog(localStorage, event, properties);
        } catch {
          // The browser can refuse access to localStorage itself.
        }
      },
      () => crypto.randomUUID(),
    ),
    [context.workspaceId, session, uploader],
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
