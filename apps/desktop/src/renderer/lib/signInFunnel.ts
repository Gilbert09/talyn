import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ApiError } from './api';
import { trackEvent } from './analytics';

export type AbandonMethod = 'claude_oauth' | 'codex_paste' | 'codex_oauth';
export type AbandonVia = 'back' | 'cancel' | 'closed' | 'timeout';

const ABANDONABLE: readonly string[] = ['claude_oauth', 'codex_paste', 'codex_oauth'];

const CODEX_SIGNIN_TIMEOUT = 'Timed out waiting for the ChatGPT sign-in to finish.';

/** The main process says only this when the user never finished in the browser. */
export function isCodexSignInTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes(CODEX_SIGNIN_TIMEOUT);
}

export function errorCode(error: unknown): string | null {
  return error instanceof ApiError && error.code ? error.code : null;
}

export interface SignInAbandon {
  begin: (agent: string, method: string) => void;
  end: () => void;
  abandon: (via: AbandonVia) => void;
}

/**
 * Tracks one sign-in at a time and reports it as abandoned, once, when it
 * ends without `end()`: the user backs out, or the component unmounts.
 */
export function useSignInAbandon(): SignInAbandon {
  const current = useRef<{ startedAt: number; agent: string; method: string } | null>(null);

  const begin = useCallback((agent: string, method: string) => {
    if (ABANDONABLE.includes(method)) current.current = { startedAt: Date.now(), agent, method };
  }, []);
  const end = useCallback(() => {
    current.current = null;
  }, []);
  const abandon = useCallback((via: AbandonVia) => {
    const started = current.current;
    if (!started) return;
    current.current = null;
    trackEvent('cloud_provider_signin_abandoned', {
      provider: 'selfhosted',
      agent: started.agent,
      method: started.method,
      via,
      elapsed_ms: Date.now() - started.startedAt,
    });
  }, []);

  useEffect(() => () => abandon('closed'), [abandon]);

  return useMemo(() => ({ begin, end, abandon }), [begin, end, abandon]);
}
