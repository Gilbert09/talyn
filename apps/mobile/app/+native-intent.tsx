import {
  MOBILE_BILLING_RETURN_PATH, MOBILE_GITHUB_RETURN_PATH, MOBILE_MCP_RETURN_PATH, MOBILE_POSTHOG_RETURN_PATH, MOBILE_SLACK_RETURN_PATH,
} from '@talyn/shared';

import { receiveCallback } from '../src/auth/callback';
import { receiveGithubReturn } from '../src/features/onboarding/githubReturn';
import { productPath, rememberIntent } from '../src/navigation/intents';
import { billingReturnPath, linkPath } from '../src/navigation/returnLinks';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const url = new URL(path, 'https://local.invalid');
    const logical = linkPath(url);
    // Browser flows that return to the app. Checked first: `talyn-mobile://github/callback` also ends in `/callback`.
    if (logical === `/${MOBILE_GITHUB_RETURN_PATH}`) {
      receiveGithubReturn(path);
      return '/github/callback';
    }
    if (logical === `/${MOBILE_BILLING_RETURN_PATH}`) return billingReturnPath(url);
    // Settings sign-ins. The screen that opened the browser refetches, so no parameter reaches a screen.
    const settingsReturn = [MOBILE_MCP_RETURN_PATH, MOBILE_SLACK_RETURN_PATH, MOBILE_POSTHOG_RETURN_PATH].find((returnPath) => logical === `/${returnPath}`);
    if (settingsReturn) return `/${settingsReturn}`;
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
