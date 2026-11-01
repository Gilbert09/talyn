import { API_BASE_URL, getAccessToken } from './api';

/**
 * Whether something in the session's box answers on `port`. Asks the backend's
 * ports route, the same path the localhost forward uses. A closed port comes
 * back from the fleet as a 502 with `port_closed`. Talyn's own refusals (the
 * box is not ready, for example) carry `"success":false`. Anything else is the
 * app answering, a 404 included.
 */
export async function previewPortAnswers(workbenchId: string, port: number): Promise<boolean> {
  const token = await getAccessToken();
  if (!token) return false;
  const url = `${API_BASE_URL.replace(/\/$/, '')}/api/v1/workbenches/${encodeURIComponent(workbenchId)}/ports/${port}/`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status >= 502 && res.status <= 504) return false;
    const text = await res.text().catch(() => '');
    if (text.includes('"port_closed"')) return false;
    if (res.status >= 400 && text.includes('"success":false')) return false;
    return true;
  } catch {
    return false;
  }
}
