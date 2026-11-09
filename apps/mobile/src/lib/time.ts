import { useSyncExternalStore } from 'react';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}
function startOfDay(at: number) { const date = new Date(at); date.setHours(0, 0, 0, 0); return date.getTime(); }

/** Compact list form: "now", "5m", "2h", "yesterday", "3d", "3 Nov", "3 Nov 2025". Empty for an invalid time. */
export function shortTime(iso: string | null | undefined, now = Date.now()): string {
  const at = parse(iso);
  if (at === null) return '';
  const diff = Math.max(0, now - at);
  if (diff < MINUTE) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  // Calendar days, so 25 hours ago at 08:00 is "yesterday", not "1d".
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days <= 1) return 'yesterday';
  if (days < 7) return `${days}d`;
  const date = new Date(at);
  const label = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === new Date(now).getFullYear() ? label : `${label} ${date.getFullYear()}`;
}

/** Words for a time read next to content: "a few seconds ago", "5 minutes ago", "yesterday". Mirrors web. */
export function relativeTimeLabel(iso: string | null | undefined, now = Date.now()): string {
  const at = parse(iso);
  if (at === null) return '';
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

/** The full local date and time, for detail on demand: "3 Nov 2026, 17:01". */
export function longTime(iso: string | null | undefined): string {
  const at = parse(iso);
  if (at === null) return '';
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// One clock for every relative time on screen.
const TICK = 30 * SECOND;
const listeners = new Set<() => void>();
let current = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === null) {
    current = Date.now();
    timer = setInterval(() => { current = Date.now(); listeners.forEach((item) => item()); }, TICK);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer !== null) { clearInterval(timer); timer = null; }
  };
}
function snapshot() {
  if (timer === null && Date.now() - current >= TICK) current = Date.now();
  return current;
}
/** `Date.now()`, updated every 30 seconds while a component uses it. */
export function useNow() { return useSyncExternalStore(subscribe, snapshot, snapshot); }
