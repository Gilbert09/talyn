export type GithubReturn = 'connected' | 'error';
export interface GithubReturnLink { result: GithubReturn; reason: string | null }

/** `?github=connected` or `?github=error&reason=…` from the return link. Null for anything else. */
export function parseGithubReturn(raw: string): GithubReturnLink | null {
  try {
    const url = new URL(raw, 'https://local.invalid');
    const result = url.searchParams.get('github');
    if (result !== 'connected' && result !== 'error') return null;
    const reason = url.searchParams.get('reason');
    return { result, reason: reason && /^[a-z0-9_]{1,64}$/.test(reason) ? reason : null };
  } catch { return null; }
}

// The link can arrive through the system before a screen listens, so the last one is kept.
let lastReturn: GithubReturnLink | null = null;
const listeners = new Set<() => void>();

export function receiveGithubReturn(raw: string) {
  const parsed = parseGithubReturn(raw);
  if (!parsed) return;
  lastReturn = parsed;
  for (const listener of listeners) listener();
}
export function takeGithubReturn(): GithubReturnLink | null { const value = lastReturn; lastReturn = null; return value; }
export function onGithubReturn(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
