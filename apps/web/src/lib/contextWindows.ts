const STORAGE_KEY = 'talyn.context.windows';
const MAX_WINDOWS = 50;

function storedWindows(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed)
      .filter((entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0
      )
      .slice(-MAX_WINDOWS);
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function rememberContextWindow(model: string, contextWindow: number): void {
  if (!model || !Number.isFinite(contextWindow) || contextWindow <= 0) return;
  try {
    const windows = storedWindows();
    const entries = [
      ...Object.entries(windows).filter(([key]) => key !== model),
      [model, contextWindow] as [string, number],
    ].slice(-MAX_WINDOWS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage can be unavailable in private browsing or during server rendering.
  }
}

export function knownContextWindow(model: string): number | null {
  if (!model) return null;
  const windows = storedWindows();
  return Object.prototype.hasOwnProperty.call(windows, model) ? windows[model] : null;
}
