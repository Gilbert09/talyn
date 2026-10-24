import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkbenchAgent, WorkbenchReadiness } from '@talyn/shared';
import { api, ApiNetworkError } from './api';

/**
 * Whether a new session can start, and with which agent. The browser has only
 * the sandbox runtime, so there is no runtime choice and no local half: the
 * desktop app's `local` readiness comes from its Electron bridge.
 */

export type SandboxReadiness = WorkbenchReadiness['sandbox'];

export interface ReadinessState {
  sandbox: SandboxReadiness | null;
}

export interface Choice {
  available: boolean;
  reason?: string;
  /** Does not block the choice. */
  warning?: string;
}

const AGENT_NAMES: Record<WorkbenchAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export function agentChoice(readiness: ReadinessState, agent: WorkbenchAgent): Choice {
  const { sandbox } = readiness;
  if (!sandbox) return { available: false, reason: 'Checking cloud availability' };
  if (!sandbox.ok)
    return { available: false, reason: sandbox.reasons[0]?.message ?? 'Cloud sessions are unavailable' };
  const entry = sandbox.agents?.[agent];
  if (entry && !entry.ok)
    return {
      available: false,
      reason: entry.reason?.message ?? `${AGENT_NAMES[agent]} is not connected`,
    };
  return { available: true };
}

/** Whether a session can start at all: the first agent that can run, or why none can. */
export function sandboxChoice(readiness: ReadinessState): Choice {
  const agents: WorkbenchAgent[] = ['claude', 'codex'];
  const choices = agents.map((agent) => agentChoice(readiness, agent));
  return choices.find((choice) => choice.available) ?? { available: false, reason: choices[0]?.reason };
}

const UNREACHABLE_RETRY_MS = 10_000;

export function isUnreachable(sandbox: SandboxReadiness | null): boolean {
  return sandbox?.reasons[0]?.code === 'unreachable';
}

function unreachable(error: unknown): SandboxReadiness {
  const offline = error instanceof ApiNetworkError && !error.online;
  return {
    ok: false,
    reasons: [
      {
        code: 'unreachable',
        message: offline ? 'You are offline' : 'Talyn’s server is not responding',
      },
    ],
    agents: {
      claude: { ok: false },
      codex: { ok: false },
    },
  };
}

export function useReadiness(workspaceId: string | null | undefined): ReadinessState & {
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<ReadinessState>({ sandbox: null });
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const call = ++latest.current;
    setLoading(true);
    const sandbox = workspaceId
      ? await api.workbenches
          .readiness(workspaceId)
          .then((value) => value.sandbox)
          .catch(unreachable)
      : null;
    if (call !== latest.current) return;
    setState({ sandbox });
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      latest.current++;
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const down = isUnreachable(state.sandbox);
  useEffect(() => {
    if (!down) return undefined;
    const timer = window.setTimeout(() => void refresh(), UNREACHABLE_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [down, state.sandbox, refresh]);

  return { ...state, loading, refresh };
}
