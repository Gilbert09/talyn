const KEY = 'talyn:pending-team-invite';

/** Keep an invite token through the GitHub sign-in redirect and the onboarding wizard. */
export function rememberPendingInvite(token: string): void {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    // Storage can be blocked. The person can open the link again.
  }
}

export function readPendingInvite(): string | null {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export function clearPendingInvite(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
