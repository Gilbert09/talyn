import type { McpInjection, McpProbeResult, McpServerDefinition } from '@talyn/shared';
import { fetchFailureReason, mcpFetch, readMcpBody, mcpJsonFrames } from './http.js';

/**
 * Talk to an MCP server directly: `initialize`, then `tools/list`.
 *
 * # Why the backend speaks MCP at all
 *
 * Two things need it and neither can be answered any other way. The Test button
 * has to say whether a credential actually works — and `initialize` is the
 * honest test, because it is defined by the protocol rather than by the vendor,
 * every server answers it first, and the reply NAMES the server. And the tool
 * picker needs the list of tool names, which only the server knows.
 *
 * This is the one place in Talyn that touches a vendor with a workspace's
 * credential in hand. Nothing from the response is kept except the server's own
 * name, its protocol version, tool metadata and a refusal's text: several
 * vendors put the submitted credential straight back in an error envelope.
 */

/** The revision we advertise. Servers negotiate down; none of them refuses. */
const PROTOCOL_VERSION = '2025-06-18';

/** Long enough for a cold serverless MCP endpoint, short enough that a Save
 *  button does not appear to hang. */
const PROBE_TIMEOUT_MS = 15_000;

/** A server answering megabytes to `tools/list` is one we cannot use anyway,
 *  and reading it all would be the DoS. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface ProbeInput {
  workspaceId?: string;
  url: string;
  authKind: McpServerDefinition['authKind'];
  inject?: McpInjection | null;
  secret?: string | null;
}

/**
 * Attach the credential the way the fleet's proxy would.
 *
 * Deliberately the same four shapes and the same precedence, because a probe
 * that authenticated differently from the dispatch would give a green tick to a
 * server the sandbox cannot reach.
 */
function applyAuth(input: ProbeInput, headers: Headers, url: URL): void {
  for (const [k, v] of Object.entries(input.inject?.extra ?? {})) {
    headers.set(k, v);
  }
  const secret = input.secret ?? '';
  if (!secret) return;
  switch (input.authKind) {
    case 'bearer':
      headers.set('Authorization', `Bearer ${secret}`);
      break;
    case 'header':
      if (input.inject?.header) {
        headers.set(input.inject.header, `${input.inject.prefix ?? ''}${secret}`);
      }
      break;
    case 'basic':
      headers.set(
        'Authorization',
        `Basic ${Buffer.from(`${input.inject?.user ?? ''}:${secret}`).toString('base64')}`
      );
      break;
    case 'query':
      if (input.inject?.param) url.searchParams.set(input.inject.param, secret);
      break;
    case 'none':
      break;
  }
}

interface RpcOutcome {
  status: number;
  result?: Record<string, unknown>;
  error?: string;
  sessionId?: string;
}

async function rpc(
  input: ProbeInput,
  method: string,
  params: Record<string, unknown>,
  id: number,
  sessionId: string | undefined,
  signal: AbortSignal
): Promise<RpcOutcome> {
  const url = new URL(input.url);
  const headers = new Headers({
    'content-type': 'application/json',
    // Both, because a server may answer either and refusing one is how you get
    // a 406 from a server that works fine.
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL_VERSION,
  });
  applyAuth(input, headers, url);
  if (sessionId) headers.set('mcp-session-id', sessionId);

  const resp = await mcpFetch(url.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal,
  }, input.workspaceId ? { workspaceId: input.workspaceId, purpose: 'probe' } : undefined);

  const returnedSession = resp.headers.get('mcp-session-id') ?? undefined;
  if (!resp.ok) {
    // An RFC 9728 challenge is a specific, actionable answer and not a generic
    // failure: the server works, it just wants to be signed in to.
    await resp.body?.cancel();
    const challenge = resp.headers.get('www-authenticate') ?? '';
    if (resp.status === 401) {
      return {
        status: resp.status,
        error: challenge.includes('resource_metadata')
          ? 'this server wants you to sign in rather than paste a key'
          : 'the server refused this credential',
        sessionId: returnedSession,
      };
    }
    return { status: resp.status, error: `the server answered ${resp.status}`, sessionId: returnedSession };
  }

  const contentType = resp.headers.get('content-type') ?? '';
  const raw = await readMcpBody(resp, MAX_BODY_BYTES, (text) =>
    mcpJsonFrames(contentType, text).some((frame) => (frame as { id?: unknown })?.id === id));
  for (const frame of mcpJsonFrames(contentType, raw)) {
    const f = frame as { id?: unknown; result?: unknown; error?: { message?: string } };
    if (f.id !== id) continue;
    if (f.error) {
      return { status: resp.status, error: 'the server refused this request', sessionId: returnedSession };
    }
    if (f.result && typeof f.result === 'object') {
      return { status: resp.status, result: f.result as Record<string, unknown>, sessionId: returnedSession };
    }
  }
  return { status: resp.status, error: 'the server did not answer this request', sessionId: returnedSession };
}

