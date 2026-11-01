import { api } from './api';
import { getSupabase, isSupabaseConfigured } from './supabase';

/**
 * Whether something in the session's box answers on `port`. Mirrors the
 * desktop's probe: it asks the backend's ports route. A closed port comes back
 * from the fleet as a 502 with `port_closed`. Talyn's own refusals carry
 * `"success":false`. Anything else is the app answering, a 404 included.
 */
export async function previewPortAnswers(workbenchId: string, port: number): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const token = (await getSupabase().auth.getSession()).data.session?.access_token;
  if (!token) return false;
  try {
    const res = await fetch(api.workbenches.portUrl(workbenchId, port), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 502 && res.status <= 504) return false;
    const text = await res.text().catch(() => '');
    if (text.includes('"port_closed"')) return false;
    if (res.status >= 400 && text.includes('"success":false')) return false;
    return true;
  } catch {
    return false;
  }
}
