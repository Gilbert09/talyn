import { useSyncExternalStore } from 'react';
import { DEFAULT_WORKBENCH_EFFORT, WORKBENCH_EFFORTS, type WorkbenchAgent, type WorkbenchEffort } from '@talyn/shared';

/**
 * What a new session starts with: agent, effort and plan mode, plus whether
 * a finished agent raises a notification. Per browser, so it lives in
 * localStorage. The browser has only the sandbox runtime, so there is no
 * runtime default. The model is not here: it is a workspace setting
 * (`fleetModels`), read through `storedFleetModelForAgent`. Every read is
 * defensive, as in `workbenchLayout.ts` — a bad stored value falls back to
 * the default for that field only.
 */

export const SESSION_DEFAULTS_KEY = 'talyn.session.defaults';

export interface SessionDefaults {
  agent: WorkbenchAgent;
  effort: WorkbenchEffort;
  planMode: boolean;
  internetAccess: boolean;
  autoCreatePr: boolean;
  notifyOnFinish: boolean;
}

export const DEFAULT_SESSION_DEFAULTS: SessionDefaults = {
  agent: 'claude',
  effort: DEFAULT_WORKBENCH_EFFORT,
  planMode: false,
  internetAccess: true,
  autoCreatePr: true,
  notifyOnFinish: true,
};

const AGENTS: readonly WorkbenchAgent[] = ['claude', 'codex'];

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function parse(raw: string | null | undefined): SessionDefaults {
  if (!raw) return { ...DEFAULT_SESSION_DEFAULTS };
  try {
    const p = JSON.parse(raw) as Partial<Record<keyof SessionDefaults, unknown>> | null;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { ...DEFAULT_SESSION_DEFAULTS };
    const d = DEFAULT_SESSION_DEFAULTS;
    return {
      agent: AGENTS.includes(p.agent as WorkbenchAgent) ? (p.agent as WorkbenchAgent) : d.agent,
      effort: WORKBENCH_EFFORTS.includes(p.effort as WorkbenchEffort) ? (p.effort as WorkbenchEffort) : d.effort,
      planMode: typeof p.planMode === 'boolean' ? p.planMode : d.planMode,
      internetAccess: typeof p.internetAccess === 'boolean' ? p.internetAccess : d.internetAccess,
      autoCreatePr: typeof p.autoCreatePr === 'boolean' ? p.autoCreatePr : d.autoCreatePr,
      notifyOnFinish: typeof p.notifyOnFinish === 'boolean' ? p.notifyOnFinish : d.notifyOnFinish,
    };
  } catch {
    return { ...DEFAULT_SESSION_DEFAULTS };
  }
}

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: SessionDefaults | null = null;

export function readSessionDefaults(): SessionDefaults {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(SESSION_DEFAULTS_KEY) ?? null;
  } catch {
    raw = null;
  }
  // Same object while the stored text is unchanged, so `useSyncExternalStore` does not loop.
  if (cached && raw === cachedRaw) return cached;
  cachedRaw = raw;
  cached = parse(raw);
  return cached;
}

export function writeSessionDefaults(patch: Partial<SessionDefaults>): void {
  try {
    const s = storage();
    if (s) s.setItem(SESSION_DEFAULTS_KEY, JSON.stringify({ ...readSessionDefaults(), ...patch }));
  } catch {
    // Storage full or blocked: the choice lasts until the page reloads at most.
  }
  for (const l of listeners) l();
}

export function subscribeSessionDefaults(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === SESSION_DEFAULTS_KEY) listener();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export function useSessionDefaults(): SessionDefaults {
  return useSyncExternalStore(subscribeSessionDefaults, readSessionDefaults, readSessionDefaults);
}
