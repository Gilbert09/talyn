import React, { useEffect, useRef, useState } from 'react';
import { Timer } from 'lucide-react';
import { describeMergeEta, type MergeEtaAnswer } from '@talyn/shared';
import { api } from '../../lib/api';
import { useWorkspaceStore } from '../../stores/workspace';

/**
 * Trunk's merge ETA beside a PR that is in Trunk's merge queue.
 *
 * Asks only while the row is on screen and the window is visible, at most once
 * a minute per PR, and counts down locally every 30 s between asks. Draws
 * nothing when the `trunkMergeEta` feature is off or Trunk has no estimate.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */

const REFRESH_MS = 60_000;
const TICK_MS = 30_000;
// Shorter than REFRESH_MS, so a chip's own refresh always asks again, while a
// second chip for the same PR mounted moments later reuses the first answer.
const FRESH_MS = 30_000;

// Shared by every chip, so a PR shown in two lists costs one request.
const answers = new Map<string, { answer: MergeEtaAnswer | null; at: number }>();
const inflight = new Map<string, Promise<MergeEtaAnswer | null>>();

function loadEta(prId: string): Promise<MergeEtaAnswer | null> {
  const hit = answers.get(prId);
  if (hit && Date.now() - hit.at < FRESH_MS) return Promise.resolve(hit.answer);
  const pending = inflight.get(prId);
  if (pending) return pending;
  const call = api.pullRequests
    .mergeEta(prId)
    // A failed ask draws nothing. The next refresh tries again.
    .catch(() => null)
    .then((answer) => {
      answers.set(prId, { answer, at: Date.now() });
      return answer;
    })
    .finally(() => inflight.delete(prId));
  inflight.set(prId, call);
  return call;
}

/** Tests only. */
export function _resetTrunkMergeEtaCache(): void {
  answers.clear();
  inflight.clear();
}

/** True while `ref` is on screen. Without IntersectionObserver, always true. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>, active: boolean): boolean {
  const [onScreen, setOnScreen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (!active || !el || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      setOnScreen(entries.some((e) => e.isIntersecting));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, active]);
  return onScreen;
}

export function TrunkMergeEtaChip({ prId }: { prId: string }) {
  // Compared with `=== true`, so anything but a real `true` draws nothing.
  const flag = useWorkspaceStore((s) => s.features?.trunkMergeEta);
  const enabled = flag === true;
  const ref = useRef<HTMLSpanElement>(null);
  const onScreen = useOnScreen(ref, enabled);
  const [answer, setAnswer] = useState<MergeEtaAnswer | null>(
    () => answers.get(prId)?.answer ?? null
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled || !onScreen) return undefined;
    let cancelled = false;
    const refresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void loadEta(prId).then((a) => {
        if (cancelled) return;
        setAnswer(a);
        setNow(Date.now());
      });
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    // Catch up at once when the window comes back, rather than up to a minute late.
    document.addEventListener('visibilitychange', refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [enabled, onScreen, prId]);

  const hasEta = Boolean(answer?.eta);
  useEffect(() => {
    if (!enabled || !onScreen || !hasEta) return undefined;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [enabled, onScreen, hasEta]);

  if (!enabled) return null;
  const view = describeMergeEta(answer, now);
  const parts = view
    ? [view.headline, ...view.details].filter((p): p is string => Boolean(p))
    : [];

  return (
    // The empty span stays mounted so the observer can see the row before
    // there is anything to draw.
    <span ref={ref} className="inline-flex items-center gap-1" data-testid="trunk-merge-eta">
      {view && (
        <span
          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
          title={`Trunk's estimate: ${parts.join(' · ')}${view.runningLong ? ' · running long' : ''}`}
        >
          <Timer className="h-2.5 w-2.5" />
          {parts.map((part, i) => (
            <span key={part} className={i === 0 && view.headline ? 'text-foreground/80' : undefined}>
              {i > 0 ? `· ${part}` : part}
            </span>
          ))}
          {view.runningLong && <span className="italic opacity-70">· running long</span>}
        </span>
      )}
    </span>
  );
}
