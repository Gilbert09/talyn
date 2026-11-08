import type { Href } from 'expo-router';

// Intents survive authentication and workspace selection in this process only.
let pending: string | null = null;
export function productPath(raw: string): string | null {
  try {
    const url = new URL(raw, 'https://local.invalid');
    const path = url.protocol === 'http:' || url.protocol === 'https:' ? url.pathname : `/${url.host}${url.pathname}`;
    if (/^\/(sessions|threads|attention)\/[^/]{1,200}$/.test(path) && !/%2f|%5c/i.test(path)) return path;
    return null;
  } catch { return null; }
}
export function rememberIntent(raw: string) { const path = productPath(raw); if (path) pending = path; }
export function consumeIntent(): Href | null { const path = pending; pending = null; return path as Href | null; }
export function clearIntent() { pending = null; }
export function peekIntent() { return pending; }
export function completeIntent(path: string) { if (pending === path) pending = null; }
