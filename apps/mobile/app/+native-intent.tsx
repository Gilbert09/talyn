import { receiveCallback } from '../src/auth/callback';
import { productPath, rememberIntent } from '../src/navigation/intents';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const url = new URL(path, 'https://local.invalid');
    if (url.pathname === '/callback' || url.pathname === '/auth/callback' ||
      ['code', 'error', 'access_token', 'refresh_token'].some((key) => url.searchParams.has(key))) {
      receiveCallback(path);
      return '/auth/callback';
    }
    const product = productPath(path);
    if (product) { rememberIntent(path); return product; }
    return url.pathname;
  } catch {
    return '/';
  }
}
