type ProviderAgents = { type: string; connectedAgents?: string[] };

/**
 * True when the workspace has an agent that can start a session.
 *
 * A session runs on the fleet, so where the fleet is offered only Claude or
 * Codex counts. Where the fleet is not offered, PostHog Code is the only agent.
 */
export function sessionAgentConnected(
  cloudProviders: ProviderAgents[] | null,
  posthogConnected: boolean
): boolean {
  const fleet = cloudProviders?.find((provider) => provider.type === 'selfhosted');
  if (!fleet) return posthogConnected;
  const agents = fleet.connectedAgents ?? [];
  return agents.includes('claude') || agents.includes('codex');
}
