export const ATTEMPT_TTL_MS = 5 * 60 * 1000;

export class SignInError extends Error {
  constructor(public readonly kind: 'invalid' | 'expired' | 'failed' | 'cancelled' | 'timeout' | 'storage') {
    super('Sign-in could not finish. Please try again.');
  }
}

export function callbackCode(raw: string, expected: string): string {
  try {
    if (raw.length > 4096 || raw.includes('#') || /%(?![0-9a-f]{2})/i.test(raw)) throw new Error();
    const url = new URL(raw);
    const target = new URL(expected);
    if (url.protocol !== target.protocol || url.host !== target.host || url.pathname !== target.pathname ||
      url.username || url.password || url.hash || raw.split('?')[0] !== expected) throw new Error();
    const params = url.searchParams;
    const allowed = new Set(['code', 'state', 'error', 'error_code', 'error_description']);
    for (const key of params.keys()) {
      if (!allowed.has(key) || params.getAll(key).length !== 1) throw new Error();
    }
    if (params.has('error') || params.has('error_code') || params.has('error_description')) throw new SignInError('failed');
    const code = params.get('code');
    if (!code || !/^[a-zA-Z0-9._~-]{1,2048}$/.test(code)) throw new Error();
    return code;
  } catch (error) {
    if (error instanceof SignInError) throw error;
    throw new SignInError('invalid');
  }
}

// The auth service owns OAuth state. The app never creates or replaces it.
let queued: string | null = null;
let listener: ((url: string) => void) | null = null;
export function receiveCallback(url: string) {
  if (listener) listener(url);
  else queued ??= url;
}
export function listenForCallbacks(next: (url: string) => void) {
  listener = next;
  if (queued) { const url = queued; queued = null; next(url); }
  return () => { if (listener === next) listener = null; queued = null; };
}
