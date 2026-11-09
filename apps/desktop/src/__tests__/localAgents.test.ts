import type { McpToken } from '@talyn/shared';
import type { LocalAgentKitStatus, LocalAgentState } from '../main/localAgentKit';
import {
  agentsToConnect,
  connectedAgents,
  describeAgent,
  localTokenName,
  tokensToRevoke,
} from '../renderer/lib/localAgents';

const ENDPOINT = 'https://prod.talyn.dev/api/v1/mcp';
const NOW = Date.parse('2026-11-09T12:00:00Z');

function agent(over: Partial<LocalAgentState> & Pick<LocalAgentState, 'agent'>): LocalAgentState {
  return { detected: true, mcpUrl: null, tokenPrefix: null, skills: [], blockedSkills: [], ...over };
}

function status(claude: Partial<LocalAgentState>, codex: Partial<LocalAgentState>): LocalAgentKitStatus {
  return {
    hostname: 'laptop',
    pack: [],
    agents: [agent({ agent: 'claude', ...claude }), agent({ agent: 'codex', ...codex })],
  };
}

function token(id: string, prefix: string, name = 'Claude Code and Codex on laptop', expiresAt: string | null = '2027-02-01T00:00:00Z'): McpToken {
  return { id, name, tokenPrefix: prefix, createdAt: '2026-11-01T00:00:00Z', lastUsedAt: null, expiresAt };
}

const connected = (prefix: string) => ({ mcpUrl: ENDPOINT, tokenPrefix: prefix, skills: ['talyn-x'] });

describe('localTokenName', () => {
  it.each([
    ['Toms-MacBook-Pro.local', 'Claude Code and Codex on Toms-MacBook-Pro'],
    ['devbox', 'Claude Code and Codex on devbox'],
    ['', 'Claude Code and Codex'],
    ['x'.repeat(200), `Claude Code and Codex on ${'x'.repeat(55)}`],
  ])('names the token for %s', (host, name) => {
    expect(localTokenName(host)).toBe(name);
  });
});

describe('agentsToConnect', () => {
  it.each([
    ['both found', status({}, {}), ['claude', 'codex']],
    ['only Claude found', status({}, { detected: false }), ['claude']],
    ['Codex not found but connected', status({}, { detected: false, ...connected('p') }), ['claude', 'codex']],
    ['neither found', status({ detected: false }, { detected: false }), ['claude', 'codex']],
  ] as const)('%s', (_label, s, expected) => {
    expect(agentsToConnect(s)).toEqual(expected);
  });
});

describe('connectedAgents', () => {
  it('counts an agent with only skills as connected, so Disconnect clears it', () => {
    expect(connectedAgents(status({ skills: ['talyn-x'] }, {}))).toEqual(['claude']);
  });
});

describe('tokensToRevoke', () => {
  const old = token('old', 'talyn_mcp_old111');
  const fresh = token('new', 'talyn_mcp_new111');
  const manual = token('manual', 'talyn_mcp_man111', 'Laptop');

  it('revokes the token a reconnect replaced', () => {
    const before = status(connected(old.tokenPrefix), connected(old.tokenPrefix));
    const after = status(connected(fresh.tokenPrefix), connected(fresh.tokenPrefix));
    expect(tokensToRevoke([fresh, old, manual], before, after, fresh)).toEqual([old]);
  });

  it('keeps the old token while one agent still uses it', () => {
    const before = status(connected(old.tokenPrefix), connected(old.tokenPrefix));
    const after = status(connected(old.tokenPrefix), connected(fresh.tokenPrefix));
    expect(tokensToRevoke([fresh, old], before, after, fresh)).toEqual([]);
  });

  it('never revokes a token the person minted by hand', () => {
    const before = status(connected(manual.tokenPrefix), {});
    const after = status(connected(fresh.tokenPrefix), connected(fresh.tokenPrefix));
    expect(tokensToRevoke([fresh, manual], before, after, fresh)).toEqual([]);
  });

  it('revokes the new token when no agent took it', () => {
    const before = status(connected(old.tokenPrefix), {});
    expect(tokensToRevoke([fresh, old], before, before, fresh)).toEqual([fresh]);
  });

  it('revokes on disconnect', () => {
    const before = status(connected(old.tokenPrefix), connected(old.tokenPrefix));
    expect(tokensToRevoke([old, manual], before, status({}, {}))).toEqual([old]);
  });

  it('leaves tokens that were never installed here', () => {
    const elsewhere = token('other', 'talyn_mcp_oth111', 'Claude Code and Codex on desktop');
    const before = status(connected(old.tokenPrefix), {});
    expect(tokensToRevoke([old, elsewhere], before, status({}, {}))).toEqual([old]);
  });
});

describe('describeAgent', () => {
  const t = token('a', 'talyn_mcp_aaa111');
  it.each([
    ['not found', agent({ agent: 'codex', detected: false }), [t], 'muted', /^Not found/],
    ['not connected', agent({ agent: 'codex' }), [t], 'muted', /^Not connected$/],
    ['skills only', agent({ agent: 'codex', skills: ['x'] }), [t], 'warn', /MCP server missing/],
    ['another endpoint', agent({ agent: 'codex', mcpUrl: 'http://localhost:4747/api/v1/mcp', tokenPrefix: t.tokenPrefix }), [t], 'warn', /localhost/],
    ['tokens loading', agent({ agent: 'codex', mcpUrl: ENDPOINT, tokenPrefix: t.tokenPrefix }), null, 'ok', /^Connected$/],
    ['revoked token', agent({ agent: 'codex', mcpUrl: ENDPOINT, tokenPrefix: 'talyn_mcp_gone11' }), [t], 'warn', /revoked/],
    ['expired token', agent({ agent: 'codex', mcpUrl: ENDPOINT, tokenPrefix: t.tokenPrefix }), [token('a', t.tokenPrefix, t.name, '2026-11-01T00:00:00Z')], 'warn', /expired/],
    ['token expires soon', agent({ agent: 'codex', mcpUrl: ENDPOINT, tokenPrefix: t.tokenPrefix }), [token('a', t.tokenPrefix, t.name, '2026-11-15T00:00:00Z')], 'warn', /expires/],
    ['token never expires', agent({ agent: 'codex', mcpUrl: ENDPOINT, tokenPrefix: t.tokenPrefix }), [token('a', t.tokenPrefix, t.name, null)], 'ok', /^Connected$/],
    ['healthy', agent({ agent: 'codex', mcpUrl: ENDPOINT, tokenPrefix: t.tokenPrefix }), [t], 'ok', /^Connected until/],
  ] as const)('%s', (_label, state, tokens, tone, text) => {
    const summary = describeAgent(state, ENDPOINT, tokens as McpToken[] | null, NOW);
    expect(summary.tone).toBe(tone);
    expect(summary.text).toMatch(text);
  });
});
