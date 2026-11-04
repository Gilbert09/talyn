import { ApiNetworkError } from '@talyn/client';
import { captureAnalyticsException } from './analytics';

interface RequestFailure {
  error: unknown;
  method: string;
  path: string;
  status?: number;
  code?: string;
}
const lastReported = new Map<string, number>();
const ROUTE_PARTS = new Set([
  'workspaces', 'repositories', 'workbenches', 'chats', 'tasks', 'environments',
  'users', 'teams', 'sessions', 'pull-requests', 'prs', 'files', 'events',
  'messages', 'checkpoints', 'attachments', 'agents', 'runs', 'loops',
  'workflows', 'tokens', 'subscriptions', 'orders', 'billing', 'settings',
  'status', 'retry', 'archive', 'restore', 'send', 'scripts', 'run', 'stop',
  'api', 'v1', 'admin', 'history', 'preview', 'usage', 'config', 'git',
  'branch', 'branches', 'changes', 'diff', 'readiness', 'wake', 'queue',
]);

export function apiRoute(method: string, path: string): string {
  const pathname = path.split(/[?#]/, 1)[0];
  const parts = pathname.split('/').filter(Boolean).map((part) =>
    ROUTE_PARTS.has(part) ? part : ':id'
  );
  return `${method.toUpperCase()} /${parts.join('/')}`;
}

export function reportApiError({ error, method, path, status, code }: RequestFailure): void {
  if (status === undefined ? !(error instanceof ApiNetworkError) : status < 500) return;
  const route = apiRoute(method, path);
  const key = `${route}:${status ?? 'network'}`;
  const now = Date.now();
  if (now - (lastReported.get(key) ?? -Infinity) < 60_000) return;
  lastReported.set(key, now);
  const errorCode = code && code.length <= 64 && /^[a-z0-9_]+$/i.test(code) ? code : undefined;
  const safeError = new Error(`API request failed: ${route} (${status ?? 'network'})`);
  safeError.stack = undefined;
  captureAnalyticsException(safeError, {
    route,
    status: status ?? 0,
    error_code: errorCode ?? (status === undefined ? 'network_error' : undefined),
  });
}
