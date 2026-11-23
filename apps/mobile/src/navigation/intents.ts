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

// A link or text shared into Talyn from another app (src/features/share). It waits like a product link, so it
// survives sign-in and the workspace choice, and the new-session page clears it once it shows the text.
const SHARE_PATH = '/new?mode=session&prompt=';
/** The route the iOS share extension's link opens (`app/+native-intent.tsx`). It waits there for the shared item. */
export const SHARE_ROUTE = '/share';
export function shareIntentPath(prompt: string): string { return `${SHARE_PATH}${encodeURIComponent(prompt)}`; }
export function rememberShare(prompt: string): string { pending = shareIntentPath(prompt); return pending; }
export function pendingShare(): string | null { return pending?.startsWith(SHARE_PATH) ? pending : null; }
export function completeShare() { if (pending?.startsWith(SHARE_PATH)) pending = null; }
