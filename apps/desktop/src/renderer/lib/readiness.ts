import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  WorkbenchAgent,
  WorkbenchLocalReadiness,
  WorkbenchReadiness,
} from '@talyn/shared';
import { api, ApiNetworkError } from './api';
import { getWorkbenchBridge } from './workbenchBridge';

export type SandboxReadiness = WorkbenchReadiness['sandbox'];
export type WorkbenchRuntime = 'sandbox' | 'local';

export interface ReadinessState {
  sandbox: SandboxReadiness | null;
  local: WorkbenchLocalReadiness | null;
}

export interface Choice {
  available: boolean;
  reason?: string;
  /** Does not block the choice (for example, no terminal). */
  warning?: string;
}

const AGENT_NAMES: Record<WorkbenchAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

function localAgentChoice(
  local: WorkbenchLocalReadiness | null,
  agent: WorkbenchAgent,
): Choice {
  if (!local)
    return { available: false, reason: 'Local tools are only available in the desktop app' };
  if (!local.git.ok) return { available: false, reason: 'Git is not installed on this machine' };
  if (!local[agent].ok)
    return {
      available: false,
      reason: `${AGENT_NAMES[agent]} is not installed on this machine`,
    };
  return local.pty.ok
    ? { available: true }
    : {
        available: true,
        warning: `The terminal is unavailable${local.pty.error ? `: ${local.pty.error}` : ''}`,
      };
}

export function agentChoice(
  readiness: ReadinessState,
  runtime: WorkbenchRuntime,
  agent: WorkbenchAgent,
): Choice {
  if (runtime === 'local') return localAgentChoice(readiness.local, agent);
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

export function runtimeChoice(
  readiness: ReadinessState,
): Record<WorkbenchRuntime, Choice> {
  const agents: WorkbenchAgent[] = ['claude', 'codex'];
  const pick = (runtime: WorkbenchRuntime): Choice => {
    const choices = agents.map((agent) => agentChoice(readiness, runtime, agent));
    const usable = choices.find((choice) => choice.available);
    if (usable) return usable;
    return { available: false, reason: choices[0]?.reason };
  };
  return { sandbox: pick('sandbox'), local: pick('local') };
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
  const [state, setState] = useState<ReadinessState>({ sandbox: null, local: null });
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const call = ++latest.current;
    setLoading(true);
    const bridge = getWorkbenchBridge();
    const [sandbox, local] = await Promise.all([
      workspaceId
        ? api.workbenches
            .readiness(workspaceId)
            .then((value) => value.sandbox)
            .catch(unreachable)
        : Promise.resolve(null),
      bridge?.readiness
        ? bridge.readiness().catch(() => null)
        : Promise.resolve(null),
    ]);
    if (call !== latest.current) return;
    setState({ sandbox, local });
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
