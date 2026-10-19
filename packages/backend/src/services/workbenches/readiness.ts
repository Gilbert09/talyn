import type {
  WorkbenchAgent,
  WorkbenchAgentReadiness,
  WorkbenchReadiness,
  WorkbenchReadinessReason,
} from '@talyn/shared';
import { fleetRefusalReason, workspaceMayUseFleet } from '../cloudProviders/fleetAccess.js';
import { getCloudProvider } from '../cloudProviders/registry.js';
import { fleetAgentStatus } from '../selfHosted/credentials.js';
import { userMayUseWorkbenches, workbenchesRefusalReason } from './access.js';
import { fleetDeploymentGap, fleetNotDeployedMessage, WorkbenchError } from './errors.js';

/**
 * What this backend can run for a workspace, asked BEFORE a create so the UI
 * can disable a choice and say why. The create and retry routes refuse on the
 * same answer, so the two cannot disagree.
 *
 * No network call to the fleet: every check reads config, a flag or the
 * workspace's credential row. A sandbox that would fail later for a reason
 * only the fleet knows (no capacity) still fails on the workbench, visibly.
 */

const AGENT_LABEL: Record<WorkbenchAgent, string> = { claude: 'Claude', codex: 'Codex' };

export interface ReadinessUser {
  id: string;
  email?: string | null;
}

export async function workbenchReadiness(workspaceId: string, user: ReadinessUser): Promise<WorkbenchReadiness> {
  const reasons: WorkbenchReadinessReason[] = [];

  if (!(await userMayUseWorkbenches({ distinctId: user.id, email: user.email }))) {
    reasons.push({ code: 'flag_off', message: `Sessions are not available: ${workbenchesRefusalReason()}.` });
  }
  if (!getCloudProvider('selfhosted')) {
    reasons.push({
      code: 'fleet_disabled',
      message: 'Talyn Fleet is not enabled on this backend: set FLEET_ENABLED=true.',
    });
  }
  if (fleetDeploymentGap()) {
    reasons.push({ code: 'fleet_not_deployed', message: fleetNotDeployedMessage() });
  }
  if (!(await workspaceMayUseFleet(workspaceId))) {
    reasons.push({ code: 'fleet_not_allowed', message: `Talyn Fleet is not available: ${fleetRefusalReason()}.` });
  }

  const status = await fleetAgentStatus(workspaceId);
  const connected = status.connectedAgents ?? [];
  const reauth = status.reauthAgents ?? [];
  const agentReadiness = (agent: WorkbenchAgent): WorkbenchAgentReadiness => {
    const label = AGENT_LABEL[agent];
    if (!connected.includes(agent)) {
      return {
        ok: false,
        reason: {
          code: 'agent_not_connected',
          message: `No ${label} subscription is connected to this workspace. Connect it in Settings → Talyn Fleet.`,
        },
      };
    }
    if (reauth.includes(agent)) {
      return {
        ok: false,
        reason: {
          code: 'agent_reauth_required',
          message: `The ${label} sign-in for this workspace has expired. Reconnect it in Settings → Talyn Fleet.`,
        },
      };
    }
    return { ok: true };
  };
  const agents: Record<WorkbenchAgent, WorkbenchAgentReadiness> = {
    claude: agentReadiness('claude'),
    codex: agentReadiness('codex'),
  };

  return {
    sandbox: {
      ok: reasons.length === 0 && Object.values(agents).some((a) => a.ok),
      reasons,
      agents,
    },
  };
}

/** The HTTP status for a reason, when a route refuses on it. */
const REASON_STATUS: Record<string, number> = {
  flag_off: 403,
  fleet_disabled: 503,
  fleet_not_deployed: 503,
  fleet_not_allowed: 403,
  agent_not_connected: 409,
  agent_reauth_required: 409,
};

/**
 * Why a sandbox workbench on `agent` cannot start now, as the error a route
 * answers with; null when it can. The first global reason wins, then the
 * agent's own.
 */
export function sandboxRefusal(readiness: WorkbenchReadiness, agent: WorkbenchAgent): WorkbenchError | null {
  const reason = readiness.sandbox.reasons[0] ?? readiness.sandbox.agents[agent]?.reason;
  if (!reason) return null;
  return new WorkbenchError(reason.message, REASON_STATUS[reason.code] ?? 409, reason.code);
}