/**
 * Probe a server. Never throws: a refusal is a result, not an exception.
 *
 * `ok` is true only when a real `initialize` result came back, so a green tick
 * means a session genuinely opened rather than "something answered".
 */
export async function probeMcpServer(input: ProbeInput): Promise<McpProbeResult> {
  const at = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The MCP request timed out.', 'TimeoutError')), PROBE_TIMEOUT_MS);
  let sessionId: string | undefined;
  try {
    const init = await rpc(
      input,
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'talyn', version: '1' },
      },
      1,
      undefined,
      controller.signal
    );
    sessionId = init.sessionId;
    if (!init.result) {
      return { ok: false, at, status: init.status, detail: init.error ?? 'the server did not introduce itself' };
    }

    const info = (init.result.serverInfo ?? {}) as { name?: string; version?: string };
    const out: McpProbeResult = {
      ok: true,
      at,
      status: init.status,
      ...(info.name ? { serverName: String(info.name) } : {}),
      ...(typeof init.result.protocolVersion === 'string'
        ? { protocolVersion: init.result.protocolVersion }
        : {}),
    };

    // `notifications/initialized` is required by the spec before other calls,
    // and several servers reject tools/list without it.
    await notifyInitialized(input, init.sessionId, controller.signal);

    const collected = new Map<string, { name: string; title?: string; description?: string }>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const response = await rpc(input, 'tools/list', cursor ? { cursor } : {}, page + 2, init.sessionId, controller.signal);
      if (!Array.isArray(response.result?.tools)) {
        out.detail = 'Connected, but the tool list could not be read.';
        return out;
      }
      for (const value of response.result.tools) {
        if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.name) continue;
        collected.set(value.name, {
          name: value.name,
          ...(typeof value.title === 'string' ? { title: value.title.slice(0, 200) } : {}),
          ...(typeof value.description === 'string' ? { description: value.description.slice(0, 8000) } : {}),
        });
      }
      const next = response.result.nextCursor;
      if (typeof next !== 'string' || !next) {
        out.tools = [...collected.values()].sort((a, b) => a.name.localeCompare(b.name));
        out.toolNames = out.tools.map((tool) => tool.name);
        return out;
      }
      if (cursors.has(next) || collected.size > 10000) break;
      cursors.add(next);
      cursor = next;
    }
    out.detail = 'Connected, but the tool list is too large or repeats pages.';
    return out;
  } catch (err) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      at,
      detail: aborted
        ? `the server did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds`
        : `could not reach the server: ${fetchFailureReason(err)}`,
    };
  } finally {
    if (sessionId) await closeSession(input, sessionId, controller.signal);
    clearTimeout(timer);
  }
}

/** Best-effort: a server that ignores this is not a server that failed. */
async function notifyInitialized(
  input: ProbeInput,
  sessionId: string | undefined,
  signal: AbortSignal
): Promise<void> {
  try {
    const url = new URL(input.url);
    const headers = new Headers({
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
    });
    applyAuth(input, headers, url);
    if (sessionId) headers.set('mcp-session-id', sessionId);
    const response = await mcpFetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal,
    }, input.workspaceId ? { workspaceId: input.workspaceId, purpose: 'probe' } : undefined);
    await response.body?.cancel();
  } catch {
    // Ignored on purpose.
  }
}

async function closeSession(input: ProbeInput, sessionId: string, signal: AbortSignal): Promise<void> {
  try {
    const url = new URL(input.url);
    const headers = new Headers({ 'mcp-session-id': sessionId, 'mcp-protocol-version': PROTOCOL_VERSION });
    applyAuth(input, headers, url);
    const response = await mcpFetch(url.toString(), { method: 'DELETE', headers, signal },
      input.workspaceId ? { workspaceId: input.workspaceId, purpose: 'probe' } : undefined);
    await response.body?.cancel();
  } catch { /* Cleanup uses the probe deadline. */ }
}
