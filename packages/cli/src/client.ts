import type { ApiResponse } from '@talyn/shared';
import { getAuthToken } from './config.js';

const DEFAULT_BASE = process.env.TALYN_API_URL || 'http://localhost:4747';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Loopback hosts where plain http is fine (nothing leaves the machine). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Refuse to attach the bearer token to a plaintext-HTTP URL on a non-local
 * host: TALYN_API_URL is attacker-influenceable config, and an http:// base
 * would ship the account token over the wire in the clear.
 */
export function assertTokenSafeBase(base: string): void {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ApiError(`Invalid TALYN_API_URL: ${base}`, 0);
  }
  if (url.protocol === 'https:') return;
  if (LOOPBACK_HOSTS.has(url.hostname)) return;
  throw new ApiError(
    `Refusing to send the auth token over ${url.protocol}// to non-local host "${url.hostname}". ` +
      'Use an https:// TALYN_API_URL (or localhost for a dev backend).',
    0
  );
}

/** Thin fetch wrapper that unwraps ApiResponse<T> and throws on error. */
export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  base: string = DEFAULT_BASE
): Promise<T> {
  const url = `${base}/api/v1${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getAuthToken();
  if (token) {
    assertTokenSafeBase(base);
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    throw new ApiError(
      'Not authenticated. Set TALYN_AUTH_TOKEN or run `fastowl token set <token>` with a ' +
        'Talyn access token (your Supabase session JWT). Note: tokens minted in the desktop ' +
        'app under Settings → MCP server only authenticate the hosted MCP endpoint, not the CLI.',
      401
    );
  }

  let payload: ApiResponse<T>;
  try {
    payload = (await res.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError(`Invalid JSON from ${url}`, res.status);
  }

  if (!payload.success) {
    throw new ApiError(payload.error || `${method} ${path} failed`, res.status);
  }
  return payload.data as T;
}

export function baseUrl(): string {
  return DEFAULT_BASE;
}
