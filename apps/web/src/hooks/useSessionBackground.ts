import { useEffect, useState } from 'react';
import { loadBackground } from '../stores/sessionBackground';
import { useOnReconnect } from './useOnReconnect';

export function useWorkbenchBackgroundLoad(workbenchId: string): void {
  useEffect(() => {
    void loadBackground(workbenchId);
  }, [workbenchId]);
  useOnReconnect(() => {
    void loadBackground(workbenchId);
  });
}

export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    const interval = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(interval);
  }, [intervalMs]);
  return now;
}
