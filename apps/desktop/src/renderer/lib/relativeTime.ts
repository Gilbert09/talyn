import { useSyncExternalStore } from 'react';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "a few seconds ago", "5 minutes ago", "yesterday". The words, not the
 * compact "5m" of `timeAgo`, for a time a person reads next to a message.
 * A time in the future (clock skew) reads as "a few seconds ago".
 */
export function relativeTimeLabel(iso: string, now = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '';
  const diff = Math.max(0, now - at);
  if (diff < 45 * SECOND) return 'a few seconds ago';
  if (diff < 90 * SECOND) return 'a minute ago';
  if (diff < 45 * MINUTE) return `${Math.round(diff / MINUTE)} minutes ago`;
  if (diff < 90 * MINUTE) return 'an hour ago';
  if (diff < 22 * HOUR) return `${Math.round(diff / HOUR)} hours ago`;
  if (diff < 36 * HOUR) return 'yesterday';
  if (diff < 26 * DAY) return `${Math.round(diff / DAY)} days ago`;
  if (diff < 45 * DAY) return 'a month ago';
  if (diff < 320 * DAY) return `${Math.round(diff / (30 * DAY))} months ago`;
  if (diff < 548 * DAY) return 'a year ago';
  return `${Math.round(diff / (365 * DAY))} years ago`;
}

/** The full local date and time, for a tooltip. */
export function fullTimeLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

/** The newest `createdAt` in `events`, which are in `seq` order. Null when none carries one. */
export function newestEventAt(events: ReadonlyArray<{ createdAt?: string }> | undefined): string | null {
  if (!events) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const at = events[i].createdAt;
    if (at) return at;
  }
  return null;
}

// One clock for every relative time on screen, so a long transcript runs one timer, not one per message.
const TICK_MS = 15 * SECOND;
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function snapshot(): number {
  // With no timer running, `now` can be old. Refresh it, but keep it stable for calls in the same tick window.
  if (timer === null && Date.now() - now >= TICK_MS) now = Date.now();
  return now;
}

/** `Date.now()`, updated every 15 seconds while a component uses it. */
export function useRelativeNow(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
