/**
 * The mobile app's return link, for a browser flow the app started in its
 * in-app browser (an MCP server sign-in). The backend builds the link from its
 * `MOBILE_RETURN_SCHEMES` allowlist; this side only refuses anything that is
 * a web page or script, as a second check.
 */

const APP_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const NOT_AN_APP = /^(https?|javascript|data|file|blob|about|vbscript|ws|wss|ftp):/i;

/** The `appReturnUrl` in a backend answer (success data or error body), if it is an app link. */
export function appReturnUrlOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const url = (value as { appReturnUrl?: unknown }).appReturnUrl;
  if (typeof url !== 'string' || !APP_URL.test(url) || NOT_AN_APP.test(url)) return null;
  return url;
}

/** Leave the page for the app. A function of its own so a test can watch it. */
export function openAppReturn(url: string): void {
  window.location.replace(url);
}
