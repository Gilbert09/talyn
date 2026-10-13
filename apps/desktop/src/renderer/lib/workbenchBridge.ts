import type { WorkbenchLocalBridge } from '@talyn/shared';

/**
 * The local workbench runtime the preload exposes as `window.electron.workbench`.
 *
 * Read through the SHARED type rather than the preload's own: the bridge's
 * contract is `WorkbenchLocalBridge`, and the renderer must not depend on how
 * the main process happens to declare it. Null when the preload has no bridge
 * (an older main process, or a test) — sandbox workbenches never need it.
 */
export function getWorkbenchBridge(): WorkbenchLocalBridge | null {
  if (typeof window === 'undefined') return null;
  const electron = (window as unknown as { electron?: { workbench?: WorkbenchLocalBridge } }).electron;
  return electron?.workbench ?? null;
}

const DEVICE_ID_KEY = 'talyn-workbench-device-id';

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

let cachedDeviceId: string | null = null;

/**
 * This machine's id, made once and kept in localStorage. A local workbench
 * records the device that owns its worktree, so another machine can tell the
 * worktree is not here instead of failing every git call.
 */
export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    const stored = localStorage.getItem(DEVICE_ID_KEY);
    if (stored) {
      cachedDeviceId = stored;
      return stored;
    }
    const fresh = randomId();
    localStorage.setItem(DEVICE_ID_KEY, fresh);
    cachedDeviceId = fresh;
    return fresh;
  } catch {
    cachedDeviceId = randomId();
    return cachedDeviceId;
  }
}

/** Test hook: forget the cached id so the next read goes to storage again. */
export function resetDeviceIdCache(): void {
  cachedDeviceId = null;
}

export function newClientId(): string {
  return randomId();
}
