import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkbenchBackgroundLogs } from '@talyn/shared';
import { api } from '../lib/api';
import { toast } from '../stores/toast';

export function useJobLogs(workbenchId: string, jobId: string, expanded: boolean, running: boolean) {
  const [logs, setLogs] = useState<WorkbenchBackgroundLogs | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const failed = useRef(false);

  const wakeAndLoad = useCallback(() => setLive(true), []);

  useEffect(() => {
    setLogs(null);
    setLive(false);
    setError(null);
    failed.current = false;
  }, [workbenchId, jobId]);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    let pending = false;
    const fetchLogs = async () => {
      if (pending) return;
      pending = true;
      setLoading(true);
      try {
        const next = await api.workbenches.backgroundJobLogs(workbenchId, jobId, { tail: 200, ...(live ? { live: true } : {}) });
        if (!cancelled) {
          setLogs(next);
          setError(null);
          failed.current = false;
        }
      } catch (cause) {
        if (!cancelled) {
          const message = cause instanceof Error ? cause.message : 'Could not load logs';
          setError(message);
          if (!failed.current) toast.error('Could not load logs', message);
          failed.current = true;
        }
      } finally {
        pending = false;
        if (!cancelled) setLoading(false);
      }
    };
    void fetchLogs();
    const interval = running ? window.setInterval(() => void fetchLogs(), 3000) : null;
    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
    };
  }, [workbenchId, jobId, expanded, running, live]);

  return { logs, live, error, loading, wakeAndLoad };
}
