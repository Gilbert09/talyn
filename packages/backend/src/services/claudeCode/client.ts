import { debugBus } from '../debugBus.js';

/**
 * Thin typed wrapper over Anthropic's **Managed Agents API** — the hosted
 * surface FastOwl delegates "Claude Code" cloud tasks to. The vendor runs the
 * agent loop in its own sandbox and (via the GitHub MCP) opens a PR; we kick it
 * off and reconcile status + transcript back. Endpoints + shapes confirmed by
 * the Phase 0 spike — see docs/CLOUD_PROVIDERS.md.
 *
 * Stateless: the Anthropic API key is passed in per-workspace by the caller
 * rather than held on a singleton, mirroring posthogCode/client.ts.
 */

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
export const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';
/** The GitHub MCP server the agent opens PRs through. */
export const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';
/** Required on every cloud run; kept current with the latest Opus. */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8';

export class ClaudeManagedAgentsClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = ANTHROPIC_BASE_URL,
  ) {}

  /**
   * Create an agent wired with the prebuilt toolset + the GitHub MCP (set to
   * `always_allow` so it can open a PR unattended). Reusable per workspace.
   */
  async createAgent(input: { name: string; model: string; system: string }): Promise<{ id: string }> {
    return this.request('POST', '/v1/agents', {
      name: input.name,
      model: input.model,
      system: input.system,
      tools: [
        { type: 'agent_toolset_20260401' },
        {
          type: 'mcp_toolset',
          mcp_server_name: 'github',
          default_config: { permission_policy: { type: 'always_allow' } },
        },
      ],
      mcp_servers: [{ type: 'url', name: 'github', url: GITHUB_MCP_URL }],
    });
  }

  /** Create the cloud sandbox a session runs in. Reusable per workspace. */
  async createEnvironment(name: string): Promise<{ id: string }> {
    return this.request('POST', '/v1/environments', { name });
  }

  /** Create a vault to hold the GitHub MCP credential. Reusable per workspace. */
  async createVault(displayName: string): Promise<{ id: string }> {
    return this.request('POST', '/v1/vaults', {
      display_name: displayName,
      metadata: { service: 'github' },
    });
  }

  /**
   * Store a GitHub token in the vault, bound to the GitHub MCP URL. The agent's
   * MCP calls authenticate via this credential (matched by URL at runtime).
   */
  async addVaultGitHubCredential(vaultId: string, githubToken: string): Promise<{ id: string }> {
    return this.request('POST', `/v1/vaults/${vaultId}/credentials`, {
      display_name: 'GitHub token',
      auth: {
        type: 'static_bearer',
        mcp_server_url: GITHUB_MCP_URL,
        token: githubToken,
      },
    });
  }

  /**
   * Start a session: bind the agent + environment + vault and mount the repo.
   * The session starts idle; the prompt is sent separately via `postUserMessage`.
   */
  async createSession(input: {
    agentId: string;
    environmentId: string;
    vaultId: string;
    repoUrl: string;
    githubToken: string;
  }): Promise<ManagedSession> {
    return this.request('POST', '/v1/sessions', {
      agent: input.agentId,
      environment_id: input.environmentId,
      vault_ids: [input.vaultId],
      resources: [
        {
          type: 'github_repository',
          url: input.repoUrl,
          authorization_token: input.githubToken,
        },
      ],
    });
  }

  /** Send the task prompt as the first user message — this starts the run. */
  async postUserMessage(sessionId: string, text: string): Promise<unknown> {
    return this.request('POST', `/v1/sessions/${sessionId}/events`, {
      events: [{ type: 'user.message', content: [{ type: 'text', text }] }],
    });
  }

  /**
   * List a session's events (the transcript source — `/events/stream` only
   * replays then closes, so we poll). Returns oldest-first; dedup by `id`.
   */
  async listEvents(sessionId: string, opts: { limit?: number } = {}): Promise<ManagedAgentRawEvent[]> {
    const limit = opts.limit ?? 1000;
    const data = await this.request<{ data?: ManagedAgentRawEvent[] }>(
      'GET',
      `/v1/sessions/${sessionId}/events?limit=${limit}`,
    );
    return Array.isArray(data?.data) ? data.data : [];
  }

  /** Fetch the session object (status, stop_reason, stats). */
  async getSession(sessionId: string): Promise<ManagedSession> {
    return this.request('GET', `/v1/sessions/${sessionId}`);
  }

  /** Interrupt an in-flight run (best-effort; pairs with deleteSession). */
  async interruptSession(sessionId: string): Promise<unknown> {
    return this.request('POST', `/v1/sessions/${sessionId}/events`, {
      events: [{ type: 'user.interrupt' }],
    });
  }

  /** Terminate + clean up a session (stops the runtime meter). */
  async deleteSession(sessionId: string): Promise<unknown> {
    return this.request('DELETE', `/v1/sessions/${sessionId}`);
  }

  /** Delete a vault (best-effort cleanup of a per-dispatch GitHub credential). */
  async deleteVault(vaultId: string): Promise<unknown> {
    return this.request('DELETE', `/v1/vaults/${vaultId}`);
  }

  /** Cheap auth/connectivity probe. Throws on bad key / unreachable host. */
  async ping(): Promise<void> {
    await this.request('GET', '/v1/agents?limit=1');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-beta': MANAGED_AGENTS_BETA,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      debugBus.recordHttp({
        service: 'claude_managed_agents',
        method,
        url,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    const text = await res.text();
    debugBus.recordHttp({
      service: 'claude_managed_agents',
      method,
      url,
      status: res.status,
      durationMs: Date.now() - startedAt,
      ok: res.ok,
      bytes: text.length,
      ...(res.ok ? {} : { error: text.slice(0, 500) }),
    });
    if (!res.ok) {
      throw new Error(
        `Claude Managed Agents ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`,
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/** Partial session shape — only the fields we read. */
export interface ManagedSession {
  id: string;
  status?: 'idle' | 'running' | string;
  stop_reason?: { type?: string } | null;
  stats?: { active_seconds?: number; duration_seconds?: number } | null;
  [k: string]: unknown;
}

/** A raw event from `GET /sessions/{id}/events` (converter input). */
export interface ManagedAgentRawEvent {
  id?: string;
  type?: string;
  [k: string]: unknown;
}
