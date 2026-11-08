import { lookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { randomUUID } from 'node:crypto';
import { getPrivateConnector, mapPrivateRoutesError, workspaceMayUsePrivateRoutes } from '../selfHosted/privateRoutes.js';
import { dialError, evictPrivateConnections, McpTransportError, privateDispatcher } from './privateTcp.js';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && /^[23]/.test(address) && !blocked.check(address, 'ipv6');
}

// Check the addresses used by the connection to prevent DNS rebinding.
export const lookupPublicAddress: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error, '', 4);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      return callback(new Error('The server address must be public.'), '', 4);
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};

const dispatcher = new Agent({ connect: { lookup: lookupPublicAddress } });

export function publicHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))
      return null;
    if (isIP(hostname) && !isPublicAddress(hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export interface McpRequestContext {
  workspaceId: string;
  purpose: 'discovery' | 'registration' | 'exchange' | 'refresh' | 'probe' | 'account' | 'validation';
  requestId?: string;
}

/** Validate syntax without granting network access. */
export function mcpHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url.toString() : null;
  } catch { return null; }
}

export function fetchFailureReason(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  if (cause instanceof McpTransportError) return cause.message;
  if (cause instanceof Error && cause.name === 'TimeoutError') return 'the request timed out';
  if (cause instanceof Error && cause.name === 'AbortError') return 'the request was cancelled';
  const code = (cause as { code?: string } | null)?.code;
  if (cause instanceof Error && cause.message === 'unexpected redirect') return 'the server redirected to another address';
  if (cause instanceof Error && cause.message === 'The server address must be public.')
    return 'Add an exact private route for this hostname and port, or use a public server address.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return 'the address cannot be resolved from Talyn’s servers. Check its exact private route';
  if (code === 'ECONNREFUSED') return 'the server refused the connection';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'the connection timed out';
  if (code?.includes('CERT') || code?.includes('TLS') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    return 'TLS certificate verification failed. Check the certificate and hostname';
  return 'the connection failed';
}

export async function selectMcpDestination(url: string, context?: McpRequestContext, signal?: AbortSignal): Promise<{
  url: URL; connectorId?: string; state?: string;
}> {
  const safe = mcpHttpsUrl(url);
  if (!safe) throw new Error('Use a public HTTPS server address or an exact private HTTPS route.');
  const target = new URL(safe);
  const host = target.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const port = Number(target.port || 443);
  if (context) {
    try {
      if (await workspaceMayUsePrivateRoutes(context.workspaceId)) {
        const connector = await getPrivateConnector(context.workspaceId, signal);
        const state = JSON.stringify([connector.id, connector.status, connector.routes]);
        evictPrivateConnections(context.workspaceId, state);
        if (connector.workspaceId !== context.workspaceId)
          throw new McpTransportError('workspace_mismatch', 'The private connector belongs to another workspace.');
        if (connector.routes.some((route) => route.host === host && route.port === port)) {
          if (connector.status !== 'connected')
            throw new McpTransportError('connector_not_connected', 'The private connector is not connected. Check its status.', connector.id);
          return { url: target, connectorId: connector.id, state };
        }
      } else evictPrivateConnections(context.workspaceId);
    } catch (error) {
      if (error instanceof McpTransportError) throw error;
      const mapped = mapPrivateRoutesError(error);
      evictPrivateConnections(context.workspaceId);
      if (mapped.status !== 404) throw mapped.status === 503 ? dialError(503) : new McpTransportError(mapped.code, mapped.message);
    }
  }
  if (!publicHttpsUrl(safe))
    throw new McpTransportError('route_missing', 'Use a public HTTPS address or add its exact private route.');
  return { url: target };
}

export async function mcpFetch(url: string, init: RequestInit = {}, context?: McpRequestContext): Promise<Response> {
  const started = Date.now();
  const requestId = context?.requestId ?? randomUUID();
  // Callers retain their existing deadline through response consumption.
  const signal = init.signal ?? AbortSignal.timeout(15_000);
  let current = url;
  let headers = new Headers(init.headers);
  const privateDestinations = new Map<string, string>();
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    let connectorId: string | undefined;
    let destination: URL | undefined = mcpHttpsUrl(current) ? new URL(current) : undefined;
    let transport = 'unselected';
    let release: (() => void) | undefined;
    let result = 'failed';
    let audited = false;
    let deferred = false;
    const audit = (error?: unknown) => {
      if (audited) return;
      audited = true;
      if (error) {
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        if (cause instanceof McpTransportError) result = cause.code;
        else if (signal.aborted) result = signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled';
        else result = cause instanceof Error && cause.message === 'The server response is too large.' ? 'response_too_large' : 'failed';
      }
      if (context) console.info('[mcp-transport]', {
        workspaceId: context.workspaceId, connectorId: connectorId ?? null,
        destination: destination ? { host: destination.hostname, port: Number(destination.port || 443) } : null,
        transport, purpose: context.purpose, result, durationMs: Date.now() - started, requestId,
      });
    };
    try {
      const selected = await abortable(selectMcpDestination(current, context, signal), signal);
      destination = selected.url;
      connectorId = selected.connectorId;
      transport = connectorId ? 'private' : 'public';
      const bindingKey = JSON.stringify([
        destination.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase(),
        Number(destination.port || 443),
      ]);
      const previousConnector = privateDestinations.get(bindingKey);
      if (previousConnector && previousConnector !== connectorId) {
        connectorId = previousConnector;
        transport = 'private';
        throw new McpTransportError('route_changed', 'The private route changed. Retry this request.');
      }
      if (connectorId) privateDestinations.set(bindingKey, connectorId);
      let selectedDispatcher = dispatcher;
      if (connectorId && context) {
        const connection = privateDispatcher(context.workspaceId, connectorId,
          destination.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase(),
          Number(destination.port || 443), destination.hostname.replace(/^\[|\]$/g, ''), selected.state!, signal);
        selectedDispatcher = connection.agent;
        let checking = false;
        const selectedUrl = destination.toString();
        const poll = setInterval(() => {
          if (checking) return;
          checking = true;
          void selectMcpDestination(selectedUrl, context, signal)
            .catch(() => evictPrivateConnections(context.workspaceId))
            .finally(() => { checking = false; });
        }, 2_000);
        poll.unref();
        release = () => {
          clearInterval(poll);
          signal.removeEventListener('abort', release!);
          connection.release();
        };
        signal.addEventListener('abort', release, { once: true });
      }
      const response = await fetch(destination.toString(), {
        ...init, headers, signal, redirect: 'manual', dispatcher: selectedDispatcher,
      } as RequestInit);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        release?.();
        // Never replay a POST, exchange, registration, or tool call.
        if (!['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase()) || redirects >= 5)
          throw new McpTransportError('redirect_refused', 'The server redirected this request. Use its final address.');
        const location = response.headers.get('location');
        if (!location) throw new McpTransportError('redirect_refused', 'The server returned a redirect without an address.');
        const next = new URL(location, destination);
        if (next.origin !== destination.origin) {
          const accept = headers.get('accept');
          headers = new Headers(accept ? { accept } : undefined);
        }
        current = next.toString();
        result = 'redirect';
        continue;
      }
      result = String(response.status);
      deferred = true;
      return observeResponse(response, (error) => { release?.(); audit(error); });
    } catch (error) {
      release?.();
      if (connectorId && context) evictPrivateConnections(context.workspaceId);
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      if (cause instanceof McpTransportError) {
        result = cause.code;
        connectorId ??= cause.connectorId;
        if (connectorId) transport = 'private';
      } else if (signal.aborted) result = signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled';
      audit(error);
      throw error;
    } finally {
      if (!deferred) audit();
    }
  }
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function observeResponse(response: Response, finish: (error?: unknown) => void): Response {
  const reader = response.body?.getReader();
  if (!reader) { finish(); return response; }
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); finish(); }
        else controller.enqueue(value);
      } catch (error) { controller.error(error); finish(error); }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { finish(reason); }
    },
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Parse only complete SSE events. A data field can contain several lines. */
export function mcpJsonFrames(contentType: string, body: string): unknown[] {
  const frames = contentType.includes('text/event-stream')
    ? body.split(/\r?\n\r?\n/).slice(0, -1).map((event) => event.split(/\r?\n/)
      .filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n'))
    : [body];
  return frames.flatMap((frame) => {
    try { return [JSON.parse(frame) as unknown]; } catch { return []; }
  });
}

export async function readMcpBody(
  response: Response,
  limit: number,
  complete?: (text: string) => boolean
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let failure: unknown;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('The server response is too large.');
      text += decoder.decode(value, { stream: true });
      if (complete?.(text)) return text;
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await reader.cancel(failure);
  }
}
