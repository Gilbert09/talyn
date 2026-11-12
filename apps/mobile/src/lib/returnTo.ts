import {
  MOBILE_BILLING_RETURN_PATH, MOBILE_GITHUB_RETURN_PATH, MOBILE_LINEAR_RETURN_PATH, MOBILE_MCP_RETURN_PATH, MOBILE_POSTHOG_RETURN_PATH, MOBILE_SLACK_RETURN_PATH,
} from '@talyn/shared';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';

/** A browser flow that finishes with a redirect back into the app. */
export type ReturnKind = 'github' | 'billing' | 'mcp' | 'slack' | 'posthog' | 'linear';

const RETURN_PATHS: Record<ReturnKind, string> = {
  github: MOBILE_GITHUB_RETURN_PATH,
  billing: MOBILE_BILLING_RETURN_PATH,
  mcp: MOBILE_MCP_RETURN_PATH,
  slack: MOBILE_SLACK_RETURN_PATH,
  posthog: MOBILE_POSTHOG_RETURN_PATH,
  linear: MOBILE_LINEAR_RETURN_PATH,
};

const FALLBACK_SCHEME = 'talyn-mobile-development';

/** The app's own URL base, such as `talyn-mobile://`. The backend appends its return path to it. */
export function appReturnBase(scheme: unknown = Constants.expoConfig?.scheme): string {
  const value = Array.isArray(scheme) ? scheme[0] : scheme;
  const valid = typeof value === 'string' && /^[a-z][a-z0-9+.-]+$/.test(value);
  return `${valid ? value : FALLBACK_SCHEME}://`;
}

/** The URL prefix that ends a flow of this kind. */
export function returnPrefix(kind: ReturnKind, base = appReturnBase()): string {
  return `${base}${RETURN_PATHS[kind]}`;
}

/**
 * Opens a browser flow and waits until it redirects back to the app or the
 * person closes the browser. The server stays the source of truth: callers
 * refetch what the flow changed in both cases. `onReturn` gets the return
 * URL, for an analytics event that reads its outcome.
 */
export async function openReturnFlow(url: string, kind: ReturnKind, onReturn?: (url: string) => void): Promise<'returned' | 'dismissed'> {
  try {
    const result = await WebBrowser.openAuthSessionAsync(url, returnPrefix(kind));
    if (result.type === 'success' && onReturn) onReturn(result.url);
    return result.type === 'success' ? 'returned' : 'dismissed';
  } catch {
    return 'dismissed';
  }
}
