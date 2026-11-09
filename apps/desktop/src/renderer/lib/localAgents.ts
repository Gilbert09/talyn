import type { McpToken } from '@talyn/shared';
import type { LocalAgent, LocalAgentKitStatus, LocalAgentState } from '../../main/localAgentKit';

/**
 * The token decisions for Settings → MCP server → "Connect this computer".
 * Kept apart from the component so the rules about which token to revoke are
 * tested on their own: a wrong answer here disconnects somebody's Claude.
 */

/** Every token this flow mints starts with this name. Only those are ever revoked. */
export const LOCAL_TOKEN_NAME_PREFIX = 'Claude Code and Codex';

export function localTokenName(hostname: string): string {
  const host = hostname.trim().replace(/\.local$/i, '');
  return host ? `${LOCAL_TOKEN_NAME_PREFIX} on ${host}`.slice(0, 80) : LOCAL_TOKEN_NAME_PREFIX;
}

export const AGENT_LABEL: Record<LocalAgent, string> = { claude: 'Claude Code', codex: 'Codex' };

function hasTalyn(state: LocalAgentState): boolean {
  return state.mcpUrl !== null || state.skills.length > 0;
}

/** The agents that a Connect writes: those on this computer, or both when neither is found. */
export function agentsToConnect(status: LocalAgentKitStatus): LocalAgent[] {
  const found = status.agents.filter((a) => a.detected || hasTalyn(a)).map((a) => a.agent);
  return found.length > 0 ? found : status.agents.map((a) => a.agent);
}

/** The agents that a Disconnect clears. */
export function connectedAgents(status: LocalAgentKitStatus): LocalAgent[] {
  return status.agents.filter(hasTalyn).map((a) => a.agent);
}

/**
 * Tokens to revoke after an install or a remove: tokens this flow minted
 * whose prefix was configured `before` and that no agent uses `after`. A
 * token the person minted by hand and pasted into a config is never revoked:
 * it can also be in use somewhere this app cannot see.
 */
export function tokensToRevoke(
  tokens: McpToken[],
  before: LocalAgentKitStatus,
  after: LocalAgentKitStatus,
  minted?: McpToken
): McpToken[] {
  const inUse = new Set(after.agents.map((a) => a.tokenPrefix).filter(Boolean));
  const wasUsed = new Set(before.agents.map((a) => a.tokenPrefix).filter(Boolean));
  const out = tokens.filter(
    (t) =>
      t.id !== minted?.id &&
      t.name.startsWith(LOCAL_TOKEN_NAME_PREFIX) &&
      wasUsed.has(t.tokenPrefix) &&
      !inUse.has(t.tokenPrefix)
  );
  // The install failed for every agent: the new token is in no config.
  if (minted && !inUse.has(minted.tokenPrefix)) out.push(minted);
  return out;
}

export type AgentTone = 'ok' | 'warn' | 'muted';

export interface AgentSummary {
  tone: AgentTone;
  text: string;
}

const fmt = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** One line about one agent. `tokens` is null while the list loads. */
export function describeAgent(
  state: LocalAgentState,
  endpoint: string,
  tokens: McpToken[] | null,
  now: number = Date.now()
): AgentSummary {
  if (state.mcpUrl === null) {
    if (state.skills.length > 0) return { tone: 'warn', text: 'Skills installed, MCP server missing. Reconnect.' };
    return state.detected
      ? { tone: 'muted', text: 'Not connected' }
      : { tone: 'muted', text: 'Not found on this computer' };
  }
  if (state.mcpUrl !== endpoint) {
    return { tone: 'warn', text: `Connected to ${state.mcpUrl}, not to this Talyn. Reconnect to change it.` };
  }
  if (tokens === null) return { tone: 'ok', text: 'Connected' };
  const token = tokens.find((t) => t.tokenPrefix === state.tokenPrefix);
  if (!token) return { tone: 'warn', text: 'Its token is revoked or unknown. Reconnect.' };
  if (!token.expiresAt) return { tone: 'ok', text: 'Connected' };
  const left = new Date(token.expiresAt).getTime() - now;
  if (left <= 0) return { tone: 'warn', text: 'Its token expired. Reconnect.' };
  if (left < 14 * 86_400_000) return { tone: 'warn', text: `Connected. The token expires ${fmt(token.expiresAt)}.` };
  return { tone: 'ok', text: `Connected until ${fmt(token.expiresAt)}` };
}
