// Reading how much of a subscription is used, from the vendors' own usage
// endpoints. Both are private (the Claude and Codex CLIs call them), so every
// parser here is defensive and answers `null` for a shape it does not know.
// Unknown usage must read as "not over": a changed response should never park
// a working account.
//
// Pure pieces (parse, threshold, staleness, single-flight) are exported on
// their own. Storing snapshots and calling this at dispatch is not done here.

import { debugBus } from '../debugBus.js';

export interface UsageWindow {
  key: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  /** Model family this window applies to, e.g. "Opus". Absent = every model. */
  scopeModel?: string;
}

export type UsageSnapshot =
  | { fetchedAt: string; windows: UsageWindow[] }
  | { fetchedAt: string; error: string };

export type UsageFetchResult =
  | { ok: true; windows: UsageWindow[] }
  | { ok: false; error: string; tokenExpired?: boolean };

type FetchImpl = typeof fetch;

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const USAGE_TIMEOUT_MS = 10_000;

const FIVE_HOURS_S = 5 * 3600;
const WEEK_S = 7 * 24 * 3600;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toPercent(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, v);
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ---- Claude ---------------------------------------------------------------

function claudeScopeModel(scope: unknown): string | undefined {
  if (!isRecord(scope) || !isRecord(scope.model)) return undefined;
  const name = scope.model.display_name;
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

function claudeLimitLabel(kind: string, group: string, scopeModel?: string): string {
  if (group === 'session' || kind === 'session') return '5-hour';
  if (group === 'weekly' || kind.startsWith('weekly')) {
    return scopeModel ? `Weekly (${scopeModel})` : 'Weekly';
  }
  return kind.replace(/_/g, ' ') || 'Limit';
}

const CLAUDE_LEGACY_KEYS: Array<{ field: string; key: string; label: string; scopeModel?: string }> = [
  { field: 'five_hour', key: 'session', label: '5-hour' },
  { field: 'seven_day', key: 'weekly_all', label: 'Weekly' },
  { field: 'seven_day_opus', key: 'weekly_opus', label: 'Weekly (Opus)', scopeModel: 'Opus' },
  { field: 'seven_day_sonnet', key: 'weekly_sonnet', label: 'Weekly (Sonnet)', scopeModel: 'Sonnet' },
];

export function parseClaudeUsage(body: unknown): UsageWindow[] | null {
  if (!isRecord(body)) return null;

  const windows: UsageWindow[] = [];
  if (Array.isArray(body.limits)) {
    for (const raw of body.limits) {
      if (!isRecord(raw)) continue;
      const percent = toPercent(raw.percent);
      if (percent === null) continue;
      const kind = typeof raw.kind === 'string' ? raw.kind : '';
      const group = typeof raw.group === 'string' ? raw.group : '';
      const scopeModel = claudeScopeModel(raw.scope);
      windows.push({
        key: scopeModel ? `${kind || group}:${scopeModel.toLowerCase()}` : kind || group || 'limit',
        label: claudeLimitLabel(kind, group, scopeModel),
        usedPercent: percent,
        resetsAt: isoOrNull(raw.resets_at),
        ...(scopeModel ? { scopeModel } : {}),
      });
    }
  }
  if (windows.length > 0) return windows;

  // Only the four named windows. Other top-level objects can be dollar credit
  // pools, which are not limits.
  for (const legacy of CLAUDE_LEGACY_KEYS) {
    const raw = body[legacy.field];
    if (!isRecord(raw)) continue;
    const percent = toPercent(raw.utilization);
    if (percent === null) continue;
    windows.push({
      key: legacy.key,
      label: legacy.label,
      usedPercent: percent,
      resetsAt: isoOrNull(raw.resets_at),
      ...(legacy.scopeModel ? { scopeModel: legacy.scopeModel } : {}),
    });
  }
  return windows.length > 0 ? windows : null;
}

// ---- Codex ----------------------------------------------------------------

function codexWindowLabel(seconds: unknown): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return 'Limit';
  if (seconds === FIVE_HOURS_S) return '5-hour';
  if (seconds === WEEK_S) return 'Weekly';
  if (seconds % 86400 === 0) return `${seconds / 86400}-day`;
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour`;
  return 'Limit';
}

function codexResetsAt(w: Record<string, unknown>, now: number): string | null {
  if (typeof w.reset_at === 'number' && Number.isFinite(w.reset_at)) {
    return new Date(w.reset_at * 1000).toISOString();
  }
  if (typeof w.reset_after_seconds === 'number' && Number.isFinite(w.reset_after_seconds)) {
    return new Date(now + w.reset_after_seconds * 1000).toISOString();
  }
  return null;
}

function codexWindowsFrom(
  rateLimit: Record<string, unknown>,
  prefix: string,
  labelPrefix: string,
  now: number
): UsageWindow[] {
  const out: UsageWindow[] = [];
  const forced = rateLimit.limit_reached === true;
  for (const name of ['primary_window', 'secondary_window'] as const) {
    const w = rateLimit[name];
    if (!isRecord(w)) continue;
    const percent = toPercent(w.used_percent);
    if (percent === null && !forced) continue;
    const label = codexWindowLabel(w.limit_window_seconds);
    out.push({
      key: `${prefix}${name === 'primary_window' ? 'primary' : 'secondary'}`,
      label: labelPrefix ? `${labelPrefix} ${label}` : label,
      usedPercent: forced ? 100 : (percent as number),
      resetsAt: codexResetsAt(w, now),
    });
  }
  if (forced && out.length === 0) {
    out.push({
      key: `${prefix}limit`,
      label: labelPrefix ? `${labelPrefix} limit` : 'Limit',
      usedPercent: 100,
      resetsAt: null,
    });
  }
  return out;
}

export function parseCodexUsage(body: unknown, now: number = Date.now()): UsageWindow[] | null {
  if (!isRecord(body)) return null;

  const windows: UsageWindow[] = [];
  if (isRecord(body.rate_limit)) {
    windows.push(...codexWindowsFrom(body.rate_limit, '', '', now));
  }

  const extras = body.additional_rate_limits;
  const entries: unknown[] = Array.isArray(extras)
    ? extras
    : isRecord(extras)
      ? Object.values(extras)
      : [];
  entries.forEach((entry, i) => {
    if (!isRecord(entry)) return;
    const limit = isRecord(entry.rate_limit) ? entry.rate_limit : entry;
    const name =
      typeof entry.limit_name === 'string'
        ? entry.limit_name
        : typeof entry.metered_feature === 'string'
          ? entry.metered_feature
          : `extra ${i + 1}`;
    windows.push(...codexWindowsFrom(limit, `extra${i}:`, name, now));
  });

  return windows.length > 0 ? windows : null;
}

// ---- Threshold and staleness ---------------------------------------------

/**
 * Is any window that applies to this run at or past the threshold?
 *
 * A model-scoped window applies only when the run's model contains the scope's
 * name ("Opus" in "claude-opus-4-8"). With no model given, or no scope on the
 * window, it counts: being unsure must not hide a spent account.
 */
export function isOverThreshold(
  windows: UsageWindow[],
  thresholdPercent: number,
  model?: string
): boolean {
  const m = model?.toLowerCase();
  return windows.some((w) => {
    if (w.scopeModel && m && !m.includes(w.scopeModel.toLowerCase())) return false;
    return w.usedPercent >= thresholdPercent;
  });
}

export function usageIsStale(
  snapshot: { fetchedAt: string } | null | undefined,
  maxAgeMs: number,
  now: number = Date.now()
): boolean {
  if (!snapshot) return true;
  const t = Date.parse(snapshot.fetchedAt);
  if (Number.isNaN(t)) return true;
  return now - t > maxAgeMs;
}

// ---- Single-flight --------------------------------------------------------

const inFlight = new Map<string, Promise<unknown>>();

/** Concurrent callers for one key share one run of `fn` in this process. */
export function refreshOnce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => {
    if (inFlight.get(key) === p) inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

// ---- Fetch ----------------------------------------------------------------

async function getJson(
  service: 'anthropic' | 'chatgpt',
  url: string,
  headers: Record<string, string>,
  parse: (body: unknown) => UsageWindow[] | null,
  fetchImpl: FetchImpl
): Promise<UsageFetchResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
  let status: number | undefined;
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    status = res.status;
    const text = await res.text();
    const durationMs = Date.now() - started;
    debugBus.recordHttp({ service, method: 'GET', url, status, durationMs, ok: res.ok });

    if (status === 401) return { ok: false, error: 'token_expired', tokenExpired: true };
    if (!res.ok) return { ok: false, error: `usage endpoint answered HTTP ${status}` };

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, error: 'usage response was not JSON' };
    }
    const windows = parse(body);
    if (!windows) return { ok: false, error: 'usage response had an unknown shape' };
    return { ok: true, windows };
  } catch (err) {
    const timedOut = controller.signal.aborted;
    debugBus.recordHttp({
      service,
      method: 'GET',
      url,
      status,
      durationMs: Date.now() - started,
      ok: false,
      error: timedOut ? new Error('timed out') : err,
    });
    return {
      ok: false,
      error: timedOut
        ? `usage request timed out after ${USAGE_TIMEOUT_MS / 1000}s`
        : 'usage endpoint could not be reached',
    };
  } finally {
    clearTimeout(timer);
  }
}

export function fetchClaudeUsage(
  accessToken: string,
  fetchImpl: FetchImpl = fetch
): Promise<UsageFetchResult> {
  return getJson(
    'anthropic',
    CLAUDE_USAGE_URL,
    {
      authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      // Same identity quotaProbe.ts sends; keep the two equal.
      'user-agent': 'claude-cli/2.1.280',
      'x-app': 'cli',
      accept: 'application/json',
    },
    parseClaudeUsage,
    fetchImpl
  );
}

export function fetchCodexUsage(
  accessToken: string,
  accountId: string,
  fetchImpl: FetchImpl = fetch
): Promise<UsageFetchResult> {
  return getJson(
    'chatgpt',
    CODEX_USAGE_URL,
    {
      authorization: `Bearer ${accessToken}`,
      'chatgpt-account-id': accountId,
      originator: 'codex_cli_rs',
      'user-agent': 'codex_cli_rs/0.1.0',
      accept: 'application/json',
    },
    (b) => parseCodexUsage(b),
    fetchImpl
  );
}
