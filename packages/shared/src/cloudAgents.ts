/**
 * The agent picker, as one function.
 *
 * "Which agents can this workspace start a task on" is asked in four places
 * now: the per-PR task menu on the desktop, the same menu in the web fork, and
 * the agent field of the Loop editor on both. It was a `useMemo` inside
 * `useGitHubActions`, copied once into the web fork — and a menu written twice
 * is a menu that answers differently on each client.
 *
 * It lives here rather than in a hook because it is not React: it is a pure
 * derivation from the connected-provider list and the workspace's settings.
 * The forks keep their own components; what they must not fork is what the
 * product offers.
 *
 * # The two rules this encodes
 *
 *  - **The menu lists AGENTS, not providers.** Talyn Fleet runs on the
 *    workspace's own Claude subscription or its own Codex subscription, and
 *    "Talyn Fleet" alone cannot say which. A fleet with both connected
 *    contributes two entries; a fleet with neither contributes none. An agent
 *    that is not connected is never offered, because picking it produces a task
 *    the backend refuses at dispatch — a worse answer than not offering it.
 *  - **A fleet entry carries a MODEL, because the model carries the vendor.**
 *    `fleetProviderForModel` reads it and the fleet builds the microVM's egress
 *    route table from that. An agent name on the wire as well would be a second
 *    source of truth that can disagree with the first.
 */

import {
  DEFAULT_POSTHOG_CODE_MODEL_ID,
  FLEET_MODELS,
  POSTHOG_CODE_MODELS,
  defaultFleetModelForAgent,
  storedFleetModelForAgent,
  type FleetAgent,
  type WorkspaceSettings,
} from './index.js';

/**
 * What this function needs from a provider row.
 *
 * Structural rather than an import of `CloudProviderInfo`, which lives in
 * `@talyn/client` — a package that depends on this one. `type` stays a bare
 * string for the reason that type does: a released desktop binary reading a
 * newer backend must degrade rather than break the picker.
 */
export interface ConnectedCloudProvider {
  type: string;
  displayName: string;
  connected?: boolean;
  connectedAgents?: string[];
}

/** One entry in an agent menu. */
export interface CloudAgentChoice {
  /** The provider type, named `type` because every existing consumer reads it. */
  type: string;
  /** 'PostHog Code' | 'Talyn Fleet · Claude' | 'Talyn Fleet · Codex'. */
  displayName: string;
  /** Set for fleet entries only — the vendor whose subscription runs it. */
  agent?: FleetAgent;
  /** The model this entry dispatches at. Undefined where the provider has no choice. */
  model?: string;
  /** The catalogue this entry may pick from, for a model dropdown beside it. */
  models: readonly { id: string; label: string; blurb: string }[];
}

const AGENT_LABELS: Record<FleetAgent, string> = { claude: 'Claude', codex: 'Codex' };

/**
 * Every agent this workspace can start a task on, in provider order.
 *
 * Filters to connected providers itself, so a caller cannot forget to: a
 * provider row exists as soon as the env marker does, and the marker lingers
 * after a disconnect.
 */
export function cloudAgentChoices(
  providers: readonly ConnectedCloudProvider[] | null | undefined,
  settings: WorkspaceSettings | null | undefined
): CloudAgentChoice[] {
  return (providers ?? [])
    .filter((p) => p.connected !== false)
    .flatMap((p): CloudAgentChoice[] => {
      if (p.type !== 'selfhosted') {
        return [
          {
            type: p.type,
            displayName: p.displayName,
            model: DEFAULT_POSTHOG_CODE_MODEL_ID,
            models: POSTHOG_CODE_MODELS,
          },
        ];
      }
      const agents = (p.connectedAgents ?? []) as FleetAgent[];
      return agents.map((agent): CloudAgentChoice => ({
        type: p.type,
        displayName: `${p.displayName} · ${AGENT_LABELS[agent] ?? agent}`,
        agent,
        // The WORKSPACE's model for that agent, not the shipped default: this
        // once sent `defaultFleetModelForAgent` unconditionally, so "run this
        // on Codex" ignored Settings → Talyn Fleet → Model outright.
        model: storedFleetModelForAgent(settings, agent) ?? defaultFleetModelForAgent(agent),
        models: FLEET_MODELS.filter((m) =>
          agent === 'codex' ? m.provider === 'openai' : m.provider === 'anthropic'
        ),
      }));
    });
}
