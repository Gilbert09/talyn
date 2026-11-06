const SESSION_LINK_HOST = 'session';

/** The desktop URL for one session. The production app owns `fastowl://`. */
export function sessionAppUrl(sessionId: string, scheme = 'fastowl'): string {
  return `${scheme}://${SESSION_LINK_HOST}/${encodeURIComponent(sessionId)}`;
}

/** Read a session URL delivered to either the production or development app. */
export function sessionIdFromAppUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['fastowl:', 'fastowl-dev:'].includes(url.protocol) || url.hostname !== SESSION_LINK_HOST) return null;
    const match = /^\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) return null;
    const id = decodeURIComponent(match[1]);
    return id && !id.includes('/') ? id : null;
  } catch {
    return null;
  }
}
